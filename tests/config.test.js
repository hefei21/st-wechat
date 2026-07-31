import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    buildLlmConfig,
    detectProvider,
    parseSimpleYaml,
    resolveDataRoot,
    resolveSecret,
} from '../src/config.js';

test('parseSimpleYaml preserves scalar types', () => {
    const parsed = parseSimpleYaml(`
provider: deepseek
thinking: false
temperature: 0.9
maxOutputTokens: 1200
charsPerToken: 2.5
endpoint: "https://api.deepseek.com" # comment
`);
    assert.deepEqual(parsed, {
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
    assert.equal(result.apiKey, 'deepseek-key');
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(result.thinking, 'disabled');
    assert.equal(result.charsPerToken, 3);
    assert.equal(result.requestTimeoutMs, 90000);
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
