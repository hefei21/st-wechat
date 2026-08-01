/**
 * config.js - SillyTavern 与插件配置加载
 *
 * 配置解析规则：
 * 1. auto 模式跟随 ST 当前来源、模型、生成参数和精确密钥槽。
 * 2. override 模式使用 config.yaml 的完整连接与生成配置。
 * 3. 根据最终 endpoint/model/source 推导传输适配器。
 * 4. 密钥不跨槽位或服务商回退。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const logger = createLogger('Config');
const DEFAULT_DATA_ROOT = '../../data/default-user';
const DEFAULT_LLM = Object.freeze({
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    temperature: 0.9,
    thinking: 'disabled',
    maxOutputTokens: 1200,
    maxContextTokens: 64000,
    charsPerToken: 3,
    requestTimeoutMs: 90000,
});
const MAX_OUTPUT_TOKENS = 65536;
const MAX_CONTEXT_TOKENS = 2000000;
const SOURCE_PROFILES = Object.freeze({
    openai: {
        provider: 'openai', endpoint: 'https://api.openai.com/v1', modelKey: 'openai_model', secretSource: 'openai',
    },
    claude: {
        provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', modelKey: 'claude_model', secretSource: 'anthropic',
    },
    openrouter: {
        provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', modelKey: 'openrouter_model', secretSource: 'openrouter',
    },
    makersuite: {
        provider: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', modelKey: 'google_model', secretSource: 'gemini',
    },
    mistralai: {
        provider: 'mistral', endpoint: 'https://api.mistral.ai/v1', modelKey: 'mistralai_model', secretSource: 'mistral',
    },
    groq: {
        provider: 'groq', endpoint: 'https://api.groq.com/openai/v1', modelKey: 'groq_model', secretSource: 'groq',
    },
    deepseek: {
        provider: 'deepseek', endpoint: 'https://api.deepseek.com', modelKey: 'deepseek_model', secretSource: 'deepseek',
    },
});

let _cache = null;
let _pluginDir = null;
let _stDataDir = null;
let _pluginConfig = null;

function getPluginDir() {
    if (_pluginDir) return _pluginDir;
    try {
        _pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    } catch {
        _pluginDir = process.cwd();
    }
    return _pluginDir;
}

export function parseSimpleYaml(raw) {
    const config = {};
    for (const originalLine of String(raw || '').split(/\r?\n/)) {
        const line = originalLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = originalLine.match(/^\s*([a-zA-Z_]\w*)\s*:\s*(.*?)\s*$/);
        if (!match) continue;
        const rawValue = stripInlineComment(match[2]).trim();
        config[match[1]] = parseScalar(rawValue);
    }
    return config;
}

function stripInlineComment(value) {
    let quote = null;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
            quote = quote === char ? null : (quote || char);
        }
        if (char === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
            return value.slice(0, i);
        }
    }
    return value;
}

function parseScalar(value) {
    if (value === '') return '';
    const unquoted = value.replace(/^(['"])(.*)\1$/, '$2');
    if (/^(true|false)$/i.test(unquoted)) return unquoted.toLowerCase() === 'true';
    if (/^(null|~)$/i.test(unquoted)) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted);
    return unquoted;
}

function loadPluginConfig() {
    if (_pluginConfig) return _pluginConfig;
    try {
        const filePath = path.join(getPluginDir(), 'config.yaml');
        _pluginConfig = parseSimpleYaml(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn('读取 config.yaml 失败，将使用自动检测配置:', error.message);
        _pluginConfig = {};
    }
    return _pluginConfig;
}

export function resolveDataRoot(pluginDir, configuredRoot = DEFAULT_DATA_ROOT) {
    const stRoot = path.resolve(pluginDir, '..', '..');
    const candidate = path.isAbsolute(configuredRoot)
        ? path.resolve(configuredRoot)
        : path.resolve(pluginDir, configuredRoot);

    if (!isPathInside(stRoot, candidate)) {
        throw new Error(`dataRoot 必须位于 SillyTavern 根目录内: ${candidate}`);
    }
    return candidate;
}

function getStDataDir() {
    if (_stDataDir) return _stDataDir;
    const pluginConfig = loadPluginConfig();
    _stDataDir = resolveDataRoot(getPluginDir(), pluginConfig.dataRoot || DEFAULT_DATA_ROOT);
    return _stDataDir;
}

export function load() {
    if (_cache) return _cache;

    const stDataDir = getStDataDir();
    const settings = readJSON(path.join(stDataDir, 'settings.json')) || {};
    const secrets = readJSON(path.join(stDataDir, 'secrets.json')) || {};
    const chatCompletionSettings = selectChatCompletionSettings(settings);
    const preset = readOpenAIPreset(stDataDir, chatCompletionSettings);
    const pluginConfig = loadPluginConfig();

    const llm = buildLlmConfig({ pluginConfig, preset, settings: chatCompletionSettings, secrets });
    // 兼容旧调用方；新代码应使用 maxContextTokens。
    llm.maxContext = llm.maxContextTokens;

    const prompts = {
        systemPrompt: readTemplate(stDataDir, 'sysprompt', settings.system_prompt)
            || readTemplate(stDataDir, 'sysprompt', 'default.txt'),
        contextTemplate: readTemplate(stDataDir, 'context', settings.context)
            || readTemplate(stDataDir, 'context', 'default.txt'),
        instructTemplate: readTemplate(stDataDir, 'instruct', settings.instruct)
            || readTemplate(stDataDir, 'instruct', 'default.txt'),
    };

    const globalWorldBooks = normalizeStringList(
        settings.world_info?.globalSelect
        || settings.world_info?.global_select
        || settings.world_info_global_select
        || []
    );

    _cache = {
        llm,
        prompts,
        dataRoot: stDataDir,
        persona: getActivePersona(settings),
        username: settings.username || 'You',
        worldsDir: path.join(stDataDir, 'worlds'),
        charactersDir: path.join(stDataDir, 'characters'),
        chatsDir: path.join(stDataDir, 'chats'),
        globalWorldBooks,
        worldInfoBudgetTokens: positiveIntegerOrZero(
            pluginConfig.worldInfoBudgetTokens,
            settings.world_info_budget_cap,
            0
        ),
        maxQueuedMessages: positiveInteger(pluginConfig.maxQueuedMessages, 20),
        syncMode: enumValue(pluginConfig.syncMode, ['off', 'notify', 'full'], 'notify'),
        settings,
    };

    logger.info(`LLM: ${llm.provider}/${llm.model} @ ${llm.endpoint}`);
    logger.info(`dataRoot: ${stDataDir}`);
    return _cache;
}

export function reload() {
    _cache = null;
    _stDataDir = null;
    _pluginConfig = null;
    return load();
}

export function detectProvider({ explicit, endpoint = '', model = '', source = '' }) {
    const requested = String(explicit || '').trim().toLowerCase();
    if (requested) return normalizeProvider(requested);

    const haystack = `${endpoint} ${model} ${source}`.toLowerCase();
    if (haystack.includes('deepseek')) return 'deepseek';
    if (haystack.includes('anthropic') || haystack.includes('claude')) return 'anthropic';
    if (haystack.includes('generativelanguage') || haystack.includes('googleapis') || haystack.includes('gemini')) {
        return 'gemini';
    }
    if (haystack.includes('openrouter')) return 'openrouter';
    if (haystack.includes('groq')) return 'groq';
    if (haystack.includes('mistral')) return 'mistral';
    if (haystack.includes('ollama')) return 'ollama';
    if (haystack.includes('openai')) return 'openai';
    return source === 'custom' ? 'custom' : 'openai';
}

export function buildLlmConfig({ pluginConfig = {}, preset = {}, settings = {}, secrets = {} }) {
    const configurationMode = enumValue(
        pluginConfig.configurationMode,
        ['auto', 'override'],
        'auto'
    );
    const connection = configurationMode === 'override'
        ? resolveOverrideConnection(pluginConfig)
        : resolveAutomaticConnection(settings, preset);
    const generation = configurationMode === 'override'
        ? {
            temperature: firstFinite(pluginConfig.temperature, DEFAULT_LLM.temperature),
            maxOutputTokens: boundedPositiveInteger(
                MAX_OUTPUT_TOKENS,
                pluginConfig.maxOutputTokens,
                DEFAULT_LLM.maxOutputTokens
            ),
            maxContextTokens: boundedPositiveInteger(
                MAX_CONTEXT_TOKENS,
                pluginConfig.maxContextTokens,
                DEFAULT_LLM.maxContextTokens
            ),
        }
        : {
            temperature: firstFinite(
                settings.temp_openai,
                settings.temperature,
                preset.temperature,
                DEFAULT_LLM.temperature
            ),
            maxOutputTokens: boundedPositiveInteger(
                MAX_OUTPUT_TOKENS,
                settings.openai_max_tokens,
                settings.amount_gen,
                preset.maxOutputTokens,
                DEFAULT_LLM.maxOutputTokens
            ),
            maxContextTokens: boundedPositiveInteger(
                MAX_CONTEXT_TOKENS,
                settings.openai_max_context,
                preset.maxContext,
                settings.max_context,
                DEFAULT_LLM.maxContextTokens
            ),
        };

    return {
        configurationMode,
        source: connection.source,
        provider: connection.provider,
        endpoint: connection.endpoint,
        model: connection.model,
        secretSource: connection.secretSource,
        apiKey: resolveSecret(secrets, connection.provider, connection.secretSource),
        temperature: generation.temperature,
        thinking: normalizeThinking(pluginConfig.thinking ?? DEFAULT_LLM.thinking),
        maxOutputTokens: generation.maxOutputTokens,
        maxContextTokens: generation.maxContextTokens,
        charsPerToken: positiveNumber(
            pluginConfig.charsPerToken,
            DEFAULT_LLM.charsPerToken
        ),
        requestTimeoutMs: positiveInteger(
            pluginConfig.requestTimeoutMs,
            DEFAULT_LLM.requestTimeoutMs
        ),
    };
}

function resolveAutomaticConnection(settings, preset) {
    const source = firstString(
        settings.chat_completion_source,
        preset.source,
        DEFAULT_LLM.provider
    ).toLowerCase();

    if (source === 'custom') {
        const endpoint = firstString(settings.custom_url, preset.endpoint, DEFAULT_LLM.endpoint);
        const model = firstString(settings.custom_model, preset.model, DEFAULT_LLM.model);
        return {
            source,
            provider: detectProvider({ endpoint, model, source }),
            endpoint,
            model,
            secretSource: 'custom',
        };
    }

    const profile = SOURCE_PROFILES[source];
    const endpoint = firstString(profile?.endpoint, preset.endpoint, DEFAULT_LLM.endpoint);
    const model = firstString(
        profile?.modelKey ? settings[profile.modelKey] : '',
        preset.model,
        DEFAULT_LLM.model
    );
    const provider = profile?.provider || detectProvider({ endpoint, model, source });
    return {
        source,
        provider,
        endpoint,
        model,
        secretSource: profile?.secretSource || normalizeProvider(source || provider),
    };
}

function resolveOverrideConnection(pluginConfig) {
    const provider = firstString(pluginConfig.provider);
    const endpoint = firstString(pluginConfig.endpoint);
    const model = firstString(pluginConfig.model);
    if (!provider || !endpoint || !model) {
        throw new Error('configurationMode: override 需要同时配置 provider、endpoint 和 model');
    }
    const normalizedProvider = detectProvider({ explicit: provider, endpoint, model });
    return {
        source: 'override',
        provider: normalizedProvider,
        endpoint,
        model,
        secretSource: firstString(pluginConfig.secretSource, normalizedProvider),
    };
}

export function selectChatCompletionSettings(settings = {}) {
    const nested = settings?.oai_settings;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : settings;
}

function normalizeProvider(provider) {
    const aliases = {
        claude: 'anthropic',
        google: 'gemini',
        makersuite: 'gemini',
        mistralai: 'mistral',
    };
    return aliases[provider] || provider;
}

export function resolveSecret(secrets, provider, explicitSource) {
    const keyMap = {
        openai: ['api_key_openai'],
        deepseek: ['api_key_deepseek'],
        anthropic: ['api_key_claude'],
        gemini: ['api_key_makersuite'],
        openrouter: ['api_key_openrouter'],
        mistral: ['api_key_mistralai'],
        groq: ['api_key_groq'],
        ollama: ['api_key_ollama'],
        perplexity: ['api_key_perplexity'],
        custom: ['api_key_custom'],
    };

    const secretProvider = explicitSource ? normalizeProvider(String(explicitSource).toLowerCase()) : provider;
    for (const keyName of keyMap[normalizeProvider(secretProvider)] || []) {
        const secret = extractSecretValue(secrets?.[keyName]);
        if (secret) return secret;
    }
    return null;
}

function extractSecretValue(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
        const active = value.find(item => item?.active);
        return active?.value || value.find(item => item?.value)?.value || null;
    }
    if (typeof value === 'string') return value;
    return value.value || null;
}

function normalizeThinking(value) {
    if (value === true) return 'enabled';
    if (value === false) return 'disabled';
    const normalized = String(value || '').toLowerCase();
    return ['enabled', 'on', 'true'].includes(normalized) ? 'enabled' : 'disabled';
}

function readTemplate(stDataDir, dirName, fileName) {
    if (!fileName) return null;
    return readText(path.join(stDataDir, dirName, path.basename(String(fileName))));
}

function getActivePersona(settings) {
    const personas = settings.personas || {};
    const name = settings.persona;
    if (name && personas[name]) {
        const data = personas[name];
        return {
            name,
            description: typeof data === 'string' ? data : (data.description || ''),
        };
    }
    return { name: settings.username || 'You', description: '' };
}

function readOpenAIPreset(stDataDir, settings) {
    try {
        const presetName = path.basename(String(
            settings.preset_settings_openai || settings.openai_settings || 'Default'
        ));
        const presetPath = path.join(stDataDir, 'OpenAI Settings', `${presetName}.json`);
        if (!fs.existsSync(presetPath)) return {};

        const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
        const entry = (Array.isArray(preset) ? preset : [preset])[0] || {};
        return normalizeOpenAIPreset(entry);
    } catch (error) {
        logger.warn('读取 OpenAI 预设失败:', error.message);
        return {};
    }
}

function readJSON(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn(`JSON 读取失败: ${path.basename(filePath)} - ${error.message}`);
        return null;
    }
}

function readText(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return null;
    }
}

function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === ''
        || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function firstFinite(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return 0;
}

function positiveInteger(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return Math.floor(number);
    }
    return 1;
}

function optionalFinite(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return undefined;
}

function optionalPositiveInteger(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return Math.floor(number);
    }
    return undefined;
}

export function normalizeOpenAIPreset(entry = {}) {
    const source = firstString(
        entry.chat_completion_source,
        entry.openai_source,
        entry.source
    ).toLowerCase();
    const profile = SOURCE_PROFILES[source];
    return {
        endpoint: source === 'custom'
            ? firstString(entry.custom_url, entry.openai_endpoint, entry.api_url)
            : firstString(entry.openai_endpoint, entry.api_url),
        model: source === 'custom'
            ? firstString(entry.custom_model, entry.model)
            : firstString(profile?.modelKey ? entry[profile.modelKey] : '', entry.openai_model, entry.model),
        source,
        temperature: optionalFinite(entry.temp_openai, entry.temperature),
        maxOutputTokens: optionalPositiveInteger(entry.openai_max_tokens),
        maxContext: optionalPositiveInteger(entry.openai_max_context, entry.max_context),
    };
}

function boundedPositiveInteger(maximum, ...values) {
    return Math.min(maximum, positiveInteger(...values));
}

function positiveNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return 1;
}

function positiveIntegerOrZero(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return Math.floor(number);
    }
    return 0;
}

function normalizeStringList(value) {
    if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}

function enumValue(value, allowed, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
}

export function getStDataDirInfo() {
    return {
        pluginDir: getPluginDir(),
        stDataDir: getStDataDir(),
    };
}
