/**
 * chat-store.js - ST 聊天记录的读写
 *
 * ST 聊天文件组织结构：
 *   chats/<角色名>/<日期 时间>.jsonl
 *   每个角色一个子目录，每轮对话一个 jsonl 文件。
 *
 * 消息格式：
 *   { name: string, is_user: boolean, is_system: boolean,
 *     mes: string, send_date: number, swipes: string[] }
 */
import fs from 'node:fs';
import path from 'node:path';

export class ChatStore {
    constructor(chatsDir) {
        this.chatsDir = chatsDir;
    }

    /**
     * 找到或创建指定角色的聊天文件
     * @param {string} characterName
     * @param {string} userId - 微信用户ID（区分不同用户）
     * @returns {{ path: string, messages: Array, summary: string }}
     */
    findOrCreate(characterName, userId) {
        const trimmedName = (characterName || '').trim();

        // 查找已有的聊天文件
        const existing = this.find(trimmedName, userId);
        if (existing) {
            console.log(`[ChatStore] 找到已有聊天: ${existing.path} (${existing.messages.length} 条消息)`);
            return existing;
        }

        // 创建新文件（在角色子目录内）
        const charDir = path.join(this.chatsDir, trimmedName);
        fs.mkdirSync(charDir, { recursive: true });

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const filename = `微信对话 (${dateStr}).jsonl`;
        const filePath = path.join(charDir, filename);

        // 写入初始元数据
        const metadata = {
            name: trimmedName,
            created: Date.now(),
            summary: '',
            wechat_user: userId,
            wechat_chat: true,
        };

        fs.writeFileSync(filePath, JSON.stringify(metadata) + '\n');

        console.log(`[ChatStore] 创建新聊天: ${filePath}`);
        return { path: filePath, messages: [], summary: '' };
    }

    /**
     * 查找用户与角色的已有聊天
     * ST 目录结构: chats/<角色名>/*.jsonl
     */
    find(characterName, userId) {
        const trimmedName = (characterName || '').trim();
        const charDir = path.join(this.chatsDir, trimmedName);

        if (!fs.existsSync(charDir)) {
            // 兼容旧格式：根目录扁平结构 chats/<角色名>*.jsonl
            const flatMatch = this.findFlat(trimmedName, userId);
            if (flatMatch) return flatMatch;

            console.warn(`[ChatStore] 角色目录不存在: ${charDir}`);
            return null;
        }

        const files = fs.readdirSync(charDir)
            .filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
            .sort()
            .reverse();

        console.log(`[ChatStore] 查找角色 "${trimmedName}"，目录共 ${files.length} 个文件`);

        for (const file of files) {
            const filePath = path.join(charDir, file);
            try {
                const parsed = this.parse(filePath);

                // 优先匹配当前微信用户创建的聊天
                if (parsed.metadata.wechat_user === userId) {
                    console.log(`[ChatStore] ✅ 匹配微信用户聊天: ${file}`);
                    return parsed;
                }

                // 没有微信标记的：未加标签的 ST 聊天（兼容）
                if (!parsed.metadata.wechat_user) {
                    console.log(`[ChatStore] ✅ 匹配无标记聊天: ${file}`);
                    return parsed;
                }
            } catch (err) {
                console.warn(`[ChatStore] 解析聊天文件失败 ${file}:`, err.message);
            }
        }

        console.warn(`[ChatStore] ❌ 未找到角色 "${trimmedName}" 的已标记聊天文件`);
        return null;
    }

    /**
     * 兼容旧格式：根目录扁平 chats/<角色名>*.jsonl
     */
    findFlat(characterName, userId) {
        if (!fs.existsSync(this.chatsDir)) return null;

        const trimmedName = (characterName || '').trim();
        const files = fs.readdirSync(this.chatsDir)
            .filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
            .sort()
            .reverse();

        const safeName = sanitizeFilename(trimmedName);
        const matches = files.filter(f =>
            f.startsWith(safeName + ' ') || f.startsWith(safeName + '(') || f.includes(safeName)
        );

        for (const file of matches) {
            const filePath = path.join(this.chatsDir, file);
            try {
                const parsed = this.parse(filePath);
                if (parsed.metadata.wechat_user === userId) return parsed;
                if (!parsed.metadata.wechat_user) return parsed;
            } catch {}
        }

        return null;
    }

    /**
     * 解析聊天文件
     */
    parse(filePath) {
        if (!fs.existsSync(filePath)) return { path: filePath, metadata: {}, messages: [], summary: '' };

        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.trim().split('\n');

        let metadata = {};
        let summary = '';
        const messages = [];
        let firstMessage = true;

        for (const line of lines) {
            try {
                const obj = JSON.parse(line);

                // 第一行可能不是标准消息格式，视为元数据
                if (firstMessage && obj.mes === undefined && obj.is_user === undefined && obj.is_system === undefined) {
                    metadata = obj;
                    summary = obj.summary || '';
                    firstMessage = false;
                    continue;
                }

                firstMessage = false;

                // 跳过系统消息
                if (obj.is_system) continue;

                if (obj.mes) {
                    messages.push({
                        role: obj.is_user ? 'user' : 'assistant',
                        content: obj.mes,
                        name: obj.name,
                        _raw: obj,
                    });
                }
            } catch {
                // 跳过无法解析的行
            }
        }

        return { path: filePath, metadata, messages, summary };
    }

    /**
     * 追加消息到聊天文件
     */
    appendMessage(filePath, role, content, characterName) {
        // 确保目录存在
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const msg = {
            name: role === 'user' ? 'You' : characterName,
            is_user: role === 'user',
            mes: content,
            send_date: Date.now(),
        };
        fs.appendFileSync(filePath, JSON.stringify(msg) + '\n');
    }

    /**
     * 替换聊天文件中最后一条 AI 回复的内容
     */
    replaceLastAssistant(filePath, newContent) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.trim().split('\n');
        if (lines.length === 0) return false;

        // 第一行是元数据
        const metadata = lines[0];
        const messages = lines.slice(1).map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        // 从后往前找到最后一条 assistant 消息
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].is_user) {
                messages[i].mes = newContent;
                const newLines = [metadata, ...messages.map(m => JSON.stringify(m))];
                fs.writeFileSync(filePath, newLines.join('\n') + '\n');
                return true;
            }
        }
        return false;
    }

    /**
     * 更新聊天元数据（如 summary）
     */
    updateMetadata(filePath, updates) {
        const parsed = this.parse(filePath);
        const newMetadata = { ...parsed.metadata, ...updates };

        const allMessages = parsed.messages.map(m => m._raw || {
            name: m.name,
            is_user: m.role === 'user',
            mes: m.content,
        });

        const lines = [
            JSON.stringify(newMetadata),
            ...allMessages.map(m => JSON.stringify(m)),
        ];

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, lines.join('\n') + '\n');
    }
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 100);
}

function pad(n) {
    return String(n).padStart(2, '0');
}
