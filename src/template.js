/**
 * template.js - ST 模板宏替换引擎
 *
 * 替换 {{char}}, {{user}}, {{persona}} 等标准宏变量。
 * 用于处理系统提示词、上下文模板、指令模板中的占位符。
 */

/**
 * 执行模板宏替换
 * @param {string} template - 包含 {{宏}} 的模板字符串
 * @param {object} vars - 变量映射表
 * @returns {string}
 */
export function renderTemplate(template, vars) {
    if (!template) return '';

    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (key in vars && vars[key] !== undefined && vars[key] !== null) {
            return String(vars[key]);
        }
        // 如果变量未提供，保留原文标记（方便调试）
        return match;
    });
}

/**
 * 构建适用于 ST 提示词系统的默认变量表
 * @param {object} params
 */
export function buildTemplateVars({ char, persona, username, worldEntries, summary }) {
    return {
        // 角色相关
        char: char?.name || '',
        user: persona?.name || username || 'You',
        description: char?.description || '',
        personality: char?.personality || '',
        scenario: char?.scenario || '',
        first_mes: char?.first_mes || '',
        mes_examples: char?.mes_example || char?.mes_examples || '',

        // 用户设定
        persona: persona?.description || '',

        // 世界书（按位置分组）
        wiBefore: worldEntries?.before || '',
        wiAfter: worldEntries?.after || '',

        // 记忆
        summary: summary || '',

        // 系统提示词本身（在 instruct 模板中引用）
        system_prompt: '',  // 由 prompt-builder 单独处理
    };
}
