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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDS_FILE = path.resolve(__dirname, '../.wechat_creds.json');
const QRCODE_FILE = path.resolve(__dirname, '../qrcode.png');

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const LONG_POLL_TIMEOUT = 35000;

export class ILinkBot {
    constructor() {
        this.pluginDir = path.resolve(__dirname, '..');
        this.token = null;
        this.baseUrl = BASE_URL;
        this.running = false;
        this.msgHandler = null;
        this.getUpdatesBuf = '';
        this.retryCount = 0;

        // 网页二维码展示
        this.qrCodeImage = null;   // { buffer, mimeType } | null
        this.loginState = 'idle';  // idle | qr_ready | scaned | logged_in | expired | error
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
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(`${this.baseUrl}${endpoint}`, {
                headers: this.buildHeaders(), signal: controller.signal,
            });
            return await res.json();
        } finally { clearTimeout(t); }
    }

    async apiPost(endpoint, body, timeout = 10000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: this.buildHeaders(),
                body: JSON.stringify({ ...body, base_info: { channel_version: '2.0.0' } }),
                signal: controller.signal,
            });
            return await res.json();
        } finally { clearTimeout(t); }
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ========== 网页二维码 ==========

    getQRCodeImage() {
        return this.qrCodeImage;
    }

    getLoginState() {
        return {
            state: this.loginState,
            running: this.running,
            loggedIn: !!this.token,
            retryCount: this.retryCount,
        };
    }

    // ========== 登录 ==========

    async tryRestoreSession() {
        try {
            if (!fs.existsSync(CREDS_FILE)) { this.loginState = 'qr_ready'; return false; }
            const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
            this.token = creds.token;
            this.baseUrl = creds.baseUrl || BASE_URL;
            this.ilinkBotId = creds.ilinkBotId || '';
            this.getUpdatesBuf = '';
            const resp = await this.apiPost('/ilink/bot/getupdates', { get_updates_buf: '' }, 10000);
            if (resp.ret === -14) {
                console.log('[iLink] 会话过期，需重新登录');
                this.loginState = 'qr_ready';
                return false;
            }
            this.loginState = 'logged_in';
            console.log('[iLink] ✅ 会话恢复成功');
            return true;
        } catch {
            this.loginState = 'qr_ready';
            return false;
        }
    }

    async login(onStatus) {
        this.loginState = 'qr_ready';
        console.log('[iLink] 📱 获取登录二维码...');
        const qrResp = await this.apiGet('/ilink/bot/get_bot_qrcode?bot_type=3');

        // 完整打印响应用于调试
        console.log('[iLink] 完整响应:', JSON.stringify(qrResp, null, 2));

        // qrcodeId 用于轮询状态
        const qrcodeId = qrResp.qrcode || '';

        // 二维码内容：iLink 返回的 qrcode_img_content 是微信可识别的链接，必须用它生成二维码
        const qrContent = qrResp.qrcode_img_content || qrResp.qrcode_url || '';
        this.qrCodeData = qrContent || qrcodeId;

        console.log('\n' + '='.repeat(50));
        console.log('  📱 请用微信扫一扫登录 ClawBot');
        console.log('  网页查看: /api/plugins/st-wechat/qrcode');
        console.log('='.repeat(50));

        // 下载并保存二维码图片（用于网页展示）
        let saved = false;
        try {
            if (qrResp.qrcode_url?.startsWith('http')) {
                const res = await fetch(qrResp.qrcode_url);
                const buf = Buffer.from(await res.arrayBuffer());
                const mime = res.headers.get('content-type') || 'image/png';
                this.qrCodeImage = { buffer: buf, mimeType: mime };
                fs.writeFileSync(QRCODE_FILE, buf);
                console.log(`  二维码已保存: ${QRCODE_FILE}`);
                console.log(`  链接: ${qrResp.qrcode_url}`);
                saved = true;
            } else if (qrResp.qrcode?.startsWith('data:')) {
                const match = qrResp.qrcode.match(/^data:image\/(\w+);base64,(.+)$/);
                if (match) {
                    const buf = Buffer.from(match[2], 'base64');
                    const mime = `image/${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
                    this.qrCodeImage = { buffer: buf, mimeType: mime };
                    fs.writeFileSync(QRCODE_FILE, buf);
                    console.log(`  二维码已保存: ${QRCODE_FILE}`);
                    saved = true;
                }
            }
        } catch (err) {
            console.warn('[iLink] 保存二维码失败:', err.message);
        }

        if (!saved && qrcodeId) {
            console.log(`  二维码标识: ${qrcodeId.slice(0, 80)}${qrcodeId.length > 80 ? '...' : ''}`);
        }

        if (onStatus) onStatus('qrcode', qrResp);

        // 给用户/浏览器留出展示二维码的时间，再开始轮询
        await this.sleep(3000);

        let attempts = 0;
        while (attempts < 240) {  // 240 * 1.5s = 6 分钟
            await this.sleep(1500); attempts++;
            try {
                const status = await this.apiGet(
                    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`
                );
                if (process.env.ST_WECHAT_DEBUG) {
                    console.log('[iLink][debug] status:', status.status, status);
                }
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
                        this.token = status.bot_token;
                        this.baseUrl = status.baseurl || BASE_URL;
                        this.ilinkBotId = status.ilink_bot_id || '';
                        this.saveCredentials();
                        this.loginState = 'logged_in';
                        this.qrCodeImage = null;
                        this.qrCodeData = null;
                        fs.existsSync(QRCODE_FILE) && fs.unlinkSync(QRCODE_FILE);
                        console.log('\n[iLink] ✅ 登录成功！');
                        if (this.ilinkBotId) console.log(`[iLink] bot_id: ${this.ilinkBotId}`);
                        return;
                    case 'expired':
                        this.loginState = 'expired';
                        console.log('\n[iLink] 二维码已过期，10 秒后重新获取...');
                        this.qrCodeImage = null;
                        this.qrCodeData = null;
                        await this.sleep(10000);
                        return this.login(onStatus);
                }
            } catch { /* 忽略轮询错误 */ }
        }
        this.loginState = 'error';
        throw new Error('登录超时(>6分钟)');
    }

    saveCredentials() {
        fs.writeFileSync(CREDS_FILE, JSON.stringify(
            { token: this.token, baseUrl: this.baseUrl, ilinkBotId: this.ilinkBotId }, null, 2
        ));
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
                this.loginState = 'expired';
                fs.existsSync(CREDS_FILE) && fs.unlinkSync(CREDS_FILE);
                this.token = null;
                return false;
            }
            this.getUpdatesBuf = resp.get_updates_buf || this.getUpdatesBuf;
            this.retryCount = 0;
            if (resp.msgs?.length > 0) {
                for (const msg of resp.msgs) await this.handleMessage(msg);
            }
            return true;
        } catch (err) {
            if (err.name === 'AbortError') return true; // 长轮询超时，正常
            this.retryCount++;
            const backoff = Math.min(this.retryCount * 2000, 30000);
            console.error(`[iLink] 轮询错误 (重试 #${this.retryCount}, ${backoff}ms):`, err.message);
            await this.sleep(backoff);
            return true;
        }
    }

    async handleMessage(msg) {
        const textItem = msg.item_list?.find(i => i.type === 1);
        if (!textItem?.text_item?.text) return;

        const userId = msg.from_user_id;
        const text = textItem.text_item.text;
        const contextToken = msg.context_token;

        console.log(`[iLink] 📩 ${userId}: "${text.slice(0, 80)}"`);

        if (this.msgHandler) {
            try {
                const reply = await this.msgHandler(userId, text);

                if (!reply) return;

                // 支持批量返回：数组 → 逐条发送
                const replies = Array.isArray(reply) ? reply : [reply];
                for (const msg of replies) {
                    if (!msg) continue;
                    console.log(`[iLink] 📤 ${msg.slice(0, 60)}...`);
                    await this.sendMessage(userId, msg, contextToken);
                }
            } catch (err) {
                console.error('[iLink] 消息处理失败:', err.message);
                await this.sendMessage(userId, `😵 ${err.message}`, contextToken);
            }
        } else {
            console.warn('[iLink] 没有注册消息处理器');
        }
    }

    async sendMessage(toUser, text, contextToken) {
        const chunks = splitText(text, 2000);
        for (const chunk of chunks) {
            const resp = await this.apiPost('/ilink/bot/sendmessage', {
                msg: {
                    from_user_id: this.ilinkBotId || '',
                    to_user_id: toUser,
                    client_id: crypto.randomUUID(),
                    message_type: 2, message_state: 2,
                    item_list: [{ type: 1, text_item: { text: chunk } }],
                    context_token: contextToken,
                },
            });
            if (resp.ret !== undefined && resp.ret !== 0) {
                console.error('[iLink] sendmessage 失败:', resp);
                throw new Error(resp.err_msg || `发送失败 (ret=${resp.ret})`);
            }
            console.log(`[iLink] 📤 已发送回复给 ${toUser}: "${chunk.slice(0, 40)}..."`);
        }
    }

    async sendTyping(toUser) {
        try {
            const cfg = await this.apiPost('/ilink/bot/getconfig', { user_id: toUser });
            if (cfg.typing_ticket) {
                await this.apiPost('/ilink/bot/sendtyping', {
                    user_id: toUser, status: 1, typing_ticket: cfg.typing_ticket,
                });
            }
        } catch { /* typing 非关键 */ }
    }

    // ========== 主循环 ==========

    async start(msgHandler) {
        this.msgHandler = msgHandler;
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
        this.running = false;
    }
}

function splitText(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let end = i + maxLen;
        if (end < text.length) {
            const lastNL = text.lastIndexOf('\n', end);
            if (lastNL > i + maxLen / 2) end = lastNL;
        }
        chunks.push(text.slice(i, end).trim());
        i = end;
    }
    return chunks;
}
