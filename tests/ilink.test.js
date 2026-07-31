import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ILinkBot, ILinkHttpError, splitText } from '../src/ilink.js';

test('splitText keeps short text intact and prefers newline boundaries', () => {
    assert.deepEqual(splitText('short', 10), ['short']);
    const chunks = splitText('第一段内容\n第二段内容很长', 8);
    assert.equal(chunks.join(''), '第一段内容第二段内容很长');
    assert.ok(chunks.every(chunk => chunk.length <= 8));
});

test('splitText keeps oversized code blocks renderable and respects limits', () => {
    const text = `说明段落。\n\n\`\`\`js\n${'const value = 1;\n'.repeat(8)}\`\`\``;
    const chunks = splitText(text, 60);

    assert.ok(chunks.length > 2);
    assert.ok(chunks.every(chunk => chunk.length <= 60));
    const codeChunks = chunks.filter(chunk => chunk.startsWith('```js'));
    assert.ok(codeChunks.length >= 2);
    assert.ok(codeChunks.every(chunk => chunk.endsWith('```')));
});

test('typing lifecycle caches tickets and stops only after overlapping work finishes', async () => {
    const calls = [];
    const bot = new ILinkBot();
    bot.apiPost = async (endpoint, body) => {
        calls.push({ endpoint, body });
        return endpoint.endsWith('/getconfig') ? { typing_ticket: 'ticket-1' } : { ret: 0 };
    };

    await bot.beginTyping('owner');
    await bot.beginTyping('owner');
    await bot.endTyping('owner');
    assert.deepEqual(calls.map(call => call.endpoint), [
        '/ilink/bot/getconfig',
        '/ilink/bot/sendtyping',
    ]);
    await bot.endTyping('owner');

    assert.equal(calls.filter(call => call.endpoint.endsWith('/getconfig')).length, 1);
    assert.deepEqual(
        calls.filter(call => call.endpoint.endsWith('/sendtyping')).map(call => call.body.status),
        [1, 2]
    );
    await bot.beginTyping('owner');
    await bot.endTyping('owner');
    assert.equal(calls.filter(call => call.endpoint.endsWith('/getconfig')).length, 1);
});

test('HTTP client classifies status, rate limits, invalid content and timeouts', async () => {
    const server = new ILinkBot({
        fetch: async () => fakeResponse(500, { error: 'hidden' }),
    });
    await assert.rejects(
        () => server.apiGet('/server-error'),
        error => error instanceof ILinkHttpError
            && error.type === 'server'
            && error.status === 500
            && !error.message.includes('hidden')
    );

    const limited = new ILinkBot({
        fetch: async () => fakeResponse(429, {}, { 'retry-after': '3' }),
    });
    await assert.rejects(
        () => limited.apiGet('/limited'),
        error => error.type === 'rate_limit' && error.retryAfterMs === 3000
    );

    const html = new ILinkBot({
        fetch: async () => fakeResponse(200, '<html>bad gateway</html>', {
            'content-type': 'text/html',
        }),
    });
    await assert.rejects(() => html.apiGet('/html'), error => error.type === 'protocol');

    const timeout = new ILinkBot({
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }),
    });
    await assert.rejects(
        () => timeout.apiGet('/slow', 1),
        error => error.type === 'timeout'
    );
});

test('HTTP client accepts JSON bodies with a nonstandard content type', async () => {
    const bot = new ILinkBot({
        fetch: async () => fakeResponse(200, { ret: 0, get_updates_buf: 'cursor' }, {
            'content-type': 'text/plain',
        }),
    });

    assert.deepEqual(await bot.apiGet('/nonstandard-json'), {
        ret: 0,
        get_updates_buf: 'cursor',
    });
});

test('HTTP client accepts JSON without a content type and strips a UTF-8 BOM', async () => {
    const bot = new ILinkBot({
        fetch: async () => fakeResponse(200, '\uFEFF{"ret":0}', {
            'content-type': '',
        }),
    });

    assert.deepEqual(await bot.apiGet('/json-without-content-type'), { ret: 0 });
});

test('stop aborts active HTTP requests and resolves tracked sleeps', async () => {
    const bot = new ILinkBot({
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }),
    });
    const request = bot.apiGet('/long-poll', 60000).catch(error => error);
    const sleeper = bot.sleep(60000);
    await new Promise(resolve => setImmediate(resolve));

    await bot.stop();

    assert.equal((await request).type, 'timeout');
    await sleeper;
    assert.equal(bot.requestControllers.size, 0);
    assert.equal(bot.sleepTimers.size, 0);
});

test('poll rejects malformed protocol data without advancing the cursor', async () => {
    const bot = new ILinkBot();
    bot.getUpdatesBuf = 'cursor-before';
    bot.apiPost = async () => ({
        ret: 0,
        get_updates_buf: 123,
        msgs: { invalid: true },
    });
    const delays = [];
    bot.waitForPollRetry = async delay => delays.push(delay);

    assert.equal(await bot.poll(), true);
    assert.equal(bot.getUpdatesBuf, 'cursor-before');
    assert.equal(bot.retryCount, 1);
    assert.deepEqual(delays, [2000]);
});

test('poll reports credential and live connection health separately', async () => {
    const bot = new ILinkBot();
    bot.token = 'test-token';
    bot.loginState = 'logged_in';
    bot.connectionState = 'checking';
    bot.apiPost = async () => {
        throw new ILinkHttpError('protocol', 'invalid response');
    };
    bot.waitForPollRetry = async () => {};

    assert.equal(bot.getLoginState().loggedIn, true);
    assert.equal(bot.getLoginState().connected, false);
    assert.equal(await bot.poll(), true);
    assert.equal(bot.getLoginState().connectionState, 'degraded');
    assert.equal(bot.getLoginState().lastPollErrorType, 'protocol');

    bot.apiPost = async () => ({ ret: 0, msgs: [], get_updates_buf: 'cursor-ok' });
    assert.equal(await bot.poll(), true);
    assert.equal(bot.getLoginState().connected, true);
    assert.equal(bot.getLoginState().connectionState, 'online');
    assert.equal(bot.getLoginState().lastPollErrorType, '');
    assert.ok(bot.getLoginState().lastPollSuccessAt);
});

test('poll honors Retry-After for rate limits', async () => {
    const bot = new ILinkBot();
    bot.apiPost = async () => {
        throw new ILinkHttpError('rate_limit', 'iLink HTTP 429', {
            status: 429,
            retryAfterMs: 7000,
        });
    };
    const delays = [];
    bot.waitForPollRetry = async delay => delays.push(delay);

    assert.equal(await bot.poll(), true);
    assert.deepEqual(delays, [7000]);
});

test('poll advances without waiting for slow message processing', async () => {
    const bot = new ILinkBot();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const handled = [];
    bot.msgHandler = async (_userId, text) => {
        handled.push(text);
        if (text === 'slow') await gate;
        return '';
    };
    bot.apiPost = async endpoint => {
        assert.equal(endpoint, '/ilink/bot/getupdates');
        return {
            ret: 0,
            get_updates_buf: 'cursor-2',
            msgs: [textMessage('owner', 'slow'), textMessage('owner', '/whoami')],
        };
    };

    await bot.poll();
    assert.equal(bot.getUpdatesBuf, 'cursor-2');
    assert.deepEqual(handled, ['slow', '/whoami']);
    assert.equal(bot.processingTasks.size, 2);

    release();
    await Promise.allSettled([...bot.processingTasks]);
    assert.equal(bot.processingTasks.size, 0);
});

test('outbound messages for the same user preserve enqueue order', async () => {
    const bot = new ILinkBot();
    const sent = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    bot.sendMessageNow = async (_userId, text) => {
        if (text === 'first') await firstGate;
        sent.push(text);
    };

    const first = bot.sendMessage('owner', 'first', 'ctx-1');
    const second = bot.sendMessage('owner', 'second', 'ctx-2');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, []);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(sent, ['first', 'second']);
});

test('outbound retries reuse the same client id without regenerating work', async () => {
    const bot = new ILinkBot({ outboundRetryDelays: [0] });
    const clientIds = [];
    let calls = 0;
    bot.apiPost = async (_endpoint, body) => {
        calls += 1;
        clientIds.push(body.msg.client_id);
        if (calls === 1) throw new Error('temporary send failure');
        return { ret: 0 };
    };

    await bot.sendMessage('owner', 'retry once', 'ctx');
    assert.equal(calls, 2);
    assert.equal(clientIds[0], clientIds[1]);
});

test('poll persists cursor, context and completed message deduplication across restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-ilink-restart-'));
    try {
        const runtimeStateFile = path.join(directory, 'ilink-events.json');
        const handled = [];
        const first = new ILinkBot({ runtimeStateFile });
        first.msgHandler = async (_userId, text, _contextToken, metadata) => {
            handled.push({ text, operationId: metadata.operationId });
            return '';
        };
        first.apiPost = async () => ({
            ret: 0,
            get_updates_buf: 'cursor-persisted',
            msgs: [textMessage('owner', 'persist me', 'message-1')],
        });

        await first.poll();
        await Promise.allSettled([...first.processingTasks]);
        assert.equal(handled.length, 1);
        assert.match(handled[0].operationId, /^ilink-message-1$/);
        first.inboundEvents.close();

        const restarted = new ILinkBot({ runtimeStateFile });
        assert.equal(restarted.getUpdatesBuf, 'cursor-persisted');
        const proactive = [];
        restarted.sendMessage = async (userId, text, contextToken) => {
            proactive.push({ userId, text, contextToken });
        };
        assert.equal(await restarted.sendProactive('owner', 'notice'), true);
        assert.equal(proactive[0].contextToken, 'ctx-persist me');

        restarted.msgHandler = async () => {
            handled.push({ text: 'duplicate' });
            return '';
        };
        restarted.apiPost = first.apiPost;
        await restarted.poll();
        await Promise.allSettled([...restarted.processingTasks]);
        assert.equal(handled.length, 1);
        restarted.inboundEvents.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('failed inbound work records a queryable timeout status after sending the error', async () => {
    const bot = new ILinkBot();
    bot.msgHandler = async () => {
        const error = new Error('模型请求超时，内部响应含 secret-upstream-body');
        error.code = 'timeout';
        throw error;
    };
    const sent = [];
    bot.sendMessage = async (_userId, text) => sent.push(text);
    bot.apiPost = async () => ({
        ret: 0,
        get_updates_buf: 'cursor-timeout',
        msgs: [textMessage('owner', 'timeout request', 'message-timeout')],
    });

    await bot.poll();
    await Promise.allSettled([...bot.processingTasks]);

    const status = bot.getOperationStatus('owner');
    assert.equal(status.status, 'completed');
    assert.equal(status.stage, 'failed');
    assert.equal(status.errorType, 'timeout');
    assert.ok(Number.isFinite(status.durationMs));
    assert.match(status.diagnosticId, /^[a-f0-9]{8}$/);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /类型：timeout/);
    assert.match(sent[0], new RegExp(status.diagnosticId));
    assert.doesNotMatch(sent[0], /secret-upstream-body/);
});

test('restart resends persisted command output with the same client ids without rerunning handler', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-ilink-outbound-recovery-'));
    try {
        const runtimeStateFile = path.join(directory, 'ilink-events.json');
        let handlerCalls = 0;
        const first = new ILinkBot({ runtimeStateFile, outboundRetryDelays: [] });
        first.msgHandler = async () => {
            handlerCalls += 1;
            return 'COMMAND_RESULT';
        };
        const firstClientIds = [];
        first.sendMessage = async (_userId, _text, _contextToken, options) => {
            firstClientIds.push(...options.clientIds);
            throw new Error('send interrupted');
        };
        first.apiPost = async () => ({
            ret: 0,
            get_updates_buf: 'cursor-command',
            msgs: [textMessage('owner', '/new', 'message-command')],
        });

        await first.poll();
        await Promise.allSettled([...first.processingTasks]);
        assert.equal(first.getOperationStatus('owner').status, 'pending');
        first.inboundEvents.close();

        const sentAfterRestart = [];
        const restarted = new ILinkBot({ runtimeStateFile });
        restarted.msgHandler = async () => {
            handlerCalls += 1;
            return 'SHOULD_NOT_RUN';
        };
        restarted.sendMessage = async (_userId, text, _contextToken, options) => {
            sentAfterRestart.push({ text, clientIds: options.clientIds });
        };
        for (const event of restarted.inboundEvents.pending()) restarted.dispatchEvent(event);
        await Promise.allSettled([...restarted.processingTasks]);

        assert.equal(handlerCalls, 1);
        assert.equal(sentAfterRestart[0].text, 'COMMAND_RESULT');
        assert.deepEqual(sentAfterRestart[0].clientIds, firstClientIds);
        assert.equal(restarted.getOperationStatus('owner').status, 'completed');
        restarted.inboundEvents.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function textMessage(userId, text, messageId = undefined) {
    return {
        ...(messageId ? { message_id: messageId } : {}),
        from_user_id: userId,
        context_token: `ctx-${text}`,
        item_list: [{ type: 1, text_item: { text } }],
    };
}

function fakeResponse(status, body, extraHeaders = {}) {
    const headers = new Map(Object.entries({
        'content-type': 'application/json; charset=utf-8',
        ...extraHeaders,
    }).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: key => headers.get(String(key).toLowerCase()) || null },
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
        json: async () => {
            if (typeof body === 'string') throw new SyntaxError('not json');
            return body;
        },
    };
}

test('manual retry wakes the existing poll backoff without creating another loop', async () => {
    const bot = new ILinkBot();
    let resolved = false;
    const waiting = bot.waitForPollRetry(60000).then(() => { resolved = true; });
    assert.equal(bot.retryNow(), true);
    await waiting;
    assert.equal(resolved, true);
    assert.equal(bot.pollRetryWaiter, null);
    assert.equal(bot.retryNow(), false);
});

test('unsupported media gets an explicit reply without invoking the chat handler', async () => {
    const sent = [];
    let handlerCalls = 0;
    const bot = new ILinkBot();
    bot.msgHandler = async () => {
        handlerCalls += 1;
        return 'MODEL_REPLY';
    };
    bot.sendMessage = async (_userId, text) => sent.push(text);

    await bot.dispatchMessage({
        message_id: 'image-message',
        from_user_id: 'owner',
        context_token: 'ctx-image',
        item_list: [{ type: 2, image_item: { media_id: 'remote-image' } }],
    });

    assert.equal(handlerCalls, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /暂不支持图片输入/);
    assert.match(sent[0], /未被下载/);
    assert.equal(bot.inboundEvents.pending().length, 0);
});
