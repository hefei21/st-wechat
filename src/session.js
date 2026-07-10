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
import { getCharList, getCharacter, generate, setSummary, reloadAll } from './adapter.js';
import { ChatStore } from './chat-store.js';
import { load } from './config.js';

export class SessionManager {
    constructor() {
        this.sessions = new Map();
        setInterval(() => this.cleanup(), 600000);
    }

    /**
     * 获取用户数据容器
     */
    getUser(userId) {
        if (!this.sessions.has(userId)) {
            this.sessions.set(userId, {
                current: null,
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
        return this.getUser(userId).current;
    }

    /**
     * 确保当前角色会话存在（自动创建）
     */
    ensureCharSession(userId) {
        const user = this.getUser(userId);
        if (!user.current) return null;
        if (!user.chars[user.current]) {
            user.chars[user.current] = {
                chatPath: null,
                history: [],
                summary: '',
                alternatives: [],
                swipeIndex: 0,
            };
        }
        return user.chars[user.current];
    }

    cleanup() {
        const now = Date.now();
        for (const [uid, u] of this.sessions) {
            if (now - u.lastActive > 3600000) {
                this.sessions.delete(uid);
            }
        }
    }

    // ========== 入口 ==========

    async handle(userId, text) {
        const user = this.getUser(userId);
        user.lastActive = Date.now();

        // 去除前后空白，兼容全角空格、微信可能附加的@前缀等
        const cleanText = (text || '').trim().replace(/^@[^\s]+\s*/, '').replace(/^[\s\u3000]+/, '');
        console.log(`[Session] 收到消息: "${cleanText.slice(0, 80)}" (raw: "${text.slice(0, 80)}")`);

        if (cleanText.startsWith('/') || cleanText.startsWith('／')) {
            return this.handleCommand(userId, cleanText);
        }
        return this.handleChat(userId, cleanText);
    }

    async handleCommand(userId, text) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase().replace(/^／/, '/');
        const arg = parts.slice(1).join(' ');

        console.log(`[Session] 执行命令: ${cmd}, 参数: "${arg.slice(0, 80)}"`);

        try {
            switch (cmd) {
            // 角色管理
            case '/list':     return this.cmdList();
            case '/switch':   return this.cmdSwitch(userId, arg);
            case '/whoami':   return this.cmdWhoami(userId);
            case '/clear':    return this.cmdClear(userId);

            // 对话控制
            case '/continue': case '/cont':  return this.cmdContinue(userId);
            case '/gen':      return this.cmdContinue(userId, arg);
            case '/retry':    case '/r':     return this.cmdRetry(userId);
            case '/imp':      return this.cmdImpersonate(userId, arg);
            case '/swipe':    return this.cmdSwipe(userId);

            // 记忆
            case '/memory':   case '/mem':   return this.cmdSetMemory(userId, arg);
            case '/getmem':   return this.cmdGetMemory(userId);

            // 系统
            case '/reload':   return this.cmdReload();
            case '/help':     return this.cmdHelp();

            default:
                return `未知命令: ${cmd}。发送 /help 查看可用命令`;
            }
        } catch (err) {
            console.error('[Session] 命令执行失败:', err);
            return `😵 命令执行失败：${err.message}`;
        }
    }

    // ========== 角色管理 ==========

    cmdList() {
        const chars = getCharList();
        if (chars.length === 0) return '📭 暂无可用的角色卡';
        return '📋 可用角色：\n' + chars.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
            + '\n\n发送 /switch 序号 或 /switch 角色名 来切换（如 /switch 1 或 /switch Alice）';
    }

    /**
     * /switch 序号|名称
     * 支持：/switch 1  /switch Alice  /switch ali  (模糊匹配只靠前缀)
     */
    async cmdSwitch(userId, charName) {
        if (!charName) return '请指定角色名或序号，如 /switch 1 或 /switch Alice';

        const characters = getCharList();
        let resolvedName = null;

        // 1. 尝试序号
        const idx = parseInt(charName, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= characters.length) {
            resolvedName = characters[idx - 1];
        }

        // 2. 尝试精确名称
        if (!resolvedName) {
            const char = getCharacter(charName);
            if (char) resolvedName = char.data.name || charName;
        }

        // 3. 模糊匹配（前缀）—— 只当精确匹配失败时
        if (!resolvedName) {
            const lower = charName.toLowerCase();
            const match = characters.find(c => c.toLowerCase().startsWith(lower));
            if (match) resolvedName = match;
        }

        if (!resolvedName) {
            return `未找到角色 "${charName}"。发送 /list 查看可用角色`;
        }

        const user = this.getUser(userId);

        // 如果目标角色已有会话，恢复它
        if (user.chars[resolvedName]) {
            user.current = resolvedName;
            const cs = user.chars[resolvedName];
            const historyInfo = cs.history.length > 0
                ? `\n📜 已恢复 ${cs.history.length / 2} 轮对话`
                : '';
            const memInfo = cs.summary
                ? `\n📝 记忆: ${cs.summary.slice(0, 80)}${cs.summary.length > 80 ? '...' : ''}`
                : '';
            return `✅ 已切换到 ${resolvedName}（恢复上次进度）${historyInfo}${memInfo}`;
        }

        // 新角色：创建会话 + 开局对话
        user.current = resolvedName;
        const cs = this.ensureCharSession(userId);
        const cfg = load();

        // 创建聊天文件并加载（如果有旧记录则恢复）
        const chatStore = new ChatStore(cfg.chatsDir);
        const chat = chatStore.findOrCreate(resolvedName, userId);
        cs.chatPath = chat.path;

        if (chat.summary) cs.summary = chat.summary;
        if (chat.messages.length > 0) {
            cs.history = chat.messages;
            // 返回历史摘要 + 最近5条消息（逐条发送，保持微信清爽）
            const recent = chat.messages.slice(-5);
            const header = `✅ 已切换到 ${resolvedName}（${Math.round(chat.messages.length / 2)} 轮历史对话，最近 5 条：）`;
            const formatted = recent.map(m => {
                if (m.role === 'user') return `👤 ${m.content.slice(0, 500)}`;
                return `💬 ${m.content.slice(0, 500)}`;
            });
            return [header, ...formatted];
        }

        // 全新聊天：生成开场白
        try {
            const greeting = await generate(cs, userId, resolvedName, '', 'chat', {});
            return `✅ 已切换到 ${resolvedName}\n\n${resolvedName}: ${greeting}`;
        } catch (err) {
            const char = getCharacter(resolvedName);
            const fallback = char?.data?.first_mes || `你好！我是${resolvedName}，很高兴认识你～`;
            cs.history.push({ role: 'assistant', content: fallback });
            return `✅ 已切换到 ${resolvedName}\n\n${resolvedName}: ${fallback}`;
        }
    }

    cmdWhoami(userId) {
        const user = this.getUser(userId);
        if (!user.current) return '你还没有选择角色。发送 /list 查看可用角色';

        const cs = user.chars[user.current];
        const roles = Object.keys(user.chars);
        let info = `当前角色：${user.current}\n`;
        info += `对话轮次：${Math.floor((cs?.history.length || 0) / 2)}\n`;

        if (roles.length > 1) {
            info += `已对话过：${roles.join(', ')}\n`;
        }
        if (cs?.summary) {
            info += `记忆：${cs.summary.slice(0, 100)}${cs.summary.length > 100 ? '...' : ''}`;
        }
        return info;
    }

    cmdClear(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        cs.history = [];
        cs.alternatives = [];
        return '✅ 对话历史已清空（角色绑定和记忆保留）';
    }

    // ========== 续写 ==========

    async cmdContinue(userId, direction) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        try {
            const contMsg = direction ? `[续写: ${direction}]` : '[续写: 自动]';
            const reply = await generate(cs, userId, this.getCharName(userId), contMsg, 'continue', { direction });
            cs.history.push(
                { role: 'user', content: contMsg },
                { role: 'assistant', content: reply }
            );
            return `✍️ 续写：\n\n${reply}`;
        } catch (err) {
            return `😵 续写失败：${err.message}`;
        }
    }

    // ========== 重新生成 ==========

    async cmdRetry(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';

        // 跳过命令产生的合成消息（[续写：...], [请继续], [现在你是用户...] 等）
        const isSynthetic = (msg) => msg && msg.startsWith('[');

        let lastUserMsg = null;
        let lastAssistIdx = -1;
        for (let i = cs.history.length - 1; i >= 0; i--) {
            if (cs.history[i].role === 'user' && !lastUserMsg && !isSynthetic(cs.history[i].content)) {
                lastUserMsg = cs.history[i].content;
            }
            if (cs.history[i].role === 'assistant' && lastAssistIdx === -1) {
                lastAssistIdx = i;
            }
        }
        if (!lastUserMsg) return '没有可重新生成的消息';
        if (lastAssistIdx === -1) return '没有可重新生成的 AI 回复';

        try {
            const reply = await generate(
                { ...cs, history: cs.history.slice(0, lastAssistIdx) },
                userId, this.getCharName(userId), lastUserMsg, 'retry', {}, { noWrite: true }
            );

            // 更新内存
            cs.history[lastAssistIdx] = { role: 'assistant', content: reply };

            // 同步更新聊天文件中的最后一条 AI 回复
            const cfg = load();
            const chatStore = new ChatStore(cfg.chatsDir);
            chatStore.replaceLastAssistant(cs.chatPath, reply);

            return `🔄 重新生成：\n\n${reply}`;
        } catch (err) {
            return `😵 生成失败：${err.message}`;
        }
    }

    // ========== 代入 ==========

    async cmdImpersonate(userId, sentence) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        try {
            const impMsg = `[AI 帮答: ${sentence || '请写一段回复'}]`;
            const reply = await generate(cs, userId, this.getCharName(userId), impMsg, 'impersonate', { sentence });
            cs.history.push({ role: 'user', content: reply });
            return `🎭 AI 代你说了：\n\n${reply}`;
        } catch (err) {
            return `😵 生成失败：${err.message}`;
        }
    }

    // ========== 备选 ==========

    cmdSwipe(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        if (!cs.alternatives || cs.alternatives.length === 0) return '没有备选回复';
        cs.swipeIndex = (cs.swipeIndex + 1) % cs.alternatives.length;
        const alt = cs.alternatives[cs.swipeIndex];
        for (let i = cs.history.length - 1; i >= 0; i--) {
            if (cs.history[i].role === 'assistant') {
                cs.history[i].content = alt;
                break;
            }
        }
        return `🔄 备选 ${cs.swipeIndex + 1}/${cs.alternatives.length}：\n\n${alt}`;
    }

    // ========== 记忆 ==========

    cmdSetMemory(userId, text) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        if (!text) return '请提供记忆内容，如 /memory 主角和Alice在咖啡馆相遇';
        setSummary(cs, text);
        return `✅ 记忆已保存：\n${text}`;
    }

    cmdGetMemory(userId) {
        const cs = this.getCharSession(userId);
        if (!cs) return '请先选择角色';
        if (!cs.summary) return '📭 暂无记忆。用 /memory 内容 设置';
        return `📝 当前记忆：\n${cs.summary}`;
    }

    // ========== 重载 ==========

    cmdReload() {
        try { reloadAll(); return '✅ 配置已重载'; }
        catch (err) { return `⚠️ ${err.message}`; }
    }

    // ========== 帮助 ==========

    cmdHelp() {
        return `📖 可用命令：

【角色管理】
  /list        列出所有可用角色
  /switch xx   切换到角色（已有对话会自动恢复）
  /whoami      查看当前角色和状态
  /clear       清空当前对话历史

【对话控制】
  /continue    续写 AI 回复 (/cont)
  /gen 方向    指定续写方向
  /retry       重新生成上一条回复 (/r)
  /imp 内容    AI 代用户说话
  /swipe       查看备选回复

【记忆】
  /memory 内容  手动设置记忆 (/mem)
  /getmem       查看当前记忆

【系统】
  /reload       重载酒馆配置
  /help         显示帮助`;
    }

    // ========== 普通对话 ==========

    async handleChat(userId, text) {
        const cs = this.ensureCharSession(userId);
        if (!cs) {
            return '👋 欢迎！请先选择角色。\n发送 /list 查看可用角色';
        }

        try {
            const reply = await generate(cs, userId, this.getCharName(userId), text, 'chat', {});
            cs.history.push(
                { role: 'user', content: text },
                { role: 'assistant', content: reply }
            );
            return reply;
        } catch (err) {
            return `😵 出错：${err.message}`;
        }
    }
}
