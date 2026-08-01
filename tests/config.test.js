import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    buildLlmConfig,
    detectProvider,
    normalizeOpenAIPreset,
    parseSimpleYaml,
    resolveDataRoot,
    resolveSecret,
    selectChatCompletionSettings,
} from '../src/config.js';

test('parseSimpleYaml preserves scalar types', () => {
    const parsed = parseSimpleYaml(`
configurationMode: auto
provider: deepseek
thinking: false
temperature: 0.9
maxOutputTokens: 1200
charsPerToken: 2.5
endpoint: "https://api.deepseek.com" # comment
`);
    assert.deepEqual(parsed, {
        configurationMode: 'auto',
        provider: 'deepseek',
        thinking: false,
        temperature: 0.9,
        maxOutputTokens: 1200,
        charsPerToken: 2.5,
        endpoint: 'https://api.deepseek.com',
    });
});

test('detectProvider uses the final endpoint and explicit provider', () => {
    assert.equal(detectProvider({ endpoint: 'https://api.deepseek.com' }), 'deepseek');
    assert.equal(detectProvider({ explicit: 'claude', endpoint: 'https://example.com' }), 'anthropic');
    assert.equal(detectProvider({ source: 'custom', endpoint: 'https://example.com' }), 'custom');
});

test('resolveSecret never falls back to another provider key', () => {
    const secrets = {
        api_key_openai: [{ value: 'openai-key', active: true }],
        api_key_deepseek: [{ value: 'deepseek-key', active: true }],
    };
    assert.equal(resolveSecret(secrets, 'deepseek'), 'deepseek-key');
    assert.equal(resolveSecret({ api_key_openai: 'openai-key' }, 'deepseek'), null);
});

test('final DeepSeek override selects only the matching key after preset resolution', () => {
    const result = buildLlmConfig({
        pluginConfig: {
            configurationMode: 'override',
            provider: 'deepseek',
            endpoint: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            thinking: false,
        },
        preset: {
            endpoint: 'https://api.openai.com/v1',
            model: 'gpt-example',
            source: 'openai',
        },
        settings: { temperature: 0.8 },
        secrets: {
            api_key_openai: 'openai-key',
            api_key_deepseek: 'deepseek-key',
        },
    });
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.configurationMode, 'override');
    assert.equal(result.secretSource, 'deepseek');
    assert.equal(result.apiKey, 'deepseek-key');
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(result.thinking, 'disabled');
    assert.equal(result.charsPerToken, 3);
    assert.equal(result.requestTimeoutMs, 90000);
});

test('auto mode follows a Custom DeepSeek connection and its exact secret slot', () => {
    const result = buildLlmConfig({
        pluginConfig: {
            configurationMode: 'auto',
            provider: 'openai',
            endpoint: 'https://api.openai.com/v1',
            model: 'ignored-plugin-model',
            secretSource: 'openai',
            temperature: 0.1,
            maxOutputTokens: 100,
            maxContextTokens: 200,
            thinking: 'disabled',
        },
        preset: {
            endpoint: 'https://stale.example/v1',
            model: 'stale-preset-model',
            source: 'openai',
            maxContext: 4096,
        },
        settings: {
            chat_completion_source: 'custom',
            custom_url: 'https://api.deepseek.com/v1',
            custom_model: 'deepseek-v4-flash',
            temp_openai: 0.75,
            openai_max_tokens: 2048,
            openai_max_context: 128000,
        },
        secrets: {
            api_key_custom: 'custom-deepseek-key',
            api_key_deepseek: 'wrong-deepseek-slot',
            api_key_openai: 'wrong-openai-slot',
        },
    });

    assert.equal(result.configurationMode, 'auto');
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(result.secretSource, 'custom');
    assert.equal(result.apiKey, 'custom-deepseek-key');
    assert.equal(result.temperature, 0.75);
    assert.equal(result.maxOutputTokens, 2048);
    assert.equal(result.maxContextTokens, 128000);
    assert.equal(result.thinking, 'disabled');
});

test('SillyTavern 1.16 nested oai_settings are selected instead of root defaults', () => {
    const rootSettings = {
        main_api: 'openai',
        amount_gen: 350,
        max_context: 8192,
        oai_settings: {
            chat_completion_source: 'custom',
            custom_url: 'https://api.deepseek.com/v1',
            custom_model: 'deepseek-v4-flash',
            temp_openai: 0.8,
            openai_max_tokens: 2400,
            openai_max_context: 128000,
        },
    };

    const selected = selectChatCompletionSettings(rootSettings);
    const result = buildLlmConfig({
        pluginConfig: { configurationMode: 'auto' },
        settings: selected,
        secrets: {
            api_key_custom: 'custom-key',
            api_key_deepseek: 'must-not-be-used',
        },
    });

    assert.equal(selected, rootSettings.oai_settings);
    assert.equal(result.source, 'custom');
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(result.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(result.secretSource, 'custom');
    assert.equal(result.apiKey, 'custom-key');
    assert.equal(result.temperature, 0.8);
    assert.equal(result.maxOutputTokens, 2400);
    assert.equal(result.maxContextTokens, 128000);
});

test('SillyTavern 1.16 preset fields preserve Custom connection semantics', () => {
    assert.deepEqual(normalizeOpenAIPreset({
        chat_completion_source: 'custom',
        custom_url: 'https://api.deepseek.com/v1',
        custom_model: 'deepseek-v4-flash',
        temperature: 0.7,
        openai_max_tokens: 1800,
        openai_max_context: 96000,
    }), {
        source: 'custom',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        temperature: 0.7,
        maxOutputTokens: 1800,
        maxContext: 96000,
    });

    assert.equal(normalizeOpenAIPreset({}).temperature, undefined);
    assert.equal(normalizeOpenAIPreset({}).maxOutputTokens, undefined);
});

test('auto mode follows the built-in DeepSeek source and generation settings', () => {
    const result = buildLlmConfig({
        pluginConfig: { configurationMode: 'auto' },
        settings: {
            chat_completion_source: 'deepseek',
            deepseek_model: 'deepseek-chat',
            temp_openai: 0.6,
            openai_max_tokens: 1500,
            openai_max_context: 64000,
        },
        secrets: {
            api_key_custom: 'wrong-custom-slot',
            api_key_deepseek: 'deepseek-key',
        },
    });

    assert.equal(result.provider, 'deepseek');
    assert.equal(result.endpoint, 'https://api.deepseek.com');
    assert.equal(result.model, 'deepseek-chat');
    assert.equal(result.secretSource, 'deepseek');
    assert.equal(result.apiKey, 'deepseek-key');
    assert.equal(result.temperature, 0.6);
    assert.equal(result.maxOutputTokens, 1500);
    assert.equal(result.maxContextTokens, 64000);
});

test('auto mode maps supported built-in sources to their exact model and key slots', () => {
    const cases = [
        {
            source: 'openai', modelKey: 'openai_model', model: 'gpt-test',
            secretKey: 'api_key_openai', provider: 'openai', secretSource: 'openai',
            endpoint: 'https://api.openai.com/v1',
        },
        {
            source: 'claude', modelKey: 'claude_model', model: 'claude-test',
            secretKey: 'api_key_claude', provider: 'anthropic', secretSource: 'anthropic',
            endpoint: 'https://api.anthropic.com/v1',
        },
        {
            source: 'makersuite', modelKey: 'google_model', model: 'gemini-test',
            secretKey: 'api_key_makersuite', provider: 'gemini', secretSource: 'gemini',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        },
        {
            source: 'openrouter', modelKey: 'openrouter_model', model: 'router/test',
            secretKey: 'api_key_openrouter', provider: 'openrouter', secretSource: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
        },
        {
            source: 'mistralai', modelKey: 'mistralai_model', model: 'mistral-test',
            secretKey: 'api_key_mistralai', provider: 'mistral', secretSource: 'mistral',
            endpoint: 'https://api.mistral.ai/v1',
        },
        {
            source: 'groq', modelKey: 'groq_model', model: 'groq-test',
            secretKey: 'api_key_groq', provider: 'groq', secretSource: 'groq',
            endpoint: 'https://api.groq.com/openai/v1',
        },
    ];

    for (const item of cases) {
        const result = buildLlmConfig({
            settings: {
                chat_completion_source: item.source,
                [item.modelKey]: item.model,
            },
            secrets: {
                [item.secretKey]: `${item.source}-key`,
                api_key_custom: 'must-not-be-used',
            },
        });
        assert.equal(result.provider, item.provider, item.source);
        assert.equal(result.endpoint, item.endpoint, item.source);
        assert.equal(result.model, item.model, item.source);
        assert.equal(result.secretSource, item.secretSource, item.source);
        assert.equal(result.apiKey, `${item.source}-key`, item.source);
    }
});

test('auto mode never falls back from a Custom connection to another key slot', () => {
    const result = buildLlmConfig({
        pluginConfig: { configurationMode: 'auto' },
        settings: {
            chat_completion_source: 'custom',
            custom_url: 'https://api.deepseek.com/v1',
            custom_model: 'deepseek-v4-flash',
        },
        secrets: { api_key_deepseek: 'must-not-be-used' },
    });

    assert.equal(result.provider, 'deepseek');
    assert.equal(result.secretSource, 'custom');
    assert.equal(result.apiKey, null);
});

test('override mode requires an explicit complete connection and can select Custom secrets', () => {
    assert.throws(
        () => buildLlmConfig({
            pluginConfig: { configurationMode: 'override', provider: 'deepseek' },
        }),
        /需要同时配置 provider、endpoint 和 model/
    );

    const result = buildLlmConfig({
        pluginConfig: {
            configurationMode: 'override',
            provider: 'deepseek',
            endpoint: 'https://api.deepseek.com/v1',
            model: 'override-model',
            secretSource: 'custom',
            temperature: 0.4,
            maxOutputTokens: 4096,
            maxContextTokens: 96000,
        },
        settings: {
            chat_completion_source: 'openai',
            openai_model: 'ignored-browser-model',
            temp_openai: 1.2,
        },
        secrets: {
            api_key_custom: 'custom-override-key',
            api_key_deepseek: 'ignored-deepseek-key',
        },
    });

    assert.equal(result.configurationMode, 'override');
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.endpoint, 'https://api.deepseek.com/v1');
    assert.equal(result.model, 'override-model');
    assert.equal(result.secretSource, 'custom');
    assert.equal(result.apiKey, 'custom-override-key');
    assert.equal(result.temperature, 0.4);
    assert.equal(result.maxOutputTokens, 4096);
    assert.equal(result.maxContextTokens, 96000);
});

test('auto mode caps unsafe token limits from SillyTavern settings', () => {
    const result = buildLlmConfig({
        settings: {
            chat_completion_source: 'deepseek',
            deepseek_model: 'deepseek-chat',
            openai_max_tokens: 999999999,
            openai_max_context: 999999999,
        },
        secrets: { api_key_deepseek: 'deepseek-key' },
    });

    assert.equal(result.maxOutputTokens, 65536);
    assert.equal(result.maxContextTokens, 2000000);
});

test('LLM request timeout accepts a positive plugin override', () => {
    const result = buildLlmConfig({
        pluginConfig: { requestTimeoutMs: 45000 },
    });
    assert.equal(result.requestTimeoutMs, 45000);
});

test('custom secret source must be explicitly selected', () => {
    const secrets = { api_key_custom: 'custom-deepseek-key' };
    assert.equal(resolveSecret(secrets, 'deepseek'), null);
    assert.equal(resolveSecret(secrets, 'deepseek', 'custom'), 'custom-deepseek-key');
});

test('resolveDataRoot accepts ST-contained path and rejects escape', () => {
    const pluginDir = path.resolve('SillyTavern/plugins/st-wechat');
    assert.equal(
        resolveDataRoot(pluginDir, '../../data/default-user'),
        path.resolve('SillyTavern/data/default-user')
    );
    assert.throws(
        () => resolveDataRoot(pluginDir, '../../../outside'),
        /SillyTavern 根目录/
    );
});
