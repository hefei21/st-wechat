/**
 * adapter.js - ST 数据适配器 + LLM API 调用
 *
 * prompt-builder 组装提示词，ChatStore 读写对话记录，
 * WorldBook 加载世界书，直接调用 LLM API 生成回复。
 */
import path from 'node:path';
import { load, reload } from './config.js';
import { loadCharacter, listCharacters } from './parser.js';
import { WorldBook } from './worldbook.js';
import { ChatStore } from './chat-store.js';
import { buildMessages, buildContinueMessages, buildImpersonateMessages } from './prompt-builder.js';
import { createLogger } from './logger.js';
import { publicOperationError } from './errors.js';

const logger = createLogger('LLM');

// 懒加载全局实例（/reload 时重置）
let _worldBook = null;
let _chatStore = null;

function getWorldBook() {
    if (!_worldBook) {
        const cfg = load();
        _worldBook = new WorldBook(cfg.worldsDir, {
            globalBooks: cfg.globalWorldBooks,
            tokenBudget: cfg.worldInfoBudgetTokens,
        });
    }
    return _worldBook;
}
function getChatStore() {
    if (!_chatStore) { const cfg = load(); _chatStore = new ChatStore(cfg.chatsDir); }
    return _chatStore;
}

export function getCharList() {
    return listCharacters(load().charactersDir).map(c => c.name);
}
export function getCharacters() {
    return listCharacters(load().charactersDir);
}
export function getCharacter(name) {
    return loadCharacter(load().charactersDir, name);
}

export function reloadAll() {
    reload();
    const cfg = load();
    _worldBook = new WorldBook(cfg.worldsDir, {
        globalBooks: cfg.globalWorldBooks,
        tokenBudget: cfg.worldInfoBudgetTokens,
    });
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
export async function generate(cs, userId, characterRef, message, type, extra = {}, options = {}) {
    const cfg = load();
    const char = getCharacter(characterRef);
    if (!char) throw new Error(`角色 "${characterRef}" 不存在`);

    // 聊天文件由 SessionManager 在 /switch 时创建，这里只做兜底
    const chatStore = getChatStore();
    if (!cs.chatPath) {
        const chatDirectory = path.basename(char.file, path.extname(char.file));
        const chat = chatStore.findLatestAny(chatDirectory)
            || chatStore.createShared(chatDirectory, char.name);
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
    // 生成事务开始后只使用这一份不可变快照。即使未来有其他只读流程持有同一个
    // 会话对象，也不能把后到消息混入已经开始的 LLM 请求。
    const historySnapshot = cs.history.map(entry => ({
        ...entry,
        _raw: entry?._raw && typeof entry._raw === 'object'
            ? structuredClone(entry._raw)
            : entry?._raw,
    }));
    const summarySnapshot = cs.summary;
    const worldBook = getWorldBook();
    const budget = {
        maxContextTokens: cfg.llm.maxContextTokens,
        maxOutputTokens: cfg.llm.maxOutputTokens,
        charsPerToken: cfg.llm.charsPerToken,
    };
    let result;
    switch (type) {
        case 'continue':
            result = buildContinueMessages({
                char, persona: cfg.persona, username: cfg.username,
                prompts: cfg.prompts, history: historySnapshot,
                direction: extra.direction, worldBook, summary: summarySnapshot, ...budget,
            }); break;
        case 'impersonate':
            result = buildImpersonateMessages({
                char, persona: cfg.persona, username: cfg.username,
                prompts: cfg.prompts, history: historySnapshot,
                sentence: extra.sentence, worldBook, summary: summarySnapshot, ...budget,
            }); break;
        default:
            result = buildMessages({
                char, persona: cfg.persona, username: cfg.username,
                prompts: cfg.prompts, history: historySnapshot,
                message, worldBook, summary: summarySnapshot, ...budget,
            });
    }

    // ========== 调用 LLM ==========
    const reply = await callLLM(result.messages, cfg, {
        signal: options.signal,
        onUsage: options.onUsage,
    });

    // ========== 写入聊天文件（仅追加本轮新消息）==========
    if (!options.noWrite) {
        if (options.signal?.aborted) {
            const error = new Error('生成已停止');
            error.code = 'cancelled';
            throw error;
        }
        await options.beforeWrite?.();
        const charNameForKey = char.data?.name || char.name;
        if (type !== 'impersonate') {
            const writtenMessages = await chatStore.appendExchangeQueued(cs.chatPath, [
                { role: 'user', content: message, operationId: options.operationId },
                { role: 'assistant', content: reply, operationId: options.operationId },
            ], charNameForKey);
            await options.onWrite?.(writtenMessages);
        } else {
            const writtenMessages = await chatStore.appendExchangeQueued(
                cs.chatPath,
                [{ role: 'user', content: reply }],
                charNameForKey
            );
            await options.onWrite?.(writtenMessages);
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

export async function callLLM(messages, cfg, options = {}) {
    const { endpoint, model, apiKey, provider } = cfg.llm;
    try {
        if (!apiKey) {
            const error = new Error('未检测到 API 密钥');
            error.code = 'configuration';
            throw error;
        }
        if (provider === 'anthropic') {
            return await callClaude(endpoint, apiKey, model, messages, cfg.llm, options);
        }
        if (provider === 'gemini') {
            return await callGemini(endpoint, apiKey, model, messages, cfg.llm, options);
        }
        return await callOpenAI(endpoint, apiKey, model, messages, cfg.llm, options);
    } catch (error) {
        if (options.signal?.aborted) error.code = 'cancelled';
        const safe = publicOperationError(error);
        logger.error(
            `模型请求失败 [${safe.diagnosticId}]: type=${safe.type}, `
            + `status=${Number(error?.status) || 0}, provider=${provider}, model=${model}`
        );
        const wrapped = new Error(safe.message);
        wrapped.code = safe.type;
        wrapped.diagnosticId = safe.diagnosticId;
        throw wrapped;
    }
}

export function buildOpenAIRequestBody(messages, llm) {
    const body = {
        model: llm.model,
        messages,
        max_tokens: llm.maxOutputTokens,
        temperature: llm.temperature,
    };
    if (llm.provider === 'deepseek') {
        body.thinking = { type: llm.thinking === 'enabled' ? 'enabled' : 'disabled' };
    }
    return body;
}

async function callOpenAI(endpoint, apiKey, model, messages, llm, options) {
    const url = endpoint.includes('/chat/completions') ? endpoint : endpoint.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetchWithTimeout(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(buildOpenAIRequestBody(messages, { ...llm, model })),
    }, llm.requestTimeoutMs, options.signal);
    await assertModelResponseOk(res);
    const j = await parseModelJson(res);
    const text = j.choices?.[0]?.message?.content || '(AI 未返回内容)';
    reportUsage(options.onUsage, {
        input: j.usage?.prompt_tokens,
        output: j.usage?.completion_tokens,
    }, messages, text, llm.charsPerToken);
    return text;
}

async function callClaude(endpoint, apiKey, model, messages, llm, options) {
    const { system, chatMessages } = splitSystemMessages(messages);
    const chatMsgs = chatMessages.map(m => ({ role: m.role, content: m.content }));
    const url = endpoint.includes('/messages') ? endpoint : endpoint.replace(/\/+$/, '') + '/messages';
    const res = await fetchWithTimeout(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: llm.maxOutputTokens, system, messages: chatMsgs }),
    }, llm.requestTimeoutMs, options.signal);
    await assertModelResponseOk(res);
    const j = await parseModelJson(res);
    const text = j.content?.[0]?.text || '(AI 未返回内容)';
    reportUsage(options.onUsage, {
        input: j.usage?.input_tokens,
        output: j.usage?.output_tokens,
    }, messages, text, llm.charsPerToken);
    return text;
}

async function callGemini(endpoint, apiKey, model, messages, llm, options) {
    const { system, chatMessages: others } = splitSystemMessages(messages);
    const contents = others.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    let url = endpoint.includes(':generateContent') ? endpoint : `${endpoint.replace(/\/+$/, '')}/models/${model}:generateContent`;
    const body = { contents, generationConfig: { maxOutputTokens: llm.maxOutputTokens, temperature: llm.temperature } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await fetchWithTimeout(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
    }, llm.requestTimeoutMs, options.signal);
    await assertModelResponseOk(res);
    const j = await parseModelJson(res);
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '(AI 未返回内容)';
    reportUsage(options.onUsage, {
        input: j.usageMetadata?.promptTokenCount,
        output: j.usageMetadata?.candidatesTokenCount,
    }, messages, text, llm.charsPerToken);
    return text;
}

function reportUsage(callback, usage, messages, reply, charsPerToken = 3) {
    if (typeof callback !== 'function') return;
    const input = Number(usage?.input);
    const output = Number(usage?.output);
    if (Number.isFinite(input) && Number.isFinite(output)) {
        callback({ input, output, estimated: false });
        return;
    }
    const divisor = Math.max(1, Number(charsPerToken) || 3);
    callback({
        input: Math.ceil(messages.reduce(
            (sum, message) => sum + String(message?.content || '').length,
            0
        ) / divisor),
        output: Math.ceil(String(reply || '').length / divisor),
        estimated: true,
    });
}

export function splitSystemMessages(messages) {
    return {
        system: messages
            .filter(message => message.role === 'system')
            .map(message => String(message.content || ''))
            .filter(Boolean)
            .join('\n\n'),
        chatMessages: messages.filter(message => message.role !== 'system'),
    };
}

async function assertModelResponseOk(response) {
    if (response?.ok) return;
    const error = new Error('模型服务返回 HTTP 错误');
    error.status = Number(response?.status) || 0;
    if (error.status === 402) error.code = 'billing';
    const providerCode = await readProviderErrorCode(response);
    if (/insufficient_quota|billing|credit|balance/i.test(providerCode)) {
        error.code = 'billing';
    } else if (/context_length|max_tokens|context_window/i.test(providerCode)) {
        error.code = 'context_limit';
    }
    throw error;
}

async function readProviderErrorCode(response) {
    try {
        const source = typeof response?.clone === 'function' ? response.clone() : response;
        const payload = await source?.json?.();
        return String(payload?.error?.code || payload?.error?.type || payload?.code || '').slice(0, 100);
    } catch {
        return '';
    }
}

async function parseModelJson(response) {
    try {
        return await response.json();
    } catch {
        const error = new Error('模型服务返回无效 JSON');
        error.code = 'protocol';
        throw error;
    }
}

async function fetchWithTimeout(url, options, timeoutMs, externalSignal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 90000));
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternal);
    }
}

export async function testLLMConnection() {
    const { llm } = load();
    if (!llm.apiKey) return { ok: false, provider: llm.provider, model: llm.model, error: 'missing_api_key' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const base = llm.endpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        let url = `${base}/models`;
        const headers = { Accept: 'application/json' };
        if (llm.provider === 'anthropic') {
            headers['x-api-key'] = llm.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else if (llm.provider === 'gemini') {
            headers['x-goog-api-key'] = llm.apiKey;
        } else {
            headers.Authorization = `Bearer ${llm.apiKey}`;
        }
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) {
            return { ok: false, provider: llm.provider, model: llm.model, status: response.status };
        }
        return { ok: true, provider: llm.provider, model: llm.model };
    } catch (error) {
        return {
            ok: false,
            provider: llm.provider,
            model: llm.model,
            error: error.name === 'AbortError' ? 'timeout' : 'network_error',
        };
    } finally {
        clearTimeout(timeout);
    }
}
