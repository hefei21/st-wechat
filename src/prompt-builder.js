/**
 * prompt-builder.js - ST 提示词组装器
 *
 * 复现 SillyTavern 前端的提示词构建流程：
 * 1. 加载模板（系统提示词 / 上下文 / 指令）
 * 2. 匹配世界书
 * 3. 注入记忆（summary）
 * 4. 拼接历史消息
 * 5. 生成最终 ChatML 消息数组
 */
import { renderTemplate, buildTemplateVars } from './template.js';

/**
 * 构建完整的 ST 风格提示词
 * @param {object} opts
 * @param {object} opts.char       - 角色卡数据
 * @param {object} opts.persona    - 用户人设 {name, description}
 * @param {string} opts.username   - 用户名
 * @param {object} opts.prompts    - ST 的提示词模板 {systemPrompt, contextTemplate, instructTemplate}
 * @param {Array}  opts.history    - [{role, content}, ...]
 * @param {string} opts.message    - 用户新消息
 * @param {object} opts.worldBook  - WorldBook 实例
 * @param {string} opts.summary    - 对话总结（记忆）
 * @returns {{ messages: Array, systemPrompt: string }}
 */
export function buildMessages(opts) {
    const {
        char, persona, username, prompts, history, message, worldBook, summary,
        maxContextTokens = 64000,
        maxOutputTokens = 1200,
        charsPerToken = 3,
    } = opts;
    const charData = char?.data || char;

    // --- 1. 拼贴近期文本用于世界书匹配 ---
    const recentText = [
        ...history.slice(-6).map(h => h.content || ''),
        message || '',
    ].join('\n');

    // --- 2. 世界书匹配 ---
    let worldEntries = { before: '', after: '' };
    if (worldBook) {
        worldEntries = worldBook.match(recentText, { character: charData });
    }

    // --- 3. 构建模板变量 ---
    const vars = buildTemplateVars({
        char: charData,
        persona,
        username,
        worldEntries,
        summary,
    });

    // --- 4. 处理系统提示词 ---
    const systemPrompt = renderTemplate(prompts.systemPrompt || '', vars)
        || buildDefaultSystemPrompt(charData);

    vars.system_prompt = systemPrompt;

    // --- 5. 处理上下文模板 ---
    const context = renderTemplate(prompts.contextTemplate || '', vars);

    // --- 6. 处理指令模板 ---
    const instruct = renderTemplate(prompts.instructTemplate || '', vars);

    // --- 7. 按固定语义顺序组装唯一 system message ---
    // 系统规则 → 角色 → persona → 世界书 → 记忆 → 示例；历史消息随后单独加入。
    const rules = [instruct, systemPrompt].filter(Boolean).join('\n\n');
    const renderedFoundation = [rules, context].filter(Boolean).join('\n\n');
    const finalSystemParts = [rules];
    const missingCharacter = buildMissingCharacterProfile(charData, renderedFoundation);
    if (missingCharacter) finalSystemParts.push(missingCharacter);
    if (context) finalSystemParts.push(context);
    const missingPersona = buildMissingPersona(persona, renderedFoundation);
    if (missingPersona) finalSystemParts.push(missingPersona);
    finalSystemParts.push(
        includeOnce(worldEntries.before, renderedFoundation),
        includeOnce(worldEntries.after, renderedFoundation),
        includeOnce(summary ? `对话记忆：\n${summary}` : '', renderedFoundation),
    );
    if (charData.mes_example) finalSystemParts.push(formatExample(charData.mes_example));
    const finalSystem = finalSystemParts.filter(Boolean).join('\n\n');

    // --- 8. 拼接消息 ---
    const messages = [];

    // 始终只生成一条 system message，避免 Claude/Gemini 丢失后续系统信息。
    messages.push({ role: 'system', content: finalSystem });

    // 如果历史为空且有开场白，先加入开场白
    if (history.length === 0 && charData.first_mes) {
        messages.push({ role: 'assistant', content: charData.first_mes });
    }

    // 历史消息
    const budgetedHistory = fitHistoryToBudget({
        system: finalSystem,
        history,
        message,
        maxContextTokens,
        maxOutputTokens,
        charsPerToken,
    });
    for (const h of budgetedHistory) {
        messages.push({ role: h.role, content: h.content });
    }

    // 用户新消息
    messages.push({ role: 'user', content: message });

    return { messages, systemPrompt: finalSystem };
}

/**
 * 默认系统提示词（如果没有模板文件）
 */
function buildDefaultSystemPrompt(charData) {
    const parts = [];
    if (charData.name) parts.push(`${charData.name}的角色设定`);
    if (charData.description) parts.push(charData.description);
    if (charData.personality) parts.push(`性格：${charData.personality}`);
    if (charData.scenario) parts.push(`场景：${charData.scenario}`);
    if (parts.length === 0) parts.push('正常对话');
    return parts.join('\n');
}

/**
 * 格式化对话示例
 */
function formatExample(example) {
    if (!example) return '';
    return `以下是对话风格示例，请严格模仿：\n${example}`;
}

export function estimateTokens(text, charsPerToken = 3) {
    const content = String(text || '');
    const ratio = Number(charsPerToken) > 0 ? Number(charsPerToken) : 3;
    return Math.ceil(content.length / ratio);
}

export function fitHistoryToBudget({
    system,
    history,
    message,
    maxContextTokens,
    maxOutputTokens,
    charsPerToken = 3,
}) {
    const contextLimit = Math.max(64, Number(maxContextTokens) || 64000);
    const outputReserve = Math.max(1, Number(maxOutputTokens) || 1200);
    const fixedTokens = estimateTokens(system, charsPerToken)
        + estimateTokens(message, charsPerToken)
        + 32;
    let remaining = Math.max(0, contextLimit - outputReserve - fixedTokens);
    const selected = [];

    for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index];
        const cost = estimateTokens(item.content, charsPerToken) + 8;
        if (cost > remaining) break;
        selected.push(item);
        remaining -= cost;
    }
    return selected.reverse();
}

function includeOnce(entry, renderedPrompt) {
    const content = String(entry || '').trim();
    if (!content || renderedPrompt.includes(content)) return '';
    return content;
}

function buildMissingCharacterProfile(charData, renderedPrompt) {
    const fields = [
        ['角色名', charData.name],
        ['角色描述', charData.description],
        ['性格', charData.personality],
        ['场景', charData.scenario],
        ['角色规则', charData.system_prompt],
        ['历史后指令', charData.post_history_instructions],
    ].filter(([, value]) => value && !renderedPrompt.includes(value));
    return fields.length > 0
        ? `角色设定：\n${fields.map(([label, value]) => `${label}：${value}`).join('\n')}`
        : '';
}

function buildMissingPersona(persona, renderedPrompt) {
    if (!persona?.description || renderedPrompt.includes(persona.description)) return '';
    return `用户 Persona：\n${persona.name ? `名称：${persona.name}\n` : ''}${persona.description}`;
}

/**
 * 构建续写提示词
 */
export function buildContinueMessages(opts) {
    const {
        char, persona, username, prompts, history, direction, worldBook, summary,
        maxContextTokens, maxOutputTokens, charsPerToken,
    } = opts;
    const charData = char?.data || char;

    // 找最后一条 AI 回复
    let lastAssistant = '';
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') {
            lastAssistant = history[i].content;
            break;
        }
    }

    const continueMsg = direction
        ? `${lastAssistant}\n\n[继续，接下来请写：${direction}]`
        : `${lastAssistant}\n\n[请继续]`;

    return buildMessages({
        char, persona, username, prompts,
        history,
        message: continueMsg,
        worldBook,
        summary,
        maxContextTokens,
        maxOutputTokens,
        charsPerToken,
    });
}

/**
 * 构建替代用户（Impersonate）提示词
 */
export function buildImpersonateMessages(opts) {
    const {
        char, persona, username, prompts, history, sentence, worldBook, summary,
        maxContextTokens, maxOutputTokens, charsPerToken,
    } = opts;

    const impMsg = `[现在你是用户本人，请以用户的口吻写出回复。${sentence || '请帮我写一段回复'}]`;

    return buildMessages({
        char, persona, username, prompts,
        history,
        message: impMsg,
        worldBook,
        summary,
        maxContextTokens,
        maxOutputTokens,
        charsPerToken,
    });
}
