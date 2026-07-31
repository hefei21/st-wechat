import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

export class ChatRegistry {
    constructor(filePath, chatsDir) {
        this.filePath = path.resolve(filePath);
        this.chatsDir = path.resolve(chatsDir);
        this.state = this.read();
        this.writeTimer = null;
        this.dirty = false;
    }

    read() {
        if (!fs.existsSync(this.filePath)) return emptyState();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed?.version !== VERSION || typeof parsed.characters !== 'object') {
                throw new Error('不支持的注册表版本');
            }
            return {
                version: VERSION,
                botCurrentCharacterId: stringOrNull(parsed.botCurrentCharacterId),
                characters: parsed.characters || {},
                chats: parsed.chats || {},
            };
        } catch (error) {
            const backup = `${this.filePath}.invalid-${Date.now()}`;
            try { fs.renameSync(this.filePath, backup); } catch {}
            console.warn(`[Registry] 聊天注册表损坏，已隔离并重建: ${error.message}`);
            return emptyState();
        }
    }

    getBotSelection(characterId) {
        const item = this.state.characters[characterId];
        if (!item?.botChatPath) return null;
        try {
            return {
                chatPath: this.resolveChatPath(item.botChatPath),
                updatedAt: Number(item.updatedAt) || 0,
            };
        } catch {
            return null;
        }
    }

    setBotSelection(characterId, chatPath) {
        const relativePath = this.toRelativeChatPath(chatPath);
        this.state.botCurrentCharacterId = characterId;
        this.state.characters[characterId] = {
            ...(this.state.characters[characterId] || {}),
            botChatPath: relativePath,
            updatedAt: Date.now(),
        };
        this.touchChat(chatPath);
        this.scheduleWrite();
    }

    setBrowserSelection(characterId, chatPath) {
        const relativePath = this.toRelativeChatPath(chatPath);
        this.state.characters[characterId] = {
            ...(this.state.characters[characterId] || {}),
            browserChatPath: relativePath,
            browserUpdatedAt: Date.now(),
        };
        this.touchChat(chatPath);
        this.scheduleWrite();
    }

    isSameCurrentChat(characterId) {
        if (this.state.botCurrentCharacterId !== characterId) return false;
        const item = this.state.characters[characterId];
        return !!item?.botChatPath && item.botChatPath === item.browserChatPath;
    }

    getChatState(chatPath) {
        const relativePath = this.toRelativeChatPath(chatPath);
        return this.state.chats[relativePath] || null;
    }

    touchChat(chatPath, details = {}) {
        const relativePath = this.toRelativeChatPath(chatPath);
        this.state.chats[relativePath] = {
            ...(this.state.chats[relativePath] || {}),
            ...details,
            updatedAt: Date.now(),
        };
        this.scheduleWrite();
    }

    toRelativeChatPath(chatPath) {
        const resolved = path.resolve(chatPath);
        const relative = path.relative(this.chatsDir, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('聊天路径必须位于 chatsDir 内');
        }
        return relative.split(path.sep).join('/');
    }

    resolveChatPath(relativePath) {
        const resolved = path.resolve(this.chatsDir, relativePath);
        const relative = path.relative(this.chatsDir, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('注册表聊天路径越界');
        }
        return resolved;
    }

    scheduleWrite() {
        this.dirty = true;
        if (this.writeTimer) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush();
        }, 250);
        this.writeTimer.unref?.();
    }

    flush() {
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = null;
        if (!this.dirty) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        const fd = fs.openSync(tempPath, 'w', 0o600);
        try {
            fs.writeFileSync(fd, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tempPath, this.filePath);
        this.dirty = false;
    }

    close() {
        this.flush();
    }
}

function emptyState() {
    return {
        version: VERSION,
        botCurrentCharacterId: null,
        characters: {},
        chats: {},
    };
}

function stringOrNull(value) {
    return typeof value === 'string' && value ? value : null;
}
