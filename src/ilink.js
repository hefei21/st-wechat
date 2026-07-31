/**
 * ilink.js - 微信 iLink 协议客户端
 *
 * 微信 ClawBot 的 iLink 协议：扫码登录 → 长轮询 → 消息收发。
 *
 * 生命周期：
 *   Token 有效期：通常持续数天（iLink 服务端决定）
 *   Token 过期 → ret:-14 → 自动清空凭证 → 等待扫码重新登录
 *   酒馆重启 → 尝试凭据文件恢复 → 通常无需重新扫码
 *   active 关闭 → 长轮询循环退出 → 不会自动重连
 *
 * 协议文档: https://www.wechatbot.dev/zh/protocol
 * 基座地址: https://ilinkai.weixin.qq.com
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { createLogger, pseudonymizeId } from './logger.js';
import { InboundEventStore } from './inbound-event-store.js';
import {
    classifyOperationError,
    publicOperationError,
} from './errors.js';

const logger = createLogger('iLink');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_CREDS_FILE = path.resolve(__dirname, '../.wechat_creds.json');

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const LONG_POLL_TIMEOUT = 35000;

export class ILinkHttpError extends Error {
    constructor(type, message, options = {}) {
        super(message, options);
        this.name = 'ILinkHttpError';
        this.type = type;
        this.status = options.status || 0;
        this.retryAfterMs = options.retryAfterMs || 0;
    }

    static fromResponse(response) {
        const status = Number(response?.status) || 0;
        const retryAfterMs = parseRetryAfter(response?.headers?.get?.('retry-after'));
        let type = 'http';
        if (status === 401 || status === 403) type = 'auth';
        else if (status === 429) type = 'rate_limit';
        else if (status >= 500) type = 'server';
        return new ILinkHttpError(type, `iLink HTTP ${status || '错误'}`, {
            status,
            retryAfterMs,
        });
    }
}

export class ILinkBot {
    constructor(options = {}) {
        this.pluginDir = path.resolve(__dirname, '..');
        this.credentialsFile = options.credentialsFile || LEGACY_CREDS_FILE;
        this.legacyCredentialsFile = options.legacyCredentialsFile || LEGACY_CREDS_FILE;
        this.token = null;
        this.baseUrl = BASE_URL;
        this.running = false;
        this.msgHandler = null;
        this.inboundEvents = options.inboundEvents || new InboundEventStore(
            options.runtimeStateFile || null
        );
        this.getUpdatesBuf = this.inboundEvents.cursor;
        this.retryCount = 0;
        this.userContexts = new Map(Object.entries(this.inboundEvents.contexts));
        this.processingTasks = new Set();
        this.processingEventIds = new Set();
        this.outboundQueues = new Map();
        this.typingStates = new Map();
        this.outboundRetryDelays = options.outboundRetryDelays || [250, 1000];
        this.fetchImpl = options.fetch || globalThis.fetch;
        this.metrics = options.metrics || null;
        this.requestControllers = new Set();
        this.sleepTimers = new Set();
        this.stopping = false;
        this.pollRetryWaiter = null;

        this.loginState = 'idle';  // idle | qr_ready | scaned | logged_in | expired | error
        this.connectionState = 'offline'; // offline | checking | online | degraded
        this.lastPollSuccessAt = null;
        this.lastPollErrorType = '';
        this.ilinkBotId = '';      // 登录成功后返回的 bot id，发送消息时需要
    }

    // ========== 请求工具 ==========

    randomWechatUin() {
        const num = crypto.randomInt(0, 0xFFFFFFFF);
        return Buffer.from(String(num)).toString('base64');
    }

    buildHeaders() {
        return {
            'Content-Type': 'application/json',
            'AuthorizationType': 'ilink_bot_token',
            'Authorization': this.token ? `Bearer ${this.token}` : '',
            'X-WECHAT-UIN': this.randomWechatUin(),
        };
    }

    async apiGet(endpoint, timeout = 15000) {
        return this.request(endpoint, { headers: this.buildHeaders() }, timeout);
    }

    async apiPost(endpoint, body, timeout = 10000) {
        return this.request(endpoint, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify({ ...body, base_info: { channel_version: '2.0.0' } }),
        }, timeout);
    }

    async request(endpoint, options, timeout) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        this.requestControllers.add(controller);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
                ...options,
                signal: controller.signal,
            });
            if (!response?.ok) {
                throw ILinkHttpError.fromResponse(response);
            }
            let payload;
            try {
                // iLink 部分成功响应没有标准 JSON Content-Type。以正文是否能安全解析
                // 为准，避免把合法响应误判成代理页；错误日志仍不输出响应正文。
                if (typeof response.text === 'function') {
                    const text = await response.text();
                    payload = JSON.parse(text.replace(/^\uFEFF/, ''));
                } else {
                    payload = await response.json();
                }
            } catch {
                throw new ILinkHttpError('protocol', 'iLink 返回了无法解析的响应');
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                throw new ILinkHttpError('protocol', 'iLink 返回结构无效');
            }
            return payload;
        } catch (error) {
            if (error instanceof ILinkHttpError) throw error;
            if (error?.name === 'AbortError') {
                throw new ILinkHttpError('timeout', 'iLink 请求超时', { cause: error });
            }
            throw new ILinkHttpError('network', 'iLink 网络连接失败', { cause: error });
        } finally {
            clearTimeout(timer);
            this.requestControllers.delete(controller);
        }
    }

    sleep(ms) {
        if (this.stopping) return Promise.resolve();
        return new Promise(resolve => {
            const entry = {
                timer: setTimeout(() => {
                    this.sleepTimers.delete(entry);
                    resolve();
                }, ms),
                resolve,
            };
            this.sleepTimers.add(entry);
        });
    }

    // ========== 网页二维码 ==========

    getLoginState() {
        return {
            state: this.loginState,
            running: this.running,
            loggedIn: !!this.token,
            connected: this.connectionState === 'online',
            connectionState: this.connectionState,
            lastPollSuccessAt: this.lastPollSuccessAt,
            lastPollErrorType: this.lastPollErrorType,
            retryCount: this.retryCount,
        };
    }

    // ========== 登录 ==========

    async tryRestoreSession() {
        try {
            this.migrateLegacyCredentials();
            if (!fs.existsSync(this.credentialsFile)) {
                this.loginState = 'qr_ready';
                return false;
            }
            const creds = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
            if (!creds.token) throw new Error('凭据文件缺少 token');
            this.token = creds.token;
            this.baseUrl = creds.baseUrl || BASE_URL;
            this.ilinkBotId = creds.ilinkBotId || '';
            this.loginState = 'logged_in';
            this.connectionState = 'checking';
            this.lastPollErrorType = '';
            console.log('[iLink] ✅ 已加载会话凭据，主轮询将继续校验');
            return true;
        } catch (error) {
            this.token = null;
            this.baseUrl = BASE_URL;
            this.ilinkBotId = '';
            this.connectionState = 'offline';
            console.warn(`[iLink] 无法恢复本地凭据: ${error.message}`);
            this.loginState = 'qr_ready';
            return false;
        }
    }

    async login(onStatus) {
        while (!this.stopping) {
            this.loginState = 'qr_ready';
            console.log('[iLink] 📱 获取登录二维码...');
            const qrResp = await this.apiGet('/ilink/bot/get_bot_qrcode?bot_type=3');
            logger.debug('二维码响应字段:', Object.keys(qrResp || {}));

            const qrcodeId = qrResp.qrcode || '';
            const qrContent = qrResp.qrcode_img_content || qrResp.qrcode_url || '';
            if (!qrcodeId || !qrContent) {
                throw new ILinkHttpError('protocol', 'iLink 二维码响应缺少必要字段');
            }
            this.qrCodeData = qrContent;

            console.log('\n' + '='.repeat(50));
            console.log('  📱 请用微信扫一扫登录 ClawBot');
            console.log('  请在已认证的 SillyTavern 扩展面板中查看二维码');
            console.log('='.repeat(50));

            if (onStatus) onStatus('qrcode', qrResp);
            await this.sleep(3000);

            let expired = false;
            for (let attempts = 1; attempts <= 240 && !this.stopping; attempts++) {
                await this.sleep(1500);
                try {
                    const status = await this.apiGet(
                        `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`
                    );
                    logger.debug('二维码状态:', status.status, 'attempt:', attempts);
                    if (onStatus) onStatus(status.status, status);

                    switch (status.status) {
                        case 'wait':
                            if (attempts % 5 === 0) process.stdout.write('.');
                            break;
                        case 'scaned':
                            this.loginState = 'scaned';
                            console.log('\n[iLink] 已扫描，请在手机上确认...');
                            break;
                        case 'confirmed':
                            if (!status.bot_token) {
                                throw new ILinkHttpError(
                                    'protocol',
                                    'iLink 登录确认缺少 bot_token'
                                );
                            }
                            this.inboundEvents.clearSession();
                            this.getUpdatesBuf = '';
                            this.userContexts.clear();
                            this.token = status.bot_token;
                            this.baseUrl = status.baseurl || BASE_URL;
                            this.ilinkBotId = status.ilink_bot_id || '';
                            this.saveCredentials();
                            this.loginState = 'logged_in';
                            this.connectionState = 'checking';
                            this.lastPollErrorType = '';
                            this.qrCodeData = null;
                            console.log('\n[iLink] ✅ 登录成功！');
                            return;
                        case 'expired':
                            this.loginState = 'expired';
                            this.qrCodeData = null;
                            expired = true;
                            console.log('\n[iLink] 二维码已过期，10 秒后重新获取...');
                            break;
                        default:
                            throw new ILinkHttpError(
                                'protocol',
                                `未知二维码状态: ${String(status.status || 'empty')}`
                            );
                    }
                    if (expired) break;
                } catch (error) {
                    if (error.type === 'protocol') throw error;
                    logger.warn(
                        '二维码状态轮询失败:',
                        `type=${error.type || 'unknown'}`,
                        `attempt=${attempts}`
                    );
                }
            }
            if (this.stopping) return;
            if (!expired) {
                this.loginState = 'error';
                throw new Error('登录超时(>6分钟)');
            }
            await this.sleep(10000);
        }
    }

    saveCredentials() {
        const directory = path.dirname(this.credentialsFile);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporaryFile = `${this.credentialsFile}.tmp`;
        fs.writeFileSync(
            temporaryFile,
            JSON.stringify(
                { token: this.token, baseUrl: this.baseUrl, ilinkBotId: this.ilinkBotId },
                null,
                2
            ),
            { mode: 0o600 }
        );
        fs.renameSync(temporaryFile, this.credentialsFile);
    }

    migrateLegacyCredentials() {
        if (this.credentialsFile === this.legacyCredentialsFile) return;
        if (fs.existsSync(this.credentialsFile) || !fs.existsSync(this.legacyCredentialsFile)) return;

        const legacy = JSON.parse(fs.readFileSync(this.legacyCredentialsFile, 'utf-8'));
        if (!legacy.token) throw new Error('旧凭据文件缺少 token');
        const directory = path.dirname(this.credentialsFile);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.copyFileSync(this.legacyCredentialsFile, this.credentialsFile);
        fs.chmodSync(this.credentialsFile, 0o600);
        console.log('[iLink] ✅ 已将登录凭据迁移到持久化数据目录');
    }

    removeCredentials() {
        try {
            if (fs.existsSync(this.credentialsFile)) fs.unlinkSync(this.credentialsFile);
        } catch (error) {
            console.warn(`[iLink] 清理过期凭据失败: ${error.message}`);
        }
    }

    invalidateSession() {
        this.loginState = 'expired';
        this.connectionState = 'offline';
        this.lastPollSuccessAt = null;
        this.lastPollErrorType = 'auth';
        this.removeCredentials();
        this.inboundEvents.clearSession();
        this.getUpdatesBuf = '';
        this.userContexts.clear();
        this.token = null;
        this.ilinkBotId = '';
    }

    // ========== 消息收发 ==========

    async poll() {
        try {
            const resp = await this.apiPost(
                '/ilink/bot/getupdates',
                { get_updates_buf: this.getUpdatesBuf },
                LONG_POLL_TIMEOUT + 5000
            );
            // 会话过期 → 需要重新登录
            if (resp.ret === -14) {
                console.log('[iLink] ⚠️ Token 已过期，需要重新扫码登录');
                this.invalidateSession();
                return false;
            }
            if (resp.ret !== undefined && resp.ret !== 0) {
                throw new ILinkHttpError('protocol', `iLink getupdates 失败 (ret=${resp.ret})`);
            }
            if (resp.msgs !== undefined && !Array.isArray(resp.msgs)) {
                throw new ILinkHttpError('protocol', 'iLink getupdates 的 msgs 不是数组');
            }
            if (
                resp.get_updates_buf !== undefined
                && typeof resp.get_updates_buf !== 'string'
            ) {
                throw new ILinkHttpError('protocol', 'iLink getupdates 的游标格式无效');
            }
            const events = [];
            try {
                for (const msg of resp.msgs || []) {
                    const queued = this.inboundEvents.enqueue(msg);
                    if (queued.event) events.push(queued.event);
                }
            } catch (error) {
                for (const event of events) {
                    if (event.status !== 'completed') this.dispatchEvent(event);
                }
                throw error;
            }
            this.getUpdatesBuf = resp.get_updates_buf || this.getUpdatesBuf;
            this.inboundEvents.setCursor(this.getUpdatesBuf);
            this.retryCount = 0;
            this.connectionState = 'online';
            this.lastPollSuccessAt = new Date().toISOString();
            this.lastPollErrorType = '';
            if (events.length > 0) {
                // 游标推进和下一轮 getupdates 不等待 LLM、聊天写入或发送完成。
                for (const event of events) {
                    if (event.status !== 'completed') this.dispatchEvent(event);
                }
            }
            return true;
        } catch (err) {
            if (err.type === 'timeout') {
                // 长轮询本地超时属于正常续轮，但不能单独证明服务端已成功响应。
                return true;
            }
            if (err.type === 'auth') {
                console.log('[iLink] ⚠️ iLink 鉴权失效，需要重新扫码登录');
                this.invalidateSession();
                return false;
            }
            this.retryCount++;
            this.connectionState = 'degraded';
            this.lastPollErrorType = err.type || 'unknown';
            const backoff = err.retryAfterMs || Math.min(this.retryCount * 2000, 30000);
            console.error(
                `[iLink] 轮询错误 (type=${err.type || 'unknown'}, `
                + `重试 #${this.retryCount}, ${backoff}ms): ${err.message}`
            );
            this.metrics?.error(err.type || 'unknown');
            await this.waitForPollRetry(backoff);
            return true;
        }
    }

    dispatchMessage(msg) {
        const queued = this.inboundEvents.enqueue(msg);
        if (!queued.event || queued.event.status === 'completed') return Promise.resolve();
        return this.dispatchEvent(queued.event);
    }

    dispatchEvent(event) {
        if (this.processingEventIds.has(event.id)) return Promise.resolve();
        this.processingEventIds.add(event.id);
        const startedAt = Date.now();
        this.inboundEvents.mark(event.id, 'processing', {
            stage: 'processing',
            startedAt,
        });
        const task = this.handleMessage({
            from_user_id: event.userId,
            context_token: event.contextToken,
            item_list: event.inputKind === 'text' || !event.inputKind
                ? [{ type: 1, text_item: { text: event.text } }]
                : [],
            unsupported_input_kind: event.inputKind || 'text',
        }, event.id).then(outcome => {
            const durationMs = Date.now() - startedAt;
            this.metrics?.increment(outcome?.failed ? 'messagesFailed' : 'messagesCompleted');
            this.inboundEvents.mark(event.id, 'completed', {
                stage: outcome?.failed ? 'failed' : 'completed',
                durationMs,
                errorType: outcome?.errorType || '',
            });
            console.log(
                `[iLink] 入站任务结束: diagnostic=${event.diagnosticId || 'legacy'}, `
                + `result=${outcome?.failed ? 'failed' : 'completed'}, durationMs=${durationMs}`
            );
        }).catch(error => {
            const durationMs = Date.now() - startedAt;
            const errorType = classifyOperationError(error);
            this.inboundEvents.mark(event.id, 'pending', {
                stage: 'retrying',
                durationMs,
                errorType,
            });
            console.error(
                `[iLink] 异步消息任务失败: diagnostic=${event.diagnosticId || 'legacy'}, `
                + `type=${errorType}`
            );
        });
        this.processingTasks.add(task);
        task.finally(() => {
            this.processingTasks.delete(task);
            this.processingEventIds.delete(event.id);
        });
        return task;
    }

    async handleMessage(msg, operationId = '') {
        const textItem = msg.item_list?.find(i => i.type === 1);
        const userId = msg.from_user_id;
        const text = textItem?.text_item?.text || '';
        const inputKind = text ? 'text' : String(msg.unsupported_input_kind || '');
        if (!userId || !inputKind) return;
        const contextToken = msg.context_token;
        this.metrics?.increment('messagesReceived');
        this.userContexts.set(userId, contextToken);
        this.inboundEvents.setContext(userId, contextToken);

        if (inputKind === 'text') {
            console.log(`[iLink] 📩 ${pseudonymizeId(userId)}: "${text.slice(0, 80)}"`);
        } else {
            console.log(`[iLink] 📩 ${pseudonymizeId(userId)}: [${inputKind}]`);
        }

        if (this.msgHandler || inputKind !== 'text') {
            const restored = operationId ? this.inboundEvents.get(operationId) : null;
            let outbound = restored?.outbound;
            let outcome = restored?.outcome || {};

            if (!Array.isArray(outbound)) {
                let reply;
                let failed = false;
                let errorType = '';
                const shouldType = inputKind === 'text' && !/^[／/]/.test(text.trim());
                const typingStarted = shouldType
                    ? this.beginTyping(userId)
                    : Promise.resolve();
                try {
                    if (inputKind === 'text') {
                        this.inboundEvents.mark(operationId, 'processing', { stage: 'generating' });
                        reply = await this.msgHandler(userId, text, contextToken, {
                            operationId,
                            diagnosticId: restored?.diagnosticId || '',
                        });
                    } else {
                        this.inboundEvents.mark(operationId, 'processing', { stage: 'degraded_input' });
                        reply = unsupportedInputReply(inputKind);
                    }
                } catch (error) {
                    failed = true;
                    errorType = classifyOperationError(error);
                    const safe = publicOperationError(error, restored?.diagnosticId);
                    reply = `😵 ${safe.message}`;
                    console.error(
                        `[iLink] 消息处理失败: diagnostic=${safe.diagnosticId}, type=${safe.type}`
                    );
                } finally {
                    if (shouldType) {
                        await typingStarted.catch(() => undefined);
                        await this.endTyping(userId);
                    }
                }

                const replies = (Array.isArray(reply) ? reply : [reply]).filter(Boolean);
                outbound = replies.map(item => ({
                    text: String(item),
                    clientIds: splitText(String(item), 2000).map(() => crypto.randomUUID()),
                }));
                outcome = { failed, errorType };
                this.inboundEvents.setOutbound(operationId, outbound, outcome);
            }

            if (outbound.length === 0) return outcome;
            this.inboundEvents.mark(operationId, 'processing', { stage: 'sending' });
            for (const item of outbound) {
                console.log(`[iLink] 📤 ${item.text.slice(0, 60)}...`);
                await this.sendMessage(userId, item.text, contextToken, {
                    clientIds: item.clientIds,
                });
            }
            return outcome;
        } else {
            console.warn('[iLink] 没有注册消息处理器');
        }
    }

    async sendMessage(toUser, text, contextToken, options = {}) {
        const outbound = {
            id: crypto.randomUUID(),
            toUser,
            text,
            contextToken,
            attempts: 0,
            clientIds: Array.isArray(options.clientIds)
                ? options.clientIds
                : splitText(text, 2000).map(() => crypto.randomUUID()),
        };
        return this.enqueueOutbound(toUser, () => this.sendOutbound(outbound));
    }

    enqueueOutbound(toUser, operation) {
        const previous = this.outboundQueues.get(toUser) || Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.outboundQueues.set(toUser, current);
        return current.finally(() => {
            if (this.outboundQueues.get(toUser) === current) this.outboundQueues.delete(toUser);
        });
    }

    async sendOutbound(outbound) {
        const maximumAttempts = this.outboundRetryDelays.length + 1;
        const startedAt = Date.now();
        while (outbound.attempts < maximumAttempts) {
            outbound.attempts += 1;
            try {
                await this.sendMessageNow(
                    outbound.toUser,
                    outbound.text,
                    outbound.contextToken,
                    outbound.clientIds
                );
                console.log(
                    `[iLink] 出站任务完成: diagnostic=${outbound.id.slice(0, 8)}, `
                    + `attempts=${outbound.attempts}, durationMs=${Date.now() - startedAt}`
                );
                this.metrics?.increment('sendsSucceeded');
                this.metrics?.timing('send', Date.now() - startedAt);
                return;
            } catch (error) {
                if (outbound.attempts >= maximumAttempts) {
                    this.metrics?.increment('sendsFailed');
                    this.metrics?.timing('send', Date.now() - startedAt);
                    this.metrics?.error(classifyOperationError(error));
                    throw error;
                }
                const delay = this.outboundRetryDelays[outbound.attempts - 1];
                console.warn(
                    `[iLink] 出站发送失败，准备重试: attempt=${outbound.attempts}, delayMs=${delay}`
                );
                if (delay > 0) await this.sleep(delay);
            }
        }
    }

    async sendMessageNow(toUser, text, contextToken, clientIds = []) {
        const chunks = splitText(text, 2000);
        for (const [index, chunk] of chunks.entries()) {
            const resp = await this.apiPost('/ilink/bot/sendmessage', {
                msg: {
                    from_user_id: this.ilinkBotId || '',
                    to_user_id: toUser,
                    // 同一出站任务重试时沿用 client_id，让协议服务端可以幂等去重。
                    client_id: clientIds[index] || crypto.randomUUID(),
                    message_type: 2, message_state: 2,
                    item_list: [{ type: 1, text_item: { text: chunk } }],
                    context_token: contextToken,
                },
            });
            if (resp.ret !== undefined && resp.ret !== 0) {
                const error = new Error(`iLink sendmessage 失败 (ret=${resp.ret})`);
                error.code = 'send_failed';
                throw error;
            }
            console.log(
                `[iLink] 📤 已发送回复给 ${pseudonymizeId(toUser)}: `
                + `"${chunk.slice(0, 40)}..."`
            );
        }
    }

    async beginTyping(toUser) {
        const state = this.typingStates.get(toUser) || {
            count: 0,
            ticket: '',
            ticketAt: 0,
            timer: null,
        };
        state.count += 1;
        this.typingStates.set(toUser, state);
        if (state.count > 1) return;
        try {
            if (!state.ticket || Date.now() - state.ticketAt > 23 * 60 * 60 * 1000) {
                const cfg = await this.apiPost('/ilink/bot/getconfig', { user_id: toUser });
                state.ticket = cfg.typing_ticket || '';
                state.ticketAt = state.ticket ? Date.now() : 0;
            }
            if (!state.ticket) return;
            await this.sendTypingStatus(toUser, state.ticket, 1);
            state.timer = setInterval(() => {
                this.sendTypingStatus(toUser, state.ticket, 1).catch(() => undefined);
            }, 5000);
            state.timer.unref?.();
        } catch {
            state.ticket = '';
            state.ticketAt = 0;
        }
    }

    async endTyping(toUser) {
        const state = this.typingStates.get(toUser);
        if (!state) return;
        state.count = Math.max(0, state.count - 1);
        if (state.count > 0) return;
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        try {
            if (state.ticket) await this.sendTypingStatus(toUser, state.ticket, 2);
        } catch { /* typing 非关键 */ }
    }

    async sendTypingStatus(toUser, ticket, status) {
        await this.apiPost('/ilink/bot/sendtyping', {
            user_id: toUser,
            status,
            typing_ticket: ticket,
        });
    }

    async sendProactive(toUser, text) {
        const contextToken = this.userContexts.get(toUser);
        if (!contextToken) return false;
        await this.sendMessage(toUser, text, contextToken);
        return true;
    }

    getOperationStatus(userId, excludeOperationId = '') {
        return this.inboundEvents.latestForUser(userId, excludeOperationId);
    }

    waitForPollRetry(ms) {
        if (this.stopping) return Promise.resolve();
        return new Promise(resolve => {
            const waiter = {
                timer: setTimeout(() => {
                    if (this.pollRetryWaiter === waiter) this.pollRetryWaiter = null;
                    resolve();
                }, ms),
                resolve,
            };
            this.pollRetryWaiter = waiter;
        });
    }

    retryNow() {
        const waiter = this.pollRetryWaiter;
        if (!waiter) return false;
        clearTimeout(waiter.timer);
        this.pollRetryWaiter = null;
        waiter.resolve();
        return true;
    }

    // ========== 主循环 ==========

    async start(msgHandler) {
        this.msgHandler = msgHandler;
        this.stopping = false;
        this.running = true;

        const restored = await this.tryRestoreSession();
        if (!restored) {
            try {
                await this.login(() => {});
            } catch (err) {
                console.error('[iLink] 登录失败:', err.message);
                this.running = false;
                return;
            }
        }

        console.log('[iLink] 🤖 Bot 已启动\n');
        for (const event of this.inboundEvents.pending()) this.dispatchEvent(event);
        while (this.running) {
            const ok = await this.poll();
            if (!ok) {
                // 会话过期，自动重新登录
                try {
                    await this.login(() => {});
                } catch (err) {
                    console.error('[iLink] 重新登录失败:', err.message);
                    await this.sleep(30000);
                }
                continue;
            }
        }
    }

    async stop() {
        console.log('[iLink] 正在停止...');
        this.stopping = true;
        this.running = false;
        this.connectionState = 'offline';
        if (this.pollRetryWaiter) {
            clearTimeout(this.pollRetryWaiter.timer);
            this.pollRetryWaiter.resolve();
            this.pollRetryWaiter = null;
        }
        for (const state of this.typingStates.values()) {
            if (state.timer) clearInterval(state.timer);
        }
        this.typingStates.clear();
        for (const controller of this.requestControllers) controller.abort();
        for (const entry of this.sleepTimers) {
            clearTimeout(entry.timer);
            entry.resolve();
        }
        this.sleepTimers.clear();
        await settleWithTimeout([
            ...this.processingTasks,
            ...this.outboundQueues.values(),
        ], 10000);
        this.inboundEvents.close();
    }
}

export function splitText(text, maxLen) {
    const input = String(text || '');
    if (input.length <= maxLen) return [input];
    const chunks = [];
    const fencedPattern = /```[^\n]*\n[\s\S]*?```/g;
    let cursor = 0;
    for (const match of input.matchAll(fencedPattern)) {
        appendPlainChunks(chunks, input.slice(cursor, match.index), maxLen);
        appendCodeChunks(chunks, match[0], maxLen);
        cursor = match.index + match[0].length;
    }
    appendPlainChunks(chunks, input.slice(cursor), maxLen);
    return chunks.filter(Boolean);
}

function unsupportedInputReply(inputKind) {
    switch (inputKind) {
        case 'image':
            return '🖼️ 当前版本暂不支持图片输入。图片未被下载、未写入聊天，也不会发送给模型；请改用文字描述图片内容。';
        case 'voice':
            return '🎙️ 当前版本暂不支持语音输入。语音未被下载、未写入聊天，也不会发送给模型；请改用文字发送。';
        case 'video':
            return '🎞️ 当前版本暂不支持视频输入。视频未被下载、未写入聊天，也不会发送给模型；请改用文字描述。';
        case 'file':
            return '📎 当前版本暂不支持文件输入。文件未被下载、未写入聊天，也不会发送给模型；请将必要内容复制为文字。';
        default:
            return 'ℹ️ 当前版本暂不支持这类非文本消息。内容未被下载、未写入聊天，也不会发送给模型；请改用文字发送。';
    }
}

function appendPlainChunks(output, text, maxLen) {
    let remaining = String(text || '').trim();
    while (remaining.length > maxLen) {
        const end = findNaturalBoundary(remaining, maxLen);
        output.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
    }
    if (remaining) appendPacked(output, remaining, maxLen);
}

function appendCodeChunks(output, block, maxLen) {
    if (block.length <= maxLen) {
        output.push(block);
        return;
    }
    const firstBreak = block.indexOf('\n');
    const opener = firstBreak >= 0 ? block.slice(0, firstBreak) : '```';
    const body = block.slice(firstBreak + 1, -3).trim();
    const allowance = Math.max(1, maxLen - opener.length - 8);
    const pieces = [];
    appendPlainChunks(pieces, body, allowance);
    for (const piece of pieces) output.push(`${opener}\n${piece}\n\`\`\``);
}

function appendPacked(output, value, maxLen) {
    const previous = output.at(-1);
    if (previous && previous.length + value.length <= maxLen && !previous.endsWith('```')) {
        output[output.length - 1] = `${previous}${value}`;
    } else {
        output.push(value);
    }
}

function findNaturalBoundary(text, maxLen) {
    const minimum = Math.floor(maxLen * 0.4);
    const window = text.slice(0, maxLen + 1);
    const candidates = [
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        lastMatchEnd(window, /[。！？.!?；;]\s*/g),
        lastMatchEnd(window, /[，,]\s*/g),
        lastMatchEnd(window, /\s+/g),
    ];
    return candidates.find(index => index >= minimum && index <= maxLen) || maxLen;
}

function lastMatchEnd(text, pattern) {
    let end = -1;
    for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
    return end;
}

function parseRetryAfter(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

async function settleWithTimeout(promises, timeoutMs) {
    if (promises.length === 0) return;
    let timer;
    await Promise.race([
        Promise.allSettled(promises),
        new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        }),
    ]);
    if (timer) clearTimeout(timer);
}
