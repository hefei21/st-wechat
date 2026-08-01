import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

/**
 * 持久化尚未被浏览器确认的微信聊天增量。
 * JSONL 是共享聊天投影；事件箱保证投影被浏览器晚到保存覆盖后仍可重新合并。
 */
export class SyncEventStore {
    constructor(filePath, chatsDir, options = {}) {
        this.filePath = path.resolve(filePath);
        this.chatsDir = path.resolve(chatsDir);
        this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
        this.maxEvents = options.maxEvents || 200;
        this.state = this.read();
        this.dirty = false;
    }

    append(chatPath, messages, revision = '') {
        const event = {
            id: `wechat-${Date.now()}-${this.randomUUID()}`,
            chatPath: this.toRelative(chatPath),
            revision: String(revision || ''),
            createdAt: Date.now(),
            messages: messages.map(message => ({
                role: message.role,
                content: String(message.content ?? ''),
                name: message.name || message._raw?.name || '',
                _raw: message._raw || null,
            })),
        };
        this.state.events.push(event);
        this.dirty = true;
        this.flush();
        return event;
    }

    appendBrowserNotification(chatPath, batch) {
        const event = {
            id: `browser-${Date.now()}-${this.randomUUID()}`,
            chatPath: this.toRelative(chatPath),
            characterName: String(batch.characterName || ''),
            createdAt: Date.now(),
            messages: normalizeMessages(batch.messages),
            reset: Boolean(batch.reset),
            overflow: Boolean(batch.overflow),
            incomplete: Boolean(batch.incomplete),
            event: String(batch.event || ''),
        };
        this.state.browserNotifications.push(event);
        this.dirty = true;
        this.flush();
        return event;
    }

    listBrowserNotifications() {
        return this.state.browserNotifications.map(event => ({
            ...event,
            messages: normalizeMessages(event.messages),
        }));
    }

    acknowledgeBrowserNotifications(ids) {
        const selected = new Set(Array.isArray(ids) ? ids.map(String) : []);
        const before = this.state.browserNotifications.length;
        this.state.browserNotifications = this.state.browserNotifications.filter(
            event => !selected.has(event.id)
        );
        const acknowledged = before - this.state.browserNotifications.length;
        if (acknowledged > 0) {
            this.dirty = true;
            this.flush();
        }
        return acknowledged;
    }

    list(chatPath) {
        const relative = this.toRelative(chatPath);
        return this.state.events.filter(event => event.chatPath === relative);
    }

    acknowledge(chatPath, updateIds) {
        const relative = this.toRelative(chatPath);
        const ids = new Set(Array.isArray(updateIds) ? updateIds.map(String) : []);
        const before = this.state.events.length;
        this.state.events = this.state.events.filter(event =>
            event.chatPath !== relative || !ids.has(event.id)
        );
        const acknowledged = before - this.state.events.length;
        if (acknowledged > 0) {
            this.dirty = true;
            this.flush();
        }
        return acknowledged;
    }

    clear() {
        this.state = emptyState();
        this.dirty = true;
        this.flush();
    }

    close() {
        if (this.dirty) this.flush();
    }

    read() {
        if (!fs.existsSync(this.filePath)) return emptyState();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed?.version !== VERSION || !Array.isArray(parsed.events)) {
                throw new Error('不支持的同步事件版本');
            }
            return {
                version: VERSION,
                events: parsed.events.filter(event =>
                    typeof event?.id === 'string'
                    && typeof event?.chatPath === 'string'
                    && Array.isArray(event?.messages)
                ),
                browserNotifications: Array.isArray(parsed.browserNotifications)
                    ? parsed.browserNotifications.filter(event =>
                        typeof event?.id === 'string'
                        && typeof event?.chatPath === 'string'
                        && Array.isArray(event?.messages)
                    )
                    : [],
            };
        } catch (error) {
            const backup = `${this.filePath}.invalid-${Date.now()}`;
            try { fs.renameSync(this.filePath, backup); } catch {}
            console.warn(`[SyncEventStore] 同步事件箱损坏，已隔离并重建: ${error.message}`);
            return emptyState();
        }
    }

    flush() {
        if (!this.dirty) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporary, this.filePath);
        this.dirty = false;
    }

    toRelative(chatPath) {
        const resolved = path.resolve(chatPath);
        const relative = path.relative(this.chatsDir, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('同步事件聊天路径必须位于 chatsDir 内');
        }
        return relative.split(path.sep).join('/');
    }
}

function emptyState() {
    return { version: VERSION, events: [], browserNotifications: [] };
}

function normalizeMessages(messages) {
    return (Array.isArray(messages) ? messages : []).map(message => ({
        role: message.role,
        content: String(message.content ?? ''),
        name: message.name || message._raw?.name || '',
        _raw: message._raw || null,
    }));
}
