/**
 * worldbook.js - 受控的 SillyTavern 世界书加载与匹配
 *
 * 所有文件会建立索引，但只有以下内容参与当前角色匹配：
 * - settings 中明确选择的全局世界书；
 * - 角色卡 extensions.world 指向的世界书；
 * - 角色卡 character_book 中的内嵌条目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('WorldBook');
const warnedUnsupportedFields = new Set();

export class WorldBook {
    constructor(worldsDir, options = {}) {
        this.worldsDir = worldsDir;
        this.globalBooks = normalizeNames(options.globalBooks || []);
        this.tokenBudget = positiveNumber(options.tokenBudget, 0);
        this.random = typeof options.random === 'function' ? options.random : Math.random;
        this.books = new Map();
        this.refresh();
    }

    refresh() {
        this.books.clear();
        if (!fs.existsSync(this.worldsDir)) return;

        const files = fs.readdirSync(this.worldsDir).filter(file => file.toLowerCase().endsWith('.json'));
        for (const file of files) {
            try {
                const world = JSON.parse(fs.readFileSync(path.join(this.worldsDir, file), 'utf8'));
                const name = path.basename(file, path.extname(file));
                this.books.set(name, normalizeEntries(world.entries, name));
            } catch (error) {
                logger.warn(`跳过无法解析的世界书 ${file}: ${error.message}`);
            }
        }
    }

    match(contextText, options = {}) {
        const entries = this.getActiveEntries(options.character);
        const matched = [];

        for (const entry of entries) {
            if (!shouldActivate(entry, contextText)) continue;
            if (entry.useProbability && this.random() * 100 >= entry.probability) continue;
            matched.push(entry);
        }

        matched.sort((a, b) => a.order - b.order);
        const budgeted = applyBudget(matched, options.tokenBudget ?? this.tokenBudget);
        const before = [];
        const after = [];
        for (const entry of budgeted) this.addEntry(entry, before, after);

        return {
            before: before.join('\n'),
            after: after.join('\n'),
            activated: budgeted.map(entry => ({ id: entry.id, book: entry.book })),
        };
    }

    getActiveEntries(character) {
        const charData = character?.data || character || {};
        const requestedBooks = new Set(this.globalBooks);

        const boundWorld = charData.extensions?.world;
        for (const name of normalizeNames(boundWorld ? [boundWorld] : [])) requestedBooks.add(name);

        const entries = [];
        for (const name of requestedBooks) {
            const bookEntries = findBookCaseInsensitive(this.books, name);
            if (bookEntries) entries.push(...bookEntries);
            else logger.debug(`角色或全局绑定的世界书不存在: ${name}`);
        }

        if (charData.character_book?.entries) {
            entries.push(...normalizeEntries(charData.character_book.entries, `character:${charData.name || 'unknown'}`));
        }
        return entries;
    }

    addEntry(entry, before, after) {
        // 保留现有 prompt-builder 的 before/after 双区结构。
        // position=1 或 depth>4 进入 after，其余进入 before。
        if (entry.position === 1 || entry.depth > 4) after.push(entry.content);
        else before.push(entry.content);
    }

    getCount(character) {
        return this.getActiveEntries(character).length;
    }
}

export function normalizeEntries(rawEntries, book = 'unknown') {
    const values = Array.isArray(rawEntries)
        ? rawEntries
        : Object.values(rawEntries || {});
    const normalized = [];

    for (const entry of values) {
        if (!entry || entry.enabled === false || entry.disable === true) continue;
        warnUnsupportedEntryFields(entry, book);
        const constant = entry.constant === true;
        normalized.push({
            id: entry.id ?? entry.uid ?? `${book}:${normalized.length}`,
            book,
            keys: normalizeKeys(entry.keys ?? entry.key),
            secondaryKeys: normalizeKeys(
                entry.secondary_keys
                ?? entry.keysecondary
                ?? entry.secondaryKeys
            ),
            content: String(entry.content || '').trim(),
            constant,
            selective: entry.selective === true,
            selectiveLogic: normalizeSelectiveLogic(entry.selectiveLogic ?? entry.selective_logic),
            caseSensitive: entry.case_sensitive ?? entry.caseSensitive ?? false,
            matchWholeWords: entry.match_whole_words ?? entry.matchWholeWords ?? false,
            depth: numberOr(entry.depth, constant ? 0 : 4),
            position: numberOr(entry.position, 0),
            order: numberOr(entry.order ?? entry.insertion_order, 100),
            scanDepth: positiveNumber(entry.scanDepth ?? entry.scan_depth, 0),
            useProbability: entry.useProbability ?? entry.use_probability ?? false,
            probability: clamp(numberOr(entry.probability, 100), 0, 100),
        });
    }
    return normalized;
}

function warnUnsupportedEntryFields(entry, book) {
    const unsupported = [
        'group',
        'group_override',
        'group_weight',
        'sticky',
        'cooldown',
        'delay',
        'vectorized',
        'recursion',
        'outlet',
        'regex',
    ].filter(field => entry[field] !== undefined && entry[field] !== false && entry[field] !== '');

    for (const field of unsupported) {
        const warningKey = `${book}:${field}`;
        if (warnedUnsupportedFields.has(warningKey)) continue;
        warnedUnsupportedFields.add(warningKey);
        logger.warn(`世界书 ${book} 使用尚未完整兼容的字段: ${field}`);
    }
}

function shouldActivate(entry, contextText) {
    if (!entry.content) return false;
    if (entry.constant) return true;
    if (entry.keys.length === 0) return false;

    const context = scanContext(String(contextText || ''), entry.scanDepth);
    const primaryMatched = entry.keys.some(key => includesKey(context, key, entry));
    if (!primaryMatched) return false;
    if (!entry.selective || entry.secondaryKeys.length === 0) return true;

    const matches = entry.secondaryKeys.map(key => includesKey(context, key, entry));
    switch (entry.selectiveLogic) {
        case 'and_all': return matches.every(Boolean);
        case 'not_any': return matches.every(value => !value);
        case 'not_all': return !matches.every(Boolean);
        case 'and_any':
        default: return matches.some(Boolean);
    }
}

function includesKey(context, key, entry) {
    if (!key) return false;
    if (entry.matchWholeWords) {
        const flags = entry.caseSensitive ? 'u' : 'iu';
        const expression = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(key)}(?=$|[^\\p{L}\\p{N}_])`, flags);
        return expression.test(context);
    }
    if (entry.caseSensitive) return context.includes(key);
    return context.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

function applyBudget(entries, tokenBudget) {
    const budget = positiveNumber(tokenBudget, 0);
    if (!budget) return entries;

    const maxChars = budget * 4;
    const selected = [];
    let used = 0;
    // 高 order 更接近上下文末尾，也应优先保留。
    for (const entry of [...entries].sort((a, b) => b.order - a.order)) {
        const cost = entry.content.length;
        if (used + cost > maxChars) continue;
        selected.push(entry);
        used += cost;
    }
    return selected.sort((a, b) => a.order - b.order);
}

function scanContext(context, depth) {
    if (!depth) return context;
    return context.split('\n').slice(-depth).join('\n');
}

function normalizeSelectiveLogic(value) {
    const numeric = Number(value);
    if (Number.isInteger(numeric)) {
        return ['and_any', 'not_all', 'not_any', 'and_all'][numeric] || 'and_any';
    }
    const normalized = String(value || 'and_any').toLowerCase().replace(/\s+/g, '_');
    const aliases = {
        any: 'and_any',
        all: 'and_all',
        andany: 'and_any',
        andall: 'and_all',
        notany: 'not_any',
        notall: 'not_all',
    };
    return aliases[normalized] || normalized;
}

function normalizeKeys(value) {
    const values = Array.isArray(value) ? value : (value ? [value] : []);
    return values.map(String).map(key => key.trim()).filter(Boolean);
}

function normalizeNames(values) {
    const list = Array.isArray(values) ? values : [values];
    return list
        .flatMap(value => typeof value === 'string' ? value.split(',') : [])
        .map(value => path.basename(value.trim(), path.extname(value.trim())))
        .filter(Boolean);
}

function findBookCaseInsensitive(books, requestedName) {
    if (books.has(requestedName)) return books.get(requestedName);
    const lower = requestedName.toLocaleLowerCase();
    for (const [name, entries] of books) {
        if (name.toLocaleLowerCase() === lower) return entries;
    }
    return null;
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
