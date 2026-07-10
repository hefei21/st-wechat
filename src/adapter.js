/**
 * adapter.js - ST 数据适配器 + LLM API 调用
 *
 * prompt-builder 组装提示词，ChatStore 读写对话记录，
 * WorldBook 加载世界书，直接调用 LLM API 生成回复。
 */
import { load, reload } from './config.js';
import { loadCharacter, listCharacters } from './parser.js';
import { WorldBook } from './worldbook.js';
import { ChatStore } from './chat-store.js';
import { buildMessages, buildContinueMessages, buildImpersonateMessages } from './prompt-builder.js';

// 懒加载全局实例（/reload 时重置）
let _worldBook = null;
let _chatStore = null;

function getWorldBook() {
    if (!_worldBook) { const cfg = load(); _worldBook = new WorldBook(cfg.worldsDir); }
    return _worldBook;
}
function getChatStore() {
    if (!_chatStore) { const cfg = load(); _chatStore = new ChatStore(cfg.chatsDir); }
    return _chatStore;
}

export function getCharList() {
    return listCharacters(load().charactersDir).map(c => c.name);
}
export function getCharacter(name) {
    return loadCharacter(load().charactersDir, name);
}

export function reloadAll() {
    reload();
    const cfg = load();
    _worldBook = new WorldBook(cfg.worldsDir);
    _chatStore = new ChatStore(cfg.chatsDir);
    return cfg;
}

/**
 * 发起对话生成
 *
 * 每次调用前会从聊天文件同步最新历史（处理 Bot + 前端同时聊同一个角色的情况）。
 * 只追加本轮的新消息，不会重复写入已有历史。
 *
 * @param {object} cs    - 角色会话 {chatPath, history, summary, lastWritten}
 * @param {string} userId
 * @param {string} charName - 角色名
 * @param {string} message  - 用户消息
 * @param {string} type     - 'chat'|'continue'|'impersonate'|'retry'
 * @param {object} extra    - {direction, sentence}
 */
export async function generate(cs, userId, charName, message, type, extra = {}, options = {}) {
    const cfg = load();
    const char = getCharacter(charName);
    if (!char) throw new Error(`角色 "${charName}" 不存在`);

    // 聊天文件由 SessionManager 在 /switch 时创建，这里只做兜底
    const chatStore = getChatStore();
    if (!cs.chatPath) {
        const chat = chatStore.findOrCreate(charName, userId);
        cs.chatPath = chat.path;
        if (chat.summary && !cs.summary) cs.summary = chat.summary;
        if (chat.messages.length > 0 && cs.history.length === 0) {
            cs.history = chat.messages;
        }
    }

    // ========== 同步：检测前端是否在文件中新增了消息 ==========
    // 每次生成前，从文件读取最新内容，与内存中的 history 对比。
    // 如果文件里多了新消息 → 说明酒馆前端或另一个 Bot 写入了内容。
    // 将这些新消息合并到内存 history 中。
    try {
        const parsed = chatStore.parse(cs.chatPath);
        if (parsed.summary) cs.summary = parsed.summary;

        // 文件中的消息数量 > 内存中已知的 → 有外部新增
        const fileMessages = parsed.messages;
        const knownCount = cs.lastWritten || cs.history.length;
        if (fileMessages.length > knownCount) {
            const newMsgs = fileMessages.slice(knownCount);
            cs.history.push(...newMsgs);
            console.log(`[Adapter] 从文件同步了 ${newMsgs.length} 条外部新增消息`);
        }
    } catch { /* 文件可能尚不存在 */ }

    // ========== 构建提示词 ==========
    const worldBook = getWorldBook();
    let result;
    switch (type) {
        case 'continue':
            result = buildContinueMessages({
                char, persona: cfg.persona, username: cfg.username,
                prompts: cfg.prompts, history: cs.history,
                direction: extra.direction, worldBook, summary: cs.summary,
            }); break;
        case 'impersonate':
            result = buildImpersonateMessages({
                char, persona: cfg.persona, username: cfg.username,
                prompts: cfg.prompts, history: cs.history,
                sentence: extra.sentence, worldBook, summary: cs.summary,
            }); break;
        default:
            result = buildMessages({
                char, persona: cfg.persona, username: cfg.username,
                prompts: cfg.prompts, history: cs.history,
                message, worldBook, summary: cs.summary,
            });
    }

    // ========== 调用 LLM ==========
    const reply = await callLLM(result.messages, cfg);

    // ========== 写入聊天文件（仅追加本轮新消息）==========
    if (!options.noWrite) {
        const charNameForKey = char.data?.name || charName;
        if (type !== 'impersonate') {
            chatStore.appendMessage(cs.chatPath, 'user', message, charNameForKey);
            chatStore.appendMessage(cs.chatPath, 'assistant', reply, charNameForKey);
        } else {
            chatStore.appendMessage(cs.chatPath, 'user', reply, charNameForKey);
        }
    }

    // 记录本次写入后的文件位置（用于下次同步检测）
    try {
        const after = chatStore.parse(cs.chatPath);
        cs.lastWritten = after.messages.length;
    } catch {}

    return reply;
}

/**
 * 更新记忆
 */
export function setSummary(cs, text) {
    cs.summary = text;
    if (cs.chatPath) {
        getChatStore().updateMetadata(cs.chatPath, { summary: text });
    }
}

// ========== LLM API ==========

async function callLLM(messages, cfg) {
    const { endpoint, model, apiKey, temperature } = cfg.llm;
    if (!apiKey) throw new Error('未检测到 API 密钥，请在酒馆中配置 LLM API');

    if (endpoint.includes('anthropic')) return callClaude(endpoint, apiKey, model, messages);
    if (endpoint.includes('generativelanguage') || endpoint.includes('googleapis')) return callGemini(endpoint, apiKey, model, messages);
    return callOpenAI(endpoint, apiKey, model, messages, temperature);
}

async function callOpenAI(endpoint, apiKey, model, messages, temperature) {
    const url = endpoint.includes('/chat/completions') ? endpoint : endpoint.replace(/\/+$/, '') + '/chat/completions';
    let res;
    try {
        res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, max_tokens: 500, temperature }),
        });
    } catch (err) {
        console.error('[LLM] fetch 失败:', err.message, '| URL:', url, '| Model:', model);
        throw new Error(`fetch 失败: ${err.message}。请检查容器网络能否访问 ${url}`);
    }
    if (!res.ok) { const e = await res.text(); throw new Error(`LLM ${res.status}: ${e.slice(0, 200)}`); }
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '(AI 未返回内容)';
}

async function callClaude(endpoint, apiKey, model, messages) {
    const sys = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const url = endpoint.includes('/messages') ? endpoint : endpoint.replace(/\/+$/, '') + '/messages';
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 500, system: sys?.content || '', messages: chatMsgs }),
    });
    if (!res.ok) { const e = await res.text(); throw new Error(`Claude ${res.status}: ${e.slice(0, 200)}`); }
    const j = await res.json();
    return j.content?.[0]?.text || '(AI 未返回内容)';
}

async function callGemini(endpoint, apiKey, model, messages) {
    const sys = messages.find(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    const contents = others.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    let url = endpoint.includes(':generateContent') ? endpoint : `${endpoint.replace(/\/+$/, '')}/models/${model}:generateContent`;
    const body = { contents, generationConfig: { maxOutputTokens: 500 } };
    if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.text(); throw new Error(`Gemini ${res.status}: ${e.slice(0, 200)}`); }
    const j = await res.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text || '(AI 未返回内容)';
}
