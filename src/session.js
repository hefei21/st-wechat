/**
 * session.js - 用户会话管理 + 命令路由
 *
 * 每个微信用户 = 一组角色会话：
 *   user["wx_xxx"] = {
 *     current: "Alice",               ← 当前角色
 *     chars: {
 *       "Alice": { chatPath, history, summary, alternatives, swipeIndex },
 *       "Bob":   { chatPath, history, summary, alternatives, swipeIndex },
 *     }
 *   }
 *
 * 切换角色时：保留旧角色状态，恢复到目标角色的上次对话进度。
 */
import path from 'node:path';
import fs from 'node:fs';
import { getCharacters, generate, setSummary } from './adapter.js';
import { ChatStore } from './chat-store.js';
import { ChatRegistry } from './chat-registry.js';
import { ChatCoordinator } from './chat-coordinator.js';
import { ChatTracker } from './chat-tracker.js';
import { SyncEventStore } from './sync-event-store.js';
import { load } from './config.js';
import { classifyOperationError } from './errors.js';
import { formatBrowserSyncBatches, formatSwitchHistory } from './wechat-projection.js';

export class SessionManager {
    constructor(options = {}) {
        const cfg = options.config || load();
        this.sessions = new Map();
        this.chatStore = options.chatStore || new ChatStore(cfg.chatsDir);
        this.registry = options.registry || new ChatRegistry(
            path.join(cfg.dataRoot, 'st-wechat', 'chat-registry.json'),
            cfg.chatsDir
        );
        this.coordinator = options.coordinator || new ChatCoordinator();
        this.tracker = options.tracker || new ChatTracker();
        this.syncEvents = options.syncEvents || new SyncEventStore(
            path.join(cfg.dataRoot, 'st-wechat', 'sync-events.json'),
            cfg.chatsDir
        );
        this.ownerStore = options.ownerStore || null;
        this.characterProvider = options.characterProvider || getCharacters;
        this.generator = options.generator || generate;
        this.notifier = options.notifier || null;
        this.runtimeStatusProvider = options.runtimeStatusProvider || null;
        this.metrics = options.metrics || null;
        this.syncMode = cfg.syncMode || 'notify';
        this.activeOwnerId = null;
        this.pendingSync = this.syncEvents.listBrowserNotifications().map(event => ({
            ...event,
            eventId: event.id,
        }));
        this.pendingSyncByChat = new Map();
        this.userQueues = new Map();
        this.userQueueDepth = new Map();
        this.activeGenerations = new Map();
        this.maxQueuedMessages = options.maxQueuedMessages
            ?? cfg.maxQueuedMessages
            ?? 20;
        this.notificationDelayMs = options.notificationDelayMs ?? 1500;
        this.notificationTimer = null;
        this.activeMessageHandlers = 0;
        this.cleanupTimer = setInterval(() => this.cleanup(), 600000);
        this.cleanupTimer.unref?.();
    }

    setNotifier(notifier) {
        this.notifier = notifier;
    }

    setRuntimeStatusProvider(provider) {
        this.runtimeStatusProvider = provider;
    }

    resetOwnerRuntime() {
        this.activeOwnerId = null;
        this.sessions.clear();
        this.pendingSync = [];
        this.pendingSyncByChat.clear();
        this.syncEvents.clear();
        this.userQueues.clear();
        this.userQueueDepth.clear();
        for (const controller of this.activeGenerations.values()) controller.abort();
        this.activeGenerations.clear();
        this.activeMessageHandlers = 0;
        if (this.notificationTimer) clearTimeout(this.notificationTimer);
        this.notificationTimer = null;
    }

    observeChat(chatPath, details = {}) {
        const checkpoint = this.registry.getChatState(chatPath);
        const update = this.tracker.observe(chatPath, checkpoint);
        this.registry.touchChat(chatPath, {
            revision: update.revision,
            cursor: update.cursor,
            lastMessageFingerprint: update.lastMessageFingerprint,
            ...details,
        });
        return update;
    }

    async observeChatAsync(chatPath, details = {}) {
        const checkpoint = this.registry.getChatState(chatPath);
        const update = await this.tracker.observeAsync(chatPath, checkpoint);
        this.registry.touchChat(chatPath, {
            revision: update.revision,
            cursor: update.cursor,
            lastMessageFingerprint: update.lastMessageFingerprint,
            ...details,
        });
        return update;
    }

    generateInChat(cs, userId, type, message, extra = {}, options = {}) {
        const queuedAt = Date.now();
        return this.coordinator.run(cs.chatPath, async ({ prepareWrite }) => {
            const startedAt = Date.now();
            let generationAttempted = false;
            console.log(`[Session] 生成事务开始: type=${type}, queueWaitMs=${startedAt - queuedAt}`);
            try {
                this.observeChat(cs.chatPath);
                if (type === 'chat' && options.operationId) {
                    const completed = this.chatStore.findOperationResult(
                        cs.chatPath,
                        options.operationId
                    );
                    if (completed) {
                        if (options.replayState) options.replayState.replayed = true;
                        console.log('[Session] 入站事件已提交，复用现有回复');
                        return completed;
                    }
                }
                if (type === 'chat') {
                    const committed = this.chatStore.parse(cs.chatPath);
                    if (committed.messages.at(-1)?.role === 'user') {
                        cs.history = committed.messages;
                        cs.summary = committed.summary;
                        cs.lastWritten = committed.messages.length;
                        throw new IncompleteBrowserTurnError();
                    }
                }
                generationAttempted = true;
                this.metrics?.increment('generationsStarted');
                const reply = await this.withActiveGeneration(userId, signal => this.generator(
                    cs,
                    userId,
                    cs.characterId,
                    message,
                    type,
                    extra,
                    {
                        ...options,
                        beforeWrite: prepareWrite,
                        signal,
                        onUsage: usage => this.metrics?.usage(usage),
                    }
                ));
                const update = this.observeChat(cs.chatPath, { source: 'wechat' });
                if (update.addedMessages.length > 0) {
                    this.queueWechatBrowserUpdate(cs.chatPath, update.addedMessages, update.revision);
                }
                this.metrics?.increment('generationsSucceeded');
                return reply;
            } catch (error) {
                if (generationAttempted) {
                    this.metrics?.increment('generationsFailed');
                    this.metrics?.error(classifyOperationError(error), error?.diagnosticId);
                }
                throw error;
            } finally {
                if (generationAttempted) this.metrics?.timing('generation', Date.now() - startedAt);
                console.log(`[Session] 生成事务结束: type=${type}, durationMs=${Date.now() - startedAt}`);
            }
        });
    }

    async withActiveGeneration(userId, operation) {
        const controller = new AbortController();
        this.activeGenerations.set(userId, controller);
        try {
            return await operation(controller.signal);
        } finally {
            if (this.activeGenerations.get(userId) === controller) {
                this.activeGenerations.delete(userId);
            }
        }
    }

    /**
     * 获取用户数据容器
     */
    getUser(userId) {
        if (!this.sessions.has(userId)) {
            this.sessions.set(userId, {
                current: this.registry.state.botCurrentCharacterId,
                chars: {},
                lastActive: Date.now(),
            });
        }
        return this.sessions.get(userId);
    }

    /**
     * 获取当前角色会话（不存在返回 null）
     */
    getCharSession(userId) {
        const user = this.getUser(userId);
        if (!user.current || !user.chars[user.current]) return null;
        return user.chars[user.current];
    }

    getCharName(userId) {
        return this.getCharSession(userId)?.characterName || null;
    }

    /**
     * 确保当前角色会话存在（自动创建）
     */
    ensureCharSession(userId) {
        const user = this.getUser(userId);
        if (!user.current) return null;
        if (!user.chars[user.current]) {
            const character = this.characterProvider().find(item => item.id === user.current);
            if (!character) return null;
            const saved = this.registry.getBotSelection(character.id);
            let chat = null;
            if (saved?.chatPath && fs.existsSync(saved.chatPath)) {
                try { chat = this.chatStore.parse(saved.chatPath); } catch {}
            }
            if (!chat) {
                try { chat = this.chatStore.findLatestAny(characterChatDirectory(character)); } catch {}
            }
            user.chars[user.current] = {
                characterId: character.id,
                characterName: character.name,
                chatDirectory: characterChatDirectory(character),
                chatPath: null,
                history: [],
                summary: '',
                alternatives: [],
                swipeIndex: 0,
            };
            if (chat) {
                user.chars[user.current].chatPath = chat.path;
                user.chars[user.current].history = chat.messages;
                user.chars[user.current].summary = chat.summary;
                user.chars[user.current].lastWritten = chat.messages.length;
                restoreSwipeState(user.chars[user.current], chat.messages);
                this.registry.setBotSelection(character.id, chat.path);
            }
        }
        return user.chars[user.current];
    }

    /**
     * 当前 Bot 会话可能在浏览器端被删除。使用前重新确认文件存在：
     * 优先切换到该角色最近仍存在的共享聊天；完全没有聊天时才新建。
     */
    async ensureActiveChat(userId) {
        const cs = this.ensureCharSession(userId);
        if (!cs) return { session: null, recoveryNotice: '' };
        if (cs.chatPath && fs.existsSync(cs.chatPath)) {
            return { session: cs, recoveryNotice: '' };
        }

        const character = this.characterProvider().find(item => item.id === cs.characterId);
        if (!character) {
            const user = this.getUser(userId);
            user.current = null;
            return {
                session: null,
                recoveryNotice: '⚠️ 当前角色已不存在，请发送 /list 重新选择角色。',
            };
        }

        let chat = this.chatStore.findLatestAny(cs.chatDirectory);
        let created = false;
        if (!chat) {
            chat = this.chatStore.createShared(cs.chatDirectory, character.name);
            const greeting = character.data.first_mes || `你好！我是${character.name}，很高兴认识你～`;
            await this.chatStore.appendExchangeQueued(
                chat.path,
                [{ role: 'assistant', content: greeting }],
                character.name
            );
            chat = this.chatStore.parse(chat.path);
            created = true;
        }

        cs.chatPath = chat.path;
        cs.history = chat.messages;
        cs.summary = chat.summary;
        cs.lastWritten = chat.messages.length;
        restoreSwipeState(cs, chat.messages);
        this.registry.setBotSelection(character.id, chat.path);

        return {
            session: cs,
            recoveryNotice: created
                ? '⚠️ 原聊天已被删除，且没有其他聊天；已创建一个新聊天。'
                : `⚠️ 原聊天已被删除，已切换到最近仍存在的聊天：${path.basename(chat.path)}`,
        };
    }

    cleanup() {
        const now = Date.now();
        for (const [uid, u] of this.sessions) {
            if (now - u.lastActive > 3600000) {
                this.sessions.delete(uid);
            }
        }
        this.tracker.pruneOlderThan(now - 3600000);
        this.coordinator.pruneExpired(now);
    }

    // ========== 入口 ==========

    async handle(userId, text, metadata = {}) {
        const rawText = String(text || '').trim();
        if (this.ownerStore && !this.ownerStore.isOwner(userId)) {
            const claimMatch = rawText.match(/^[／/]claim\s+(\d{6})$/i);
            if (claimMatch && this.ownerStore.claim(userId, claimMatch[1])) {
                return '✅ 已认领为 Bot 所有者。发送 /list 开始使用。';
            }
            return this.ownerStore.isClaimed()
                ? '⛔ 当前微信账号未获授权。'
                : '🔐 Bot 尚未认领。请在酒馆的 ST WeChat Bot 面板查看验证码，然后发送 /claim 六位验证码。';
        }
        const cleanText = rawText.replace(/^@[^\s]+\s*/, '').replace(/^[\s\u3000]+/, '');
        if (isImmediateCommand(cleanText)) {
            return this.handleAuthorized(userId, cleanText, text, metadata);
        }
        return this.enqueueUserTask(
            userId,
            () => this.handleAuthorized(userId, cleanText, text, metadata)
        );
    }

    enqueueUserTask(userId, task) {
        const depth = this.userQueueDepth.get(userId) || 0;
        if (depth >= this.maxQueuedMessages) {
            return Promise.reject(new QueueOverloadedError(this.maxQueuedMessages));
        }
        this.userQueueDepth.set(userId, depth + 1);
        const previous = this.userQueues.get(userId) || Promise.resolve();
        const current = previous.catch(() => undefined).then(task);
        this.userQueues.set(userId, current);
        return current.finally(() => {
            if (this.userQueues.get(userId) === current) this.userQueues.delete(userId);
            const remaining = Math.max(0, (this.userQueueDepth.get(userId) || 1) - 1);
            if (remaining === 0) this.userQueueDepth.delete(userId);
            else this.userQueueDepth.set(userId, remaining);
        });
    }

    async handleAuthorized(userId, cleanText, rawText = cleanText, metadata = {}) {
        this.activeOwnerId = userId;
        const user = this.getUser(userId);
        user.lastActive = Date.now();
        this.activeMessageHandlers += 1;

        try {
            console.log(`[Session] 收到消息: "${cleanText.slice(0, 80)}" (raw: "${String(rawText).slice(0, 80)}")`);

            const reply = cleanText.startsWith('/') || cleanText.startsWith('／')
                ? await this.handleCommand(userId, cleanText, metadata)
                : await this.handleChat(userId, cleanText, metadata);
            return reply;
        } finally {
            this.activeMessageHandlers = Math.max(0, this.activeMessageHandlers - 1);
            if (this.pendingSync.length > 0) this.scheduleBrowserNotification();
        }
    }

    async handleCommand(userId, text, metadata = {}) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase().replace(/^／/, '/');
        const arg = parts.slice(1).join(' ');

        console.log(`[Session] 执行命令: ${cmd}, 参数: "${arg.slice(0, 80)}"`);

        switch (cmd) {
            // 角色管理
            case '/list':     return this.cmdList(arg);
            case '/switch':   return this.cmdSwitch(userId, arg);
            case '/whoami':   return this.cmdWhoami(userId, metadata.operationId);
            case '/status':   return this.cmdWhoami(userId, metadata.operationId);
            case '/new':      return this.cmdNew(userId);
            case '/chats':    return this.cmdChats(userId);
            case '/chat':     return this.cmdChat(userId, arg);
            case '/sync':     return this.cmdSync();
            case '/stop':     return this.cmdStop(userId);
            // 对话控制
            case '/continue': case '/cont': case '/gen': return this.cmdContinue(userId, arg);
            case '/retry':    case '/r':     return this.cmdRetry(userId);
            case '/swipe':    return this.cmdSwipe(userId);

            // 记忆
            case '/memory':   case '/mem':   return arg
                ? this.cmdSetMemory(userId, arg)
                : this.cmdGetMemory(userId);
            case '/getmem':   return this.cmdGetMemory(userId);

            // 系统
            case '/help':     return this.cmdHelp(arg);

        default:
            return `未知命令: ${cmd}。发送 /help 查看可用命令`;
        }
    }

    // ========== 角色管理 ==========

    cmdList(value = '') {
        const chars = this.characterProvider();
        if (chars.length === 0) return '📭 暂无可用的角色卡';
        const pageSize = 10;
        const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
        let page = 1;
        if (parts.length > 0 && /^\d+$/.test(parts.at(-1))) {
            page = Math.max(1, Number.parseInt(parts.pop(), 10));
        }
        const keyword = parts.join(' ').toLowerCase();
        const matches = chars
            .map((character, index) => ({ character, index }))
            .filter(({ character }) => !keyword || [
                character.name,
                character.id,
                path.basename(character.file),
                path.basename(character.file, path.extname(character.file)),
            ].some(field => String(field || '').toLowerCase().includes(keyword)));
        if (matches.length === 0) return `📭 没有找到包含“${parts.join(' ')}”的角色`;
        const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
        if (page > pageCount) return `页码超出范围，共 ${pageCount} 页`;
        const selected = matches.slice((page - 1) * pageSize, page * pageSize);
        const counts = new Map();
        for (const character of chars) counts.set(character.name, (counts.get(character.name) || 0) + 1);
        const title = keyword ? `📋 搜索“${parts.join(' ')}”` : '📋 可用角色';
        return `${title}（第 ${page}/${pageCount} 页，共 ${matches.length} 个）：\n` + selected.map(({ character, index }) => {
            const suffix = counts.get(character.name) > 1
                ? ` [${path.basename(character.file, path.extname(character.file))}]`
                : '';
            return `  ${index + 1}. ${character.name}${suffix}`;
        }).join('\n')
            + '\n\n发送 /switch 序号 或 /switch 角色名 来切换'
            + (pageCount > 1 ? `\n翻页：/list ${keyword ? `${parts.join(' ')} ` : ''}${Math.min(page + 1, pageCount)}` : '');
    }

    /**
     * /switch 序号|名称
     * 支持：/switch 1  /switch Alice  /switch ali  (模糊匹配只靠前缀)
     */
    async cmdSwitch(userId, charName) {
        if (!charName) return '请指定角色名或序号，如 /switch 1 或 /switch Alice';

        const characters = this.characterProvider();
        const character = resolveCharacter(characters, charName);
        if (!character) {
            return `未找到角色 "${charName}"。发送 /list 查看可用角色`;
        }

        const user = this.getUser(userId);

        // 如果目标角色已有会话，恢复它
        if (user.chars[character.id]?.chatPath) {
            user.current = character.id;
            const cs = user.chars[character.id];
            if (!fs.existsSync(cs.chatPath)) {
                const recovered = await this.ensureActiveChat(userId);
                if (!recovered.session) return recovered.recoveryNotice;
                return recovered.recoveryNotice;
            }
            const refreshed = this.chatStore.parse(cs.chatPath);
            cs.history = refreshed.messages;
            cs.summary = refreshed.summary;
            cs.lastWritten = refreshed.messages.length;
            restoreSwipeState(cs, refreshed.messages);
            this.registry.setBotSelection(character.id, cs.chatPath);
            const historyInfo = cs.history.length > 0
                ? `\n📜 已恢复 ${countUserTurns(cs.history)} 轮对话`
                : '';
            const memInfo = cs.summary
                ? `\n📝 记忆: ${cs.summary.slice(0, 80)}${cs.summary.length > 80 ? '...' : ''}`
                : '';
            return `✅ 已切换到 ${character.name}（恢复上次进度）${historyInfo}${memInfo}`;
        }

        user.current = character.id;
        const cs = this.ensureCharSession(userId);
        let chat = cs.chatPath ? this.chatStore.parse(cs.chatPath) : null;
        if (!chat) chat = this.chatStore.findLatestAny(cs.chatDirectory);
        if (!chat) chat = this.chatStore.createShared(cs.chatDirectory, character.name);
        cs.chatPath = chat.path;
        this.registry.setBotSelection(character.id, chat.path);

        if (chat.summary) cs.summary = chat.summary;
        if (chat.messages.length > 0) {
            cs.history = chat.messages;
            cs.lastWritten = chat.messages.length;
            restoreSwipeState(cs, chat.messages);
            return formatSwitchHistory(character.name, chat.messages);
        }

        const greeting = character.data.first_mes || `你好！我是${character.name}，很高兴认识你～`;
        await this.chatStore.appendExchangeQueued(
            cs.chatPath,
            [{ role: 'assistant', content: greeting }],
            character.name
        );
        cs.history.push({ role: 'assistant', content: greeting });
        cs.lastWritten = 1;
        return `✅ 已切换到 ${character.name}\n\n${character.name}: ${greeting}`;
    }

    async reportBrowserState({ characterRef, chatId, event, operationId }) {
        const character = resolveCharacter(this.characterProvider(), characterRef);
        if (!character) throw new Error('无法识别浏览器当前角色');
        const chatPath = this.chatStore.resolveChatPathById(characterChatDirectory(character), chatId);
        if (!chatPath) throw new Error('无法识别浏览器当前聊天');

        this.registry.setBrowserSelection(character.id, chatPath);
        let lease = null;
        // Establish the browser lease before any asynchronous file observation.
        // Otherwise an inbound Bot request can pass waitForLease while this
        // request is still reading the chat state.
        if (event === 'generation-started') {
            lease = this.coordinator.acquireLease(chatPath, operationId);
        } else if (event === 'generation-renew') {
            lease = this.coordinator.renewLease(chatPath, operationId);
        }
        if (this.coordinator.isActive(chatPath)) {
            const checkpoint = this.registry.getChatState(chatPath);
            return {
                characterId: character.id,
                revision: checkpoint?.revision || '',
                reset: false,
                sameCurrent: this.registry.isSameCurrentChat(character.id),
                lease,
                deferred: true,
            };
        }
        const update = await this.observeChatAsync(chatPath, {
            lastEvent: event || 'state',
            operationId: operationId || null,
        });
        // SillyTavern saves WeChat increments again after merging them into its
        // in-memory chat. The tracker must consume that file revision, but those
        // marked projection records are not new browser messages and must never
        // be echoed back to WeChat as a browser notification.
        const browserMessages = update.addedMessages.filter(message =>
            !isWechatProjectionMessage(message)
        );
        if (isBrowserMutationEvent(event) && (browserMessages.length > 0 || update.reset)) {
            this.registry.touchChat(chatPath, { source: 'browser' });
        }

        if (event === 'generation-finished' || event === 'generation-stopped') {
            lease = this.coordinator.releaseLease(chatPath, operationId);
        }
        const sameCurrent = this.registry.isSameCurrentChat(character.id);
        if (sameCurrent && (
            browserMessages.length > 0
            || isBrowserCompletionEvent(event)
        )) {
            this.queueBrowserNotification(
                chatPath,
                character.name,
                browserMessages,
                update.reset,
                update.overflow,
                event
            );
        }
        return {
            characterId: character.id,
            revision: update.revision,
            reset: update.reset,
            sameCurrent,
            lease,
        };
    }

    queueBrowserNotification(chatPath, characterName, messages, reset = false, overflow = false, event = '') {
        if (this.syncMode === 'off') return;
        if (reset) {
            this.persistBrowserNotification(chatPath, {
                characterName,
                messages: [],
                reset: true,
                overflow,
            });
        }
        const key = path.resolve(chatPath);
        if (messages.length > 0) {
            const buffered = this.pendingSyncByChat.get(key) || [];
            buffered.push(...messages);
            this.pendingSyncByChat.set(key, buffered);
        }
        const buffered = this.pendingSyncByChat.get(key) || [];
        if (buffered.length > 0) {
            const hasCompletedAssistant = buffered.at(-1)?.role === 'assistant';
            if (!hasCompletedAssistant && !isBrowserCompletionEvent(event)) return;
            let completeMessages = buffered.splice(0);
            if (buffered.length === 0) this.pendingSyncByChat.delete(key);
            if (!completeMessages.some(message => message.role === 'user')) {
                completeMessages = prependAdjacentUserMessage(
                    this.chatStore.parse(chatPath).messages,
                    completeMessages
                );
            }
            this.persistBrowserNotification(chatPath, {
                characterName,
                messages: completeMessages,
                reset: false,
                incomplete: !hasCompletedAssistant,
                event,
            });
        }
        if (this.pendingSync.length === 0) return;
        this.scheduleBrowserNotification();
    }

    persistBrowserNotification(chatPath, batch) {
        const event = this.syncEvents.appendBrowserNotification(chatPath, batch);
        this.pendingSync.push({ ...batch, eventId: event.id });
    }

    scheduleBrowserNotification() {
        if (this.notificationTimer || this.pendingSync.length === 0) return;
        this.notificationTimer = setTimeout(async () => {
            this.notificationTimer = null;
            if (this.notifier && this.activeOwnerId) {
                const batches = this.pendingSync.splice(0);
                const text = formatBrowserSyncBatches(batches, this.syncMode);
                try {
                    const sent = await this.notifier(this.activeOwnerId, text);
                    if (sent === false) throw new Error('缺少可用的微信发送上下文');
                    this.acknowledgeBrowserNotifications(batches);
                } catch (error) {
                    this.pendingSync.unshift(...batches);
                    console.warn(`[Session] 浏览器同步通知失败: ${error.message}`);
                    this.scheduleBrowserNotification();
                }
            }
        }, this.notificationDelayMs);
        this.notificationTimer.unref?.();
    }

    takePendingSyncNotification() {
        if (this.pendingSync.length === 0) return '';
        if (this.notificationTimer) clearTimeout(this.notificationTimer);
        this.notificationTimer = null;
        return this.cmdSync();
    }

    cmdSync() {
        if (this.pendingSync.length === 0) return '✅ 当前聊天没有待同步的浏览器端内容';
        const batches = this.pendingSync.splice(0);
        const text = formatBrowserSyncBatches(batches, this.syncMode);
        this.acknowledgeBrowserNotifications(batches);
        return text;
    }

    acknowledgeBrowserNotifications(batches) {
        const eventIds = batches.map(batch => batch.eventId).filter(Boolean);
        if (eventIds.length > 0) this.syncEvents.acknowledgeBrowserNotifications(eventIds);
    }

    async getBrowserSyncState({ characterRef, chatId, revision }) {
        const character = resolveCharacter(this.characterProvider(), characterRef);
        if (!character) return { changed: false, updates: [] };
        const chatPath = this.chatStore.resolveChatPathById(characterChatDirectory(character), chatId);
        if (!chatPath) return { changed: false, updates: [] };
        const update = await this.observeChatAsync(chatPath, { lastEvent: 'poll' });
        const currentRevision = update.revision;
        this.registry.setBrowserSelection(character.id, chatPath);
        const chatState = this.registry.getChatState(chatPath);
        return {
            changed: String(revision || '') !== currentRevision,
            revision: currentRevision,
            sameCurrent: this.registry.isSameCurrentChat(character.id),
            changeSource: chatState?.source || null,
            updates: this.syncEvents.list(chatPath),
        };
    }

    queueWechatBrowserUpdate(chatPath, messages, revision) {
        this.syncEvents.append(chatPath, messages, revision);
    }

    acknowledgeWechatBrowserUpdates({ characterRef, chatId, updateIds }) {
        const character = resolveCharacter(this.characterProvider(), characterRef);
        if (!character) return { acknowledged: 0 };
        const chatPath = this.chatStore.resolveChatPathById(characterChatDirectory(character), chatId);
        if (!chatPath) return { acknowledged: 0 };
        return {
            acknowledged: this.syncEvents.acknowledge(chatPath, updateIds),
        };
    }

    cmdWhoami(userId, excludeOperationId = '') {
        const user = this.getUser(userId);
        if (!user.current) return '你还没有选择角色。发送 /list 查看可用角色';

        const cs = this.ensureCharSession(userId);
        if (!cs) return '当前角色已不存在，请发送 /list 重新选择角色';
        const roles = Object.keys(user.chars);
        let info = `当前角色：${cs.characterName}\n`;
        info += `对话轮次：${countUserTurns(cs.history || [])}\n`;
        if (cs.chatPath) info += `当前聊天：${path.basename(cs.chatPath)}\n`;

        if (roles.length > 1) {
            info += `已对话过：${roles.map(id => user.chars[id]?.characterName || id).join(', ')}\n`;
        }
        if (cs.summary) {
            info += `记忆：${cs.summary.slice(0, 100)}${cs.summary.length > 100 ? '...' : ''}`;
        }
        const operation = this.runtimeStatusProvider?.(userId, excludeOperationId);
        if (operation) info += `\n${formatOperationStatus(operation)}`;
        return info;
    }

    async cmdNew(userId) {
        const user = this.getUser(userId);
        if (!user.current) return '请先选择角色';
        const character = this.characterProvider().find(item => item.id === user.current);
        if (!character) return '当前角色已不存在，请重新选择';
        const chat = this.chatStore.createShared(characterChatDirectory(character), character.name);
        const cs = this.ensureCharSession(userId);
        cs.chatPath = chat.path;
        cs.history = [];
        cs.summary = '';
        cs.alternatives = [];
        cs.lastWritten = 0;
        this.registry.setBotSelection(character.id, chat.path);
        const greeting = character.data.first_mes || `你好！我是${character.name}，很高兴认识你～`;
        await this.chatStore.appendExchangeQueued(
            chat.path,
            [{ role: 'assistant', content: greeting }],
            character.name
        );
        cs.history.push({ role: 'assistant', content: greeting });
        cs.lastWritten = 1;
        return `✅ 已新建聊天\n\n${character.name}: ${greeting}`;
    }

    cmdChats(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        const chats = this.chatStore.list(cs.chatDirectory);
        if (chats.length === 0) return '📭 当前角色没有聊天记录';
        return '📚 当前角色的聊天：\n' + chats.map((chat, index) => {
            const current = path.resolve(chat.path) === path.resolve(cs.chatPath) ? ' ← 当前' : '';
            return `${index + 1}. ${path.basename(chat.path)}（${chat.messages.length} 条）${current}`;
        }).join('\n') + '\n\n发送 /chat 序号 切换';
    }

    cmdChat(userId, value) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        const chats = this.chatStore.list(cs.chatDirectory);
        const index = Number.parseInt(value, 10) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= chats.length) {
            return '请发送有效序号，例如 /chat 1';
        }
        const chat = chats[index];
        cs.chatPath = chat.path;
        cs.history = chat.messages;
        cs.summary = chat.summary;
        cs.lastWritten = chat.messages.length;
        restoreSwipeState(cs, chat.messages);
        this.registry.setBotSelection(cs.characterId, chat.path);
        return `✅ 已切换聊天（${chat.messages.length} 条消息）`;
    }

    // ========== 续写 ==========

    async cmdContinue(userId, direction) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        const contMsg = direction ? `[续写: ${direction}]` : '[续写: 自动]';
        const reply = await this.generateInChat(cs, userId, 'continue', contMsg, { direction });
        cs.history.push(
            { role: 'user', content: contMsg },
            { role: 'assistant', content: reply }
        );
        return `✍️ 续写：\n\n${reply}`;
    }

    cmdStop(userId) {
        const controller = this.activeGenerations.get(userId);
        if (!controller) return 'ℹ️ 当前没有正在生成的回复';
        controller.abort();
        return '⏹️ 已请求停止当前生成，本轮不会写入聊天记录';
    }

    getRuntimeSnapshot() {
        return {
            queueDepth: [...this.userQueueDepth.values()].reduce((sum, value) => sum + value, 0),
            activeGenerations: this.activeGenerations.size,
            pendingSync: this.pendingSync.length,
        };
    }

    // ========== 重新生成 ==========

    async cmdRetry(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';

        // 跳过命令产生的合成消息（[续写：...], [请继续], [现在你是用户...] 等）
        const isSynthetic = (msg) => msg && msg.startsWith('[');

        const { lastUserMsg, lastUserIdx, lastAssistIdx } = findRetryTarget(cs.history, isSynthetic);
        if (!lastUserMsg) return '没有可重新生成的消息';
        if (lastAssistIdx === -1) return '没有可重新生成的 AI 回复';

        const startedAt = Date.now();
        this.metrics?.increment('generationsStarted');
        let result;
        try {
            result = await this.coordinator.run(cs.chatPath, async ({ assertUnchanged }) => {
                this.observeChat(cs.chatPath);
                const generated = await this.withActiveGeneration(userId, signal => this.generator(
                    { ...cs, history: cs.history.slice(0, lastUserIdx) },
                    userId, cs.characterId, lastUserMsg, 'retry', {}, {
                        noWrite: true,
                        signal,
                        onUsage: usage => this.metrics?.usage(usage),
                    }
                ));
                assertUnchanged();
                const swipe = this.chatStore.replaceLastAssistant(cs.chatPath, generated);
                this.observeChat(cs.chatPath, { source: 'wechat' });
                return { reply: generated, swipe };
            });
            this.metrics?.increment('generationsSucceeded');
        } catch (error) {
            this.metrics?.increment('generationsFailed');
            this.metrics?.error(classifyOperationError(error), error?.diagnosticId);
            throw error;
        } finally {
            this.metrics?.timing('generation', Date.now() - startedAt);
        }
        const { reply, swipe } = result;

        // 更新内存
        cs.history[lastAssistIdx] = { role: 'assistant', content: reply };

        if (swipe) {
            cs.alternatives = swipe.swipes;
            cs.swipeIndex = swipe.swipeId;
        }

        return `🔄 重新生成：\n\n${reply}`;
    }

    // ========== 备选 ==========

    async cmdSwipe(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        if (!cs.alternatives || cs.alternatives.length === 0) return '没有备选回复';
        cs.swipeIndex = (cs.swipeIndex + 1) % cs.alternatives.length;
        const selected = await this.coordinator.run(cs.chatPath, async () =>
            this.chatStore.selectLastAssistantSwipe(cs.chatPath, cs.swipeIndex)
        );
        if (!selected) return '无法切换聊天文件中的备选回复';
        const tracked = this.observeChat(cs.chatPath, { source: 'wechat' });
        const alt = selected.content;
        cs.alternatives = selected.swipes;
        for (let i = cs.history.length - 1; i >= 0; i--) {
            if (cs.history[i].role === 'assistant') {
                cs.history[i].content = alt;
                break;
            }
        }
        return `🔄 备选 ${cs.swipeIndex + 1}/${cs.alternatives.length}：\n\n${alt}`;
    }

    // ========== 记忆 ==========

    async cmdSetMemory(userId, text) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        if (!text) return '请提供记忆内容，如 /memory 主角和Alice在咖啡馆相遇';
        await this.coordinator.run(cs.chatPath, async ({ assertUnchanged }) => {
            assertUnchanged();
            setSummary(cs, text);
            this.observeChat(cs.chatPath, { source: 'wechat' });
        });
        return `✅ 记忆已保存：\n${text}`;
    }

    cmdGetMemory(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        if (!cs.summary) return '📭 暂无记忆。用 /memory 内容 设置';
        return `📝 当前记忆：\n${cs.summary}`;
    }

    // ========== 帮助 ==========

    cmdHelp(section = '') {
        if (String(section).trim().toLowerCase() === 'advanced') {
            return `🧰 高级命令：

  /memory [内容]  查看或设置当前聊天记忆
  /sync           手动查看待同步的浏览器内容

这些命令通常无需日常使用。`;
        }
        return `📖 可用命令：

【角色管理】
  /list [页码/关键词]  浏览或搜索角色
  /switch xx   切换到角色（已有对话会自动恢复）
  /status      查看当前角色、聊天和轮次
  /new         新建当前角色聊天
  /chats       查看当前角色的聊天文件
  /chat 序号   切换 Bot 当前聊天

【对话控制】
  /continue [方向]  续写 AI 回复
  /retry       重新生成上一条回复
  /swipe       查看备选回复
  /stop        停止当前生成

【系统】
  /help         显示本帮助
  /help advanced  显示低频高级命令`;
    }

    // ========== 普通对话 ==========

    async handleChat(userId, text, metadata = {}) {
        let cs = this.ensureCharSession(userId);
        if (!cs) {
            return '👋 欢迎！请先选择角色。\n发送 /list 查看可用角色';
        }
        let recoveryNotice = '';
        if (cs.chatPath && !fs.existsSync(cs.chatPath)) {
            const recovered = await this.ensureActiveChat(userId);
            cs = recovered.session;
            recoveryNotice = recovered.recoveryNotice;
            if (!cs) return recoveryNotice;
            return `${recoveryNotice}\n\n本条消息未发送，请确认当前聊天后重新发送。`;
        } else if (!cs.chatPath) {
            await this.cmdSwitch(userId, cs.characterId);
            cs = this.getCharSession(userId);
            if (!cs?.chatPath) return '⚠️ 当前聊天无法恢复，请发送 /switch 重新选择角色';
        }

        try {
            const replayState = { replayed: false };
            const reply = await this.generateInChat(
                cs,
                userId,
                'chat',
                text,
                {},
                { operationId: metadata.operationId, replayState }
            );
            if (!replayState.replayed) {
                cs.history.push(
                    { role: 'user', content: text },
                    { role: 'assistant', content: reply }
                );
            }
            return reply;
        } catch (err) {
            if (err instanceof IncompleteBrowserTurnError) return err.message;
            throw err;
        }
    }

    close() {
        for (const controller of this.activeGenerations.values()) controller.abort();
        this.activeGenerations.clear();
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
        if (this.notificationTimer) clearTimeout(this.notificationTimer);
        this.notificationTimer = null;
        this.syncEvents?.close();
        this.registry?.close();
    }
}

function resolveCharacter(characters, value) {
    const query = String(value || '').trim();
    const index = Number.parseInt(query, 10);
    if (String(index) === query && index >= 1 && index <= characters.length) {
        return characters[index - 1];
    }
    const lower = query.toLowerCase();
    const exact = characters.filter(character =>
        character.id.toLowerCase() === lower ||
        character.name.toLowerCase() === lower ||
        path.basename(character.file).toLowerCase() === lower ||
        path.basename(character.file, path.extname(character.file)).toLowerCase() === lower
    );
    if (exact.length === 1) return exact[0];
    const prefix = characters.filter(character => character.name.toLowerCase().startsWith(lower));
    return prefix.length === 1 ? prefix[0] : null;
}

function characterChatDirectory(character) {
    return path.basename(character.file, path.extname(character.file));
}

function restoreSwipeState(session, messages) {
    const latest = [...messages].reverse().find(message => message.role === 'assistant');
    const swipes = latest?._raw?.swipes;
    session.alternatives = Array.isArray(swipes) ? [...swipes] : [];
    session.swipeIndex = Number.isInteger(latest?._raw?.swipe_id) ? latest._raw.swipe_id : 0;
}

export function countUserTurns(messages) {
    return messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0);
}

function formatOperationStatus(operation) {
    const labels = {
        received: '已接收',
        pending: '排队中',
        processing: '处理中',
        generating: '模型生成中',
        ready_to_send: '等待发送',
        sending: '回复发送中',
        retrying: '等待重试',
        completed: '已完成',
        failed: '失败',
    };
    const label = labels[operation.stage] || labels[operation.status] || '未知';
    const duration = Number.isFinite(operation.durationMs)
        ? `，耗时 ${operation.durationMs}ms`
        : '';
    const diagnostic = operation.diagnosticId
        ? `，诊断编号 ${operation.diagnosticId}`
        : '';
    const error = operation.errorType ? `，类型 ${operation.errorType}` : '';
    return `最近消息：${label}${duration}${error}${diagnostic}`;
}

function isBrowserMutationEvent(event) {
    return [
        'file-updated',
        'generation-started',
        'generation-finished',
        'generation-stopped',
    ].includes(event);
}

function isBrowserCompletionEvent(event) {
    return event === 'generation-finished' || event === 'generation-stopped';
}

function isWechatProjectionMessage(message) {
    const raw = message?._raw;
    return Boolean(
        raw?.st_wechat_operation_id
        || raw?.extra?.st_wechat_sync_id
    );
}

function isImmediateCommand(text) {
    const command = String(text || '').trim().split(/\s+/, 1)[0].toLowerCase().replace(/^／/, '/');
    return ['/whoami', '/status', '/help', '/list', '/sync', '/getmem', '/stop'].includes(command);
}

function prependAdjacentUserMessage(fileMessages, addedMessages) {
    if (addedMessages.length === 0 || addedMessages[0]?.role !== 'assistant') return addedMessages;
    const target = addedMessages[0];
    for (let index = fileMessages.length - 1; index >= 0; index--) {
        const candidate = fileMessages[index];
        if (
            candidate.role === 'assistant'
            && candidate.content === target.content
            && fileMessages[index - 1]?.role === 'user'
        ) {
            return [fileMessages[index - 1], ...addedMessages];
        }
    }
    return addedMessages;
}

export function findRetryTarget(history, isSynthetic = message => message?.startsWith('[')) {
    let lastAssistIdx = -1;
    for (let index = history.length - 1; index >= 0; index--) {
        if (history[index].role === 'assistant') {
            lastAssistIdx = index;
            break;
        }
    }
    if (lastAssistIdx < 0) return { lastUserMsg: null, lastUserIdx: -1, lastAssistIdx };
    for (let index = lastAssistIdx - 1; index >= 0; index--) {
        const item = history[index];
        if (item.role === 'user' && !isSynthetic(item.content)) {
            return { lastUserMsg: item.content, lastUserIdx: index, lastAssistIdx };
        }
    }
    return { lastUserMsg: null, lastUserIdx: -1, lastAssistIdx };
}

class IncompleteBrowserTurnError extends Error {
    constructor() {
        super(
            '⚠️ 浏览器上一轮没有生成有效正文，当前聊天仍有一条未回答的 user 消息。'
            + '\n\n本条微信消息未发送，也没有调用模型。请先在浏览器重试上一轮，'
            + '确认出现角色正文后再重新发送。'
        );
        this.name = 'IncompleteBrowserTurnError';
    }
}

export class QueueOverloadedError extends Error {
    constructor(limit) {
        super(`当前消息队列已满（最多 ${limit} 条），本条未处理，请稍后重新发送。`);
        this.name = 'QueueOverloadedError';
        this.code = 'queue_overloaded';
    }
}
