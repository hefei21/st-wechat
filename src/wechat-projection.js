const graphemeSegmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
    : null;

export const SWITCH_PREVIEW_LIMIT = 1800;
export const NOTIFY_PREVIEW_LIMIT = 1800;
export const FULL_PREVIEW_LIMIT = 6000;

const SWITCH_MAX_TURNS = 3;
const NOTIFY_MAX_TURNS = 3;
const FULL_EXPANDED_TURNS = 3;
const FULL_OLDER_PREVIEWS = 3;

export function visibleLength(value) {
    return toGraphemes(value).length;
}

export function projectionCost(value) {
    const text = String(value || '');
    // iLink currently splits by UTF-16 length. Charging astral graphemes as two
    // keeps a nominal 1800-character projection below the 2000-unit wire limit.
    return Math.max(visibleLength(text), text.length);
}

export function formatSwitchHistory(characterName, messages) {
    const history = normalizeMessages(messages);
    const { completed, incomplete, standalone } = groupTurns(history);
    const selectedTurns = completed.slice(-SWITCH_MAX_TURNS);
    let entries = flattenTurns(selectedTurns);
    let description;

    if (entries.length > 0) {
        description = `历史共 ${completed.length} 轮，以下为最近 ${selectedTurns.length} 轮摘要：`;
    } else if (incomplete) {
        entries = [{ role: 'user', content: incomplete.user, suffix: '（等待角色回复）' }];
        description = `历史共 ${completed.length} 轮，当前还有一条未完成的用户消息：`;
    } else {
        entries = standalone.slice(-1);
        description = '当前聊天还没有完整对话，最近内容：';
    }

    const omittedTurns = Math.max(0, completed.length - selectedTurns.length);
    const footer = omittedTurns > 0
        ? `另有 ${omittedTurns} 轮较早历史未展开，完整记录请在酒馆查看。`
        : '';
    const header = `✅ 已切换到 ${characterName}\n${description}`;
    return formatBudgetedEntries({
        header,
        entries,
        footer,
        limit: SWITCH_PREVIEW_LIMIT,
        assistantWeight: 2,
        preserveTail: false,
    });
}

export function formatBrowserSyncBatches(batches, syncMode) {
    const messages = normalizeMessages(batches.flatMap(batch => batch.messages));
    const { completed, incomplete, standalone } = groupTurns(messages);
    const resetCount = batches.filter(batch => batch.reset).length;
    const overflowCount = batches.filter(batch => batch.overflow).length;
    const incompleteCount = batches.filter(batch => batch.incomplete).length;
    const notices = [];
    let entries = [];
    let omittedTurns = 0;

    if (syncMode === 'full') {
        const expanded = completed.slice(-FULL_EXPANDED_TURNS);
        const olderEnd = Math.max(0, completed.length - expanded.length);
        const olderStart = Math.max(0, olderEnd - FULL_OLDER_PREVIEWS);
        entries = completed.slice(olderStart, olderEnd).map(turn => ({
            role: 'older',
            content: summarizeTurn(turn),
        }));
        entries.push(...flattenTurns(expanded));
        omittedTurns = olderStart;
    } else {
        const selected = completed.slice(-NOTIFY_MAX_TURNS);
        entries = flattenTurns(selected);
        omittedTurns = Math.max(0, completed.length - selected.length);
    }

    if (entries.length === 0) entries = standalone.slice(-2);
    if (incomplete) {
        entries.push({
            role: 'user',
            content: incomplete.user,
            suffix: incompleteCount ? '（本轮未生成有效角色回复）' : '（等待角色回复）',
        });
    }
    if (omittedTurns > 0) {
        notices.push(`另有 ${omittedTurns} 轮较早的浏览器对话未展开，完整记录已保存在酒馆中。`);
    }
    if (resetCount > 0) {
        notices.push(`⚠️ 检测到 ${resetCount} 次编辑、删除、重新生成或 swipe，请在需要时打开酒馆核对。`);
    }
    if (overflowCount > 0) {
        notices.push('ℹ️ 离线期间更新较多，已更新同步游标但未重放全部历史。');
    }
    if (incompleteCount > 0) {
        notices.push(`⚠️ 检测到 ${incompleteCount} 轮浏览器生成没有有效正文。对应 user 消息已保留，`
            + '但不会与下一条微信消息合并；请先在浏览器重试该轮。');
    }

    return formatBudgetedEntries({
        header: `🖥️ 酒馆端已更新当前聊天（新增 ${messages.length} 条）`,
        entries,
        footer: notices.join('\n\n'),
        limit: syncMode === 'full' ? FULL_PREVIEW_LIMIT : NOTIFY_PREVIEW_LIMIT,
        assistantWeight: 3,
        preserveTail: syncMode === 'full',
    });
}

function normalizeMessages(messages) {
    return (messages || [])
        .filter(message => ['user', 'assistant'].includes(message?.role))
        .map(message => ({
            role: message.role,
            content: String(message.content || '').trim(),
        }))
        .filter(message => message.content);
}

function groupTurns(messages) {
    const completed = [];
    const standalone = [];
    let current = null;

    for (const message of messages) {
        if (message.role === 'user') {
            if (current) standalone.push({ role: 'user', content: current.user });
            current = { user: message.content, assistants: [] };
            continue;
        }
        if (!current) {
            standalone.push(message);
            continue;
        }
        current.assistants.push(message.content);
        completed.push({
            user: current.user,
            assistant: current.assistants.join('\n\n'),
        });
        current = null;
    }

    return { completed, incomplete: current, standalone };
}

function flattenTurns(turns) {
    return turns.flatMap(turn => [
        { role: 'user', content: turn.user },
        { role: 'assistant', content: turn.assistant },
    ]);
}

function summarizeTurn(turn) {
    const user = compactInline(turn.user, 90);
    const assistant = compactInline(turn.assistant, 140);
    return `${user} → ${assistant}`;
}

function compactInline(value, limit) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (projectionCost(text) <= limit) return text;
    return `${sliceNatural(text, Math.max(1, limit - 12))}…（已截断）`;
}

function formatBudgetedEntries({
    header,
    entries,
    footer,
    limit,
    assistantWeight,
    preserveTail,
}) {
    if (entries.length === 0) return [header, footer].filter(Boolean).join('\n\n');
    const labels = entries.map(entry => entryLabel(entry.role));
    const structural = projectionCost(header)
        + projectionCost(footer)
        + labels.reduce((sum, label) => sum + projectionCost(label), 0)
        + Math.max(0, entries.length + (footer ? 1 : 0)) * 2;
    const available = Math.max(entries.length * 48, limit - structural);
    const budgets = allocateBudgets(entries, available, assistantWeight);
    const rendered = entries.map((entry, index) => {
        const roleName = entry.role === 'assistant' ? '角色回复' : '用户消息';
        const body = truncateProjection(entry.content, budgets[index], {
            label: roleName,
            preserveTail: preserveTail && entry.role === 'assistant',
        });
        return `${labels[index]}${body}${entry.suffix ? `\n${entry.suffix}` : ''}`;
    });
    const result = [header, ...rendered, footer].filter(Boolean).join('\n\n');
    if (projectionCost(result) <= limit) return result;

    // Structural estimates can be exceeded by truncation markers. Apply a final,
    // explicit safety clamp instead of allowing the product projection to grow.
    return truncateProjection(result, limit, {
        label: '同步内容',
        preserveTail: false,
    });
}

function entryLabel(role) {
    if (role === 'assistant') return '💬 角色：';
    if (role === 'older') return '🕘 较早轮次：';
    return '🖥️ 你：';
}

function allocateBudgets(entries, total, assistantWeight) {
    const weights = entries.map(entry => {
        if (entry.role === 'assistant') return assistantWeight;
        if (entry.role === 'older') return 1;
        return 1;
    });
    const budgets = Array(entries.length).fill(0);
    const active = new Set(entries.map((_, index) => index));
    let remaining = total;

    while (active.size > 0) {
        const weightTotal = [...active].reduce((sum, index) => sum + weights[index], 0);
        let fixedAny = false;
        for (const index of [...active]) {
            const share = Math.max(48, Math.floor(remaining * weights[index] / weightTotal));
            const needed = projectionCost(entries[index].content);
            if (needed <= share) {
                budgets[index] = needed;
                remaining -= needed;
                active.delete(index);
                fixedAny = true;
            }
        }
        if (fixedAny) continue;
        for (const index of active) {
            budgets[index] = Math.max(48, Math.floor(remaining * weights[index] / weightTotal));
        }
        break;
    }
    return budgets;
}

function truncateProjection(value, limit, { label, preserveTail }) {
    const input = String(value || '').trim();
    if (projectionCost(input) <= limit) return input;
    const originalLength = visibleLength(input);
    const prepared = replaceFencedCode(input);
    if (projectionCost(prepared) <= limit) return prepared;

    const marker = `…（${label}已截断，原文 ${originalLength} 字；完整内容请在酒馆查看）`;
    const separatorCost = preserveTail ? 4 : 1;
    let available = Math.max(1, limit - projectionCost(marker) - separatorCost);
    let output = buildTruncatedProjection(prepared, marker, available, preserveTail);
    while (projectionCost(output) > limit && available > 1) {
        available = Math.max(1, available - (projectionCost(output) - limit) - 1);
        output = buildTruncatedProjection(prepared, marker, available, preserveTail);
    }
    return output;
}

function buildTruncatedProjection(value, marker, available, preserveTail) {
    if (preserveTail && available >= 120) {
        const headBudget = Math.floor(available * 0.7);
        const tailBudget = available - headBudget;
        return `${sliceNatural(value, headBudget)}\n\n${marker}\n\n${sliceNaturalTail(value, tailBudget)}`;
    }
    return `${sliceNatural(value, available)}\n${marker}`;
}

function replaceFencedCode(value) {
    const text = String(value || '');
    let replaced = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (block, language, body) => {
        const lines = body ? body.split(/\r?\n/).length : 0;
        const kind = language.trim() ? ` ${language.trim()}` : '';
        return `[${kind} 代码块已省略，共 ${lines} 行、${visibleLength(block)} 字，请在酒馆查看]`;
    });
    const fences = replaced.match(/```/g)?.length || 0;
    if (fences % 2 === 1) {
        replaced = replaced.replace(/```[^\n]*(?:\n[\s\S]*)?$/, match => {
            const lines = match.split(/\r?\n/).length;
            return `[未闭合代码块已省略，共 ${lines} 行、${visibleLength(match)} 字，请在酒馆查看]`;
        });
    }
    return replaced;
}

function sliceNatural(value, limit) {
    const prefix = takeByCost(value, limit, false);
    if (prefix.length === String(value || '').length) return prefix;
    const minimum = Math.floor(prefix.length * 0.5);
    const candidates = [
        prefix.lastIndexOf('\n\n'),
        prefix.lastIndexOf('\n'),
        lastMatchEnd(prefix, /[。！？.!?；;]\s*/g),
        lastMatchEnd(prefix, /[，,]\s*/g),
        lastMatchEnd(prefix, /\s+/g),
    ];
    const boundary = candidates.find(index => index >= minimum);
    return (boundary ? prefix.slice(0, boundary) : prefix).trim();
}

function sliceNaturalTail(value, limit) {
    return takeByCost(value, limit, true).trim();
}

function takeByCost(value, limit, fromEnd) {
    const graphemes = toGraphemes(value);
    const selected = [];
    let used = 0;
    const sequence = fromEnd ? [...graphemes].reverse() : graphemes;
    for (const grapheme of sequence) {
        const cost = Math.max(1, grapheme.length);
        if (used + cost > limit) break;
        selected.push(grapheme);
        used += cost;
    }
    if (fromEnd) selected.reverse();
    return selected.join('');
}

function toGraphemes(value) {
    const text = String(value || '');
    if (!graphemeSegmenter) return Array.from(text);
    return [...graphemeSegmenter.segment(text)].map(item => item.segment);
}

function lastMatchEnd(text, pattern) {
    let end = -1;
    for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
    return end;
}
