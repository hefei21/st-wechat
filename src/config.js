/**
 * config.js - 从 SillyTavern 数据目录加载配置
 *
 * 本插件随 SillyTavern 运行，位于 plugins/st-wechat/ 下。
 * 酒馆数据在 data/default-user/ 下。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let _cache = null;
let _pluginDir = null;
let _stDataDir = null;
let _pluginConfig = null;   // 插件自己的 config.yaml（用于模型名覆盖）

/**
 * 获取插件目录（绝对路径）
 */
function getPluginDir() {
    if (_pluginDir) return _pluginDir;
    try {
        const filePath = fileURLToPath(import.meta.url);
        _pluginDir = path.resolve(path.dirname(filePath), '..');
    } catch (err) {
        _pluginDir = process.cwd();
    }
    return _pluginDir;
}

/**
 * 读取插件自己的 config.yaml（极简解析，不引入 yaml 依赖）
 */
function loadPluginConfig() {
    if (_pluginConfig) return _pluginConfig;
    try {
        const filePath = path.join(getPluginDir(), 'config.yaml');
        const raw = fs.readFileSync(filePath, 'utf-8');
        const config = {};
        for (const line of raw.split('\n')) {
            const m = line.match(/^\s*([a-zA-Z_]\w*)\s*:\s*(.+?)\s*$/);
            if (m) {
                const val = m[2].replace(/^["']|["']$/g, '').trim();
                config[m[1]] = val;
            }
        }
        _pluginConfig = config;
    } catch {
        _pluginConfig = {};
    }
    return _pluginConfig;
}

/**
 * 获取 ST 数据目录
 */
function getStDataDir() {
    if (_stDataDir) return _stDataDir;
    const pluginDir = getPluginDir();
    // 插件在 ST/plugins/st-wechat/ 下，数据在 ST/data/default-user/
    _stDataDir = path.resolve(pluginDir, '..', '..', 'data', 'default-user');
    return _stDataDir;
}

/**
 * 加载并缓存所有 ST 配置
 */
export function load() {
    if (_cache) return _cache;

    const stDataDir = getStDataDir();
    const settings = readJSON(path.join(stDataDir, 'settings.json')) || {};
    const secrets = readJSON(path.join(stDataDir, 'secrets.json')) || {};

    // --- LLM 配置 ---
    // ST 将 OpenAI 兼容 API 的配置保存在预设文件中（不在 settings.json 顶层）
    // 目录: data/default-user/OpenAI Settings/
    // 文件: Default.json (或自定义名称)
    // 字段: { openai_model, openai_endpoint, openai_source, ... }
    const openaiPreset = readOpenAIPreset(stDataDir, settings);

    // settings.json 本身也可能直接包含 custom_url / custom_model
    const isCustom = settings.chat_completion_source === 'custom';
    const customEndpoint = isCustom ? (settings.custom_url || '') : '';
    const customModel = isCustom ? (settings.custom_model || '') : '';

    const llm = {
        endpoint: openaiPreset.endpoint || customEndpoint || 'https://api.openai.com/v1',
        model: openaiPreset.model || customModel || 'gpt-4o-mini',
        apiKey: null,
        temperature: settings.temperature ?? 0.9,
        maxContext: openaiPreset.maxContext || settings.max_context || 4096,
    };

    // 如果预设文件指定了密钥来源（如 "openai"、"custom"），按来源查询
    const sourceHint = openaiPreset.source || '';
    llm.apiKey = resolveSecret(secrets, { id: sourceHint });

    // 插件 config.yaml 中手动指定的端点和模型名优先（解决 ST 不保存的问题）
    const pc = loadPluginConfig();
    if (pc.endpoint) {
        llm.endpoint = pc.endpoint;
        console.log('[Config] 端点覆盖（来自 config.yaml）:', pc.endpoint);
    }
    if (pc.model) {
        llm.model = pc.model;
        console.log('[Config] 模型名覆盖（来自 config.yaml）:', pc.model);
    }

    // --- 提示词模板 ---
    const prompts = {
        systemPrompt: readTemplate(stDataDir, 'sysprompt', settings.system_prompt) ||
                       readTemplate(stDataDir, 'sysprompt', 'default.txt'),
        contextTemplate: readTemplate(stDataDir, 'context', settings.context) ||
                         readTemplate(stDataDir, 'context', 'default.txt'),
        instructTemplate: readTemplate(stDataDir, 'instruct', settings.instruct) ||
                          readTemplate(stDataDir, 'instruct', 'default.txt'),
    };

    // --- 用户设定 ---
    const persona = getActivePersona(settings);

    // --- 路径 ---
    const worldsDir = path.join(stDataDir, 'worlds');
    const charactersDir = path.join(stDataDir, 'characters');
    const chatsDir = path.join(stDataDir, 'chats');

    _cache = {
        llm,
        prompts,
        persona,
        username: settings.username || 'You',
        worldsDir,
        charactersDir,
        chatsDir,
        settings,
        secrets,
    };

    return _cache;
}

/**
 * 清除缓存
 */
export function reload() {
    _cache = null;
    return load();
}

/**
 * 读取模板文件（指定目录 + 默认文件名）
 */
function readTemplate(stDataDir, dirName, fileName) {
    if (!fileName) return null;
    const filePath = path.join(stDataDir, dirName, fileName);
    return readText(filePath);
}

/**
 * 根据 source 信息查找 API 密钥
 */
function resolveSecret(secrets, apiSource) {
    if (!apiSource) return null;

    const sourceType = (apiSource.id || apiSource.type || '').toLowerCase();
    const sourceName = (apiSource.name || '').toLowerCase();
    const keyMap = {
        'openai': 'api_key_openai',
        'claude': 'api_key_claude',
        'openrouter': 'api_key_openrouter',
        'deepseek': 'api_key_deepseek',
        'google': 'api_key_makersuite',
        'makersuite': 'api_key_makersuite',
        'mistral': 'api_key_mistralai',
        'mistralai': 'api_key_mistralai',
        'custom': 'api_key_custom',
        'ollama': 'api_key_ollama',
        'groq': 'api_key_groq',
        'perplexity': 'api_key_perplexity',
    };

    // 优先按类型匹配
    let keyName = null;
    for (const [k, v] of Object.entries(keyMap)) {
        if (sourceType.includes(k) || sourceName.includes(k)) { keyName = v; break; }
    }

    if (keyName) {
        const val = secrets[keyName];
        const result = extractSecretValue(val);
        if (result) return result;
    }

    // 对自定义 / OpenAI 兼容端点：按域名启发式匹配
    const endpoint = (apiSource.url || apiSource.endpoint || '').toLowerCase();
    for (const [k, v] of Object.entries(keyMap)) {
        if (endpoint.includes(k)) {
            const result = extractSecretValue(secrets[v]);
            if (result) return result;
        }
    }

    // 回退：任意非空密钥
    for (const keyName of Object.values(keyMap)) {
        const val = secrets[keyName];
        const result = extractSecretValue(val);
        if (result) return result;
    }

    return null;
}

function extractSecretValue(val) {
    if (!val) return null;
    if (Array.isArray(val)) {
        const active = val.find(v => v.active);
        return active?.value || val[0]?.value || null;
    }
    return typeof val === 'string' ? val : val.value || null;
}

/**
 * 获取当前激活的 persona
 */
function getActivePersona(settings) {
    const personas = settings.personas || {};
    const name = settings.persona;

    if (name && personas[name]) {
        const data = personas[name];
        return {
            name: name,
            description: typeof data === 'string' ? data : (data.description || ''),
        };
    }

    return { name: settings.username || 'You', description: '' };
}

// --- 工具 ---

function readJSON(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function readText(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
        return null;
    }
}

/**
 * 从 ST 的 OpenAI Settings 预设文件中读取模型和端点
 *
 * ST 1.16.0 将 API 连接配置保存在预设文件中：
 *   data/default-user/OpenAI Settings/<presetName>.json
 *
 * 文件格式（可能是对象数组或单个对象）：
 *   [{ openai_model: "deepseek-chat", openai_endpoint: "...", openai_source: "openai", ... }]
 */
function readOpenAIPreset(stDataDir, settings) {
    try {
        const presetName = settings.openai_settings || 'Default';
        const presetDir = path.join(stDataDir, 'OpenAI Settings');
        const presetPath = path.join(presetDir, `${presetName}.json`);

        if (!fs.existsSync(presetPath)) {
            console.warn(`[Config] 预设文件不存在: ${presetPath}`);
            return {};
        }

        const preset = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
        // ST 的预设文件可能是数组（多个配置）或对象
        const entries = Array.isArray(preset) ? preset : [preset];
        // 取第一个有效的
        const entry = entries[0] || {};

        const result = {
            endpoint: entry.openai_endpoint || entry.api_url || '',
            model: entry.openai_model || entry.model || '',
            source: entry.openai_source || entry.source || '',
            maxContext: entry.openai_max_context || entry.max_context || 0,
        };

        console.log('[Config] OpenAI 预设读取:', JSON.stringify(result, null, 2));
        return result;
    } catch (err) {
        console.warn('[Config] 读取 OpenAI 预设失败:', err.message);
        return {};
    }
}

export function getStDataDirInfo() {
    return {
        pluginDir: getPluginDir(),
        stDataDir: getStDataDir(),
    };
}
