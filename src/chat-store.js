/**
 * chat-store.js - SillyTavern JSONL 聊天记录的安全读写
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('ChatStore');

export class ChatStore {
    constructor(chatsDir, options = {}) {
        this.chatsDir = path.resolve(chatsDir);
        this.now = typeof options.now === 'function' ? options.now : () => new Date();
        this.randomUUID = typeof options.randomUUID === 'function'
            ? options.randomUUID
            : () => crypto.randomUUID();
        this.writeQueues = new Map();
    }

    /**
     * M2 共享聊天模型：列出角色的全部聊天，不按微信用户归属过滤。
     */
    list(characterName) {
        const charDir = this.resolveCharacterDir(characterName);
        if (!fs.existsSync(charDir)) return [];
        return fs.readdirSync(charDir)
            .filter(file => file.endsWith('.jsonl') || file.endsWith('.json'))
            .map(file => {
                const filePath = this.assertInsideChats(path.join(charDir, file));
                try {
                    const parsed = this.parse(filePath);
                    const stat = fs.statSync(filePath);
                    return {
                        ...parsed,
                        activityAt: lastActivityAt(parsed.messages, stat.mtimeMs),
                    };
                } catch (error) {
                    logger.warn(`解析聊天文件失败 ${file}: ${error.message}`);
                    return null;
                }
            })
            .filter(Boolean)
            .sort((left, right) =>
                right.activityAt - left.activityAt ||
                path.basename(right.path).localeCompare(path.basename(left.path))
            );
    }

    findLatestAny(characterName) {
        return this.list(characterName)[0] || null;
    }

    resolveChatPathById(characterName, chatId) {
        const query = String(chatId || '').trim().toLowerCase();
        if (!query || path.basename(query) !== query) return null;
        const charDir = this.resolveCharacterDir(characterName);
        if (!fs.existsSync(charDir)) return null;
        const file = fs.readdirSync(charDir).find(candidate => {
            const lower = candidate.toLowerCase();
            return lower === query || path.basename(lower, path.extname(lower)) === query;
        });
        return file ? this.assertInsideChats(path.join(charDir, file)) : null;
    }

    createShared(characterDirectory, displayName = characterDirectory) {
        const characterDisplayName = String(displayName || '').trim();
        if (!characterDisplayName) throw new Error('角色名不能为空');

        const charDir = this.resolveCharacterDir(characterDirectory);
        fs.mkdirSync(charDir, { recursive: true });
        const metadata = {
            name: characterDisplayName,
            created: Date.now(),
            summary: '',
        };

        for (let attempt = 0; attempt < 20; attempt++) {
            const filename = this.createFilename(this.now(), this.randomUUID());
            const filePath = this.assertInsideChats(path.join(charDir, filename));
            try {
                const fd = fs.openSync(filePath, 'wx', 0o600);
                try {
                    fs.writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf8');
                    fs.fsyncSync(fd);
                } finally {
                    fs.closeSync(fd);
                }
                logger.info(`创建共享聊天: ${filename}`);
                return { path: filePath, metadata, messages: [], summary: '', activityAt: metadata.created };
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
        }
        throw new Error('无法创建唯一聊天文件，请稍后重试');
    }

    parse(filePath) {
        const safePath = this.assertInsideChats(filePath);
        if (!fs.existsSync(safePath)) {
            return { path: safePath, metadata: {}, messages: [], summary: '' };
        }

        const raw = fs.readFileSync(safePath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
        let metadata = {};
        let summary = '';
        const messages = [];
        let firstRecord = true;

        for (const line of lines) {
            try {
                const object = JSON.parse(line);
                if (firstRecord && isMetadataRecord(object)) {
                    metadata = object;
                    summary = object.summary || '';
                    firstRecord = false;
                    continue;
                }
                firstRecord = false;
                if (object.is_system) continue;
                if (typeof object.mes === 'string' && object.mes.length > 0) {
                    messages.push({
                        role: object.is_user ? 'user' : 'assistant',
                        content: object.mes,
                        name: object.name,
                        _raw: object,
                    });
                }
            } catch {
                firstRecord = false;
            }
        }
        return { path: safePath, metadata, messages, summary };
    }

    appendMessage(filePath, role, content, characterName) {
        return this.appendExchange(filePath, [{ role, content }], characterName);
    }

    appendExchange(filePath, messages, characterName) {
        const safePath = this.assertInsideChats(filePath);
        const lines = messages.map(message => JSON.stringify({
            name: message.role === 'user' ? 'You' : characterName,
            is_user: message.role === 'user',
            mes: String(message.content ?? ''),
            send_date: Date.now(),
            ...(message.operationId
                ? { st_wechat_operation_id: String(message.operationId) }
                : {}),
        }));
        fs.appendFileSync(safePath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    findOperationResult(filePath, operationId) {
        const selected = String(operationId || '');
        if (!selected) return null;
        const messages = this.parse(filePath).messages;
        const assistant = messages.find(message =>
            message.role === 'assistant'
            && message._raw?.st_wechat_operation_id === selected
        );
        return assistant?.content || null;
    }

    appendExchangeQueued(filePath, messages, characterName) {
        return this.enqueueWrite(filePath, () => {
            this.appendExchange(filePath, messages, characterName);
        });
    }

    enqueueWrite(filePath, operation) {
        const safePath = this.assertInsideChats(filePath);
        const previous = this.writeQueues.get(safePath) || Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(operation);
        this.writeQueues.set(safePath, current);
        return current.finally(() => {
            if (this.writeQueues.get(safePath) === current) this.writeQueues.delete(safePath);
        });
    }

    replaceLastAssistant(filePath, newContent) {
        const safePath = this.assertInsideChats(filePath);
        const lines = readRawLines(safePath);
        for (let index = lines.length - 1; index >= 0; index--) {
            try {
                const object = JSON.parse(lines[index]);
                if (!object.is_user && !object.is_system && typeof object.mes === 'string') {
                    const swipes = Array.isArray(object.swipes) ? [...object.swipes] : [object.mes];
                    if (!swipes.includes(object.mes)) swipes.push(object.mes);
                    if (!swipes.includes(newContent)) swipes.push(newContent);
                    object.mes = newContent;
                    object.swipes = swipes;
                    object.swipe_id = swipes.indexOf(newContent);
                    lines[index] = JSON.stringify(object);
                    this.atomicWriteLines(safePath, lines);
                    return { swipes, swipeId: object.swipe_id };
                }
            } catch {
                // 未知行原样保留。
            }
        }
        return false;
    }

    selectLastAssistantSwipe(filePath, swipeIndex) {
        const safePath = this.assertInsideChats(filePath);
        const lines = readRawLines(safePath);
        for (let index = lines.length - 1; index >= 0; index--) {
            try {
                const object = JSON.parse(lines[index]);
                if (!object.is_user && !object.is_system && typeof object.mes === 'string') {
                    const swipes = Array.isArray(object.swipes) && object.swipes.length > 0
                        ? object.swipes
                        : [object.mes];
                    const selected = Number(swipeIndex);
                    if (!Number.isInteger(selected) || selected < 0 || selected >= swipes.length) {
                        return null;
                    }
                    object.swipes = swipes;
                    object.swipe_id = selected;
                    object.mes = swipes[selected];
                    lines[index] = JSON.stringify(object);
                    this.atomicWriteLines(safePath, lines);
                    return { content: object.mes, swipes, swipeId: selected };
                }
            } catch {}
        }
        return null;
    }

    updateMetadata(filePath, updates) {
        const safePath = this.assertInsideChats(filePath);
        const lines = readRawLines(safePath);
        let current = {};
        let messageStart = 0;
        if (lines.length > 0) {
            try {
                const first = JSON.parse(lines[0]);
                if (isMetadataRecord(first)) {
                    current = first;
                    messageStart = 1;
                }
            } catch {
                // 第一行不是 JSON 时，在前面插入元数据并保留原行。
            }
        }
        const newMetadata = { ...current, ...updates };
        this.atomicWriteLines(safePath, [
            JSON.stringify(newMetadata),
            ...lines.slice(messageStart),
        ]);
    }

    resolveCharacterDir(characterName) {
        return this.assertInsideChats(path.join(this.chatsDir, safeCharacterDirectoryName(characterName)));
    }

    assertInsideChats(candidate) {
        const resolved = path.resolve(candidate);
        const relative = path.relative(this.chatsDir, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`聊天路径越出数据目录: ${resolved}`);
        }
        return resolved;
    }

    createFilename(date, id) {
        const stamp = [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
        ].join('-') + ' ' + [
            pad(date.getHours()),
            pad(date.getMinutes()),
            pad(date.getSeconds()),
        ].join('-') + `.${String(date.getMilliseconds()).padStart(3, '0')}`;
        return `微信对话 (${stamp}) ${String(id).slice(0, 12)}.jsonl`;
    }

    atomicWriteLines(filePath, lines) {
        const safePath = this.assertInsideChats(filePath);
        const tempPath = this.assertInsideChats(
            path.join(path.dirname(safePath), `.${path.basename(safePath)}.${this.randomUUID()}.tmp`)
        );
        const fd = fs.openSync(tempPath, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, `${lines.join('\n')}\n`, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tempPath, safePath);
    }
}

export function safeCharacterDirectoryName(name) {
    const original = String(name || '').trim();
    if (!original) throw new Error('角色名不能为空');
    if (isSafePathSegment(original)) return original;

    const sanitized = original
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+$/, '_')
        .replace(/[ .]+$/g, '')
        .slice(0, 80) || 'character';
    const hash = crypto.createHash('sha256').update(original).digest('hex').slice(0, 10);
    return `${sanitized}--${hash}`;
}

function isSafePathSegment(value) {
    if (value === '.' || value === '..') return false;
    if (/[<>:"/\\|?*\x00-\x1f]/.test(value)) return false;
    if (/[ .]$/.test(value)) return false;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return false;
    return true;
}

function lastActivityAt(messages, fallback) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const value = Number(messages[index]?._raw?.send_date);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return Number(fallback) || 0;
}

function isMetadataRecord(object) {
    return object
        && object.mes === undefined
        && object.is_user === undefined
        && object.is_system === undefined;
}

function readRawLines(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split(/\r?\n/).filter((line, index, array) => {
        // 仅移除文件结尾的空行，中间的未知/空行保留没有业务意义。
        return line !== '' || index < array.length - 1;
    });
}

function pad(number) {
    return String(number).padStart(2, '0');
}
