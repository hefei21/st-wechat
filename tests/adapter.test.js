import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAIRequestBody, callLLM, splitSystemMessages } from '../src/adapter.js';

test('DeepSeek request explicitly disables thinking and uses configured limits', () => {
    const body = buildOpenAIRequestBody(
        [{ role: 'user', content: 'test' }],
        {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            thinking: 'disabled',
            temperature: 0.9,
            maxOutputTokens: 1200,
        }
    );

    assert.equal(body.model, 'deepseek-v4-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 1200);
});

test('OpenAI request does not receive DeepSeek-specific thinking field', () => {
    const body = buildOpenAIRequestBody([], {
        provider: 'openai',
        model: 'gpt-test',
        temperature: 0.7,
        maxOutputTokens: 900,
    });
    assert.equal('thinking' in body, false);
});

test('Claude and Gemini adapters merge every system message defensively', () => {
    const split = splitSystemMessages([
        { role: 'system', content: '规则一' },
        { role: 'user', content: '你好' },
        { role: 'system', content: '规则二' },
    ]);
    assert.equal(split.system, '规则一\n\n规则二');
    assert.deepEqual(split.chatMessages, [{ role: 'user', content: '你好' }]);
});

test('model HTTP response bodies are never exposed to callers', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'secret provider response body',
    });
    try {
        await assert.rejects(
            callLLM(
                [{ role: 'user', content: 'test' }],
                {
                    llm: {
                        provider: 'deepseek',
                        endpoint: 'https://example.invalid',
                        model: 'model-test',
                        apiKey: 'not-a-real-key',
                        thinking: 'disabled',
                        temperature: 0.9,
                        maxOutputTokens: 10,
                        requestTimeoutMs: 1000,
                    },
                }
            ),
            error => {
                assert.equal(error.code, 'service_unavailable');
                assert.match(error.message, /诊断编号/);
                assert.doesNotMatch(error.message, /secret provider response body|example\.invalid/);
                return true;
            }
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('provider error codes distinguish billing and context limits without exposing bodies', async () => {
    const originalFetch = globalThis.fetch;
    const cfg = {
        llm: {
            provider: 'deepseek', endpoint: 'https://example.invalid', model: 'model-test',
            apiKey: 'test', thinking: 'disabled', temperature: 1, maxOutputTokens: 10,
            requestTimeoutMs: 1000,
        },
    };
    try {
        for (const [providerCode, expected] of [
            ['insufficient_quota', 'billing'],
            ['context_length_exceeded', 'context_limit'],
        ]) {
            globalThis.fetch = async () => ({
                ok: false,
                status: 400,
                json: async () => ({ error: { code: providerCode, message: 'secret detail' } }),
            });
            await assert.rejects(
                callLLM([{ role: 'user', content: 'test' }], cfg),
                error => error.code === expected && !error.message.includes('secret detail')
            );
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('external cancellation aborts the model request and reports cancellation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        });
    });
    const controller = new AbortController();
    try {
        const request = callLLM(
            [{ role: 'user', content: 'test' }],
            {
                llm: {
                    provider: 'deepseek', endpoint: 'https://example.invalid', model: 'model-test',
                    apiKey: 'test', thinking: 'disabled', temperature: 1, maxOutputTokens: 10,
                    requestTimeoutMs: 60000,
                },
            },
            { signal: controller.signal }
        );
        controller.abort();
        await assert.rejects(request, error => error.code === 'cancelled');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('model usage callback prefers provider tokens and falls back to an estimate', async () => {
    const originalFetch = globalThis.fetch;
    const cfg = {
        llm: {
            provider: 'openai', endpoint: 'https://example.invalid', model: 'model-test',
            apiKey: 'test', temperature: 1, maxOutputTokens: 10,
            requestTimeoutMs: 1000, charsPerToken: 2,
        },
    };
    const usages = [];
    try {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'reply' } }],
                usage: { prompt_tokens: 12, completion_tokens: 3 },
            }),
        });
        await callLLM([{ role: 'user', content: 'hello' }], cfg, {
            onUsage: usage => usages.push(usage),
        });
        assert.deepEqual(usages.pop(), { input: 12, output: 3, estimated: false });

        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: '12345' } }] }),
        });
        await callLLM([{ role: 'user', content: '1234567' }], cfg, {
            onUsage: usage => usages.push(usage),
        });
        assert.deepEqual(usages.pop(), { input: 4, output: 3, estimated: true });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
