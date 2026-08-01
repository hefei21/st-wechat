import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWechatUpdates, projectWechatUpdates } from '../ui-extension/chat-merge.js';

test('wechat increments are merged without replacing the browser reply', async () => {
    const rendered = [];
    const context = {
        name1: 'You',
        name2: 'Alice',
        chat: [
            { name: 'You', is_user: true, mes: '浏览器问题', send_date: 1 },
            { name: 'Alice', is_user: false, mes: '浏览器回答', send_date: 2 },
        ],
        addOneMessage: message => rendered.push(message),
    };
    const result = await mergeWechatUpdates(context, [{
        id: 'wechat-1',
        messages: [
            { role: 'user', content: '微信问题', _raw: { name: 'You', is_user: true, mes: '微信问题', send_date: 3 } },
            { role: 'assistant', content: '微信回答', _raw: { name: 'Alice', is_user: false, mes: '微信回答', send_date: 4 } },
        ],
    }]);

    assert.equal(result.added, 2);
    assert.deepEqual(context.chat.map(message => message.mes), [
        '浏览器问题',
        '浏览器回答',
        '微信问题',
        '微信回答',
    ]);
    assert.equal(rendered.length, 2);
});

test('wechat increments already loaded from JSONL are acknowledged without duplication', async () => {
    const context = {
        chat: [
            { name: 'You', is_user: true, mes: '微信问题', send_date: 3 },
            { name: 'Alice', is_user: false, mes: '微信回答', send_date: 4 },
        ],
    };
    const result = await mergeWechatUpdates(context, [{
        id: 'wechat-1',
        messages: [
            { role: 'user', content: '微信问题', _raw: { name: 'You', is_user: true, mes: '微信问题', send_date: 3 } },
            { role: 'assistant', content: '微信回答', _raw: { name: 'Alice', is_user: false, mes: '微信回答', send_date: 4 } },
        ],
    }]);

    assert.equal(result.added, 0);
    assert.deepEqual(result.updateIds, ['wechat-1']);
    assert.equal(context.chat.length, 2);
});

test('a rendering failure rolls back the complete staged WeChat batch', async () => {
    const context = {
        chat: [{ name: 'Alice', is_user: false, mes: 'existing', send_date: 1 }],
        addOneMessage: message => {
            if (!message.is_user) throw new Error('render failed');
        },
    };
    await assert.rejects(
        mergeWechatUpdates(context, [{
            id: 'wechat-failure',
            messages: [
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'reply' },
            ],
        }]),
        /render failed/
    );
    assert.deepEqual(context.chat.map(message => message.mes), ['existing']);
});

test('browser projection applies Bot updates without saving JSONL again', async () => {
    const context = {
        chat: [],
        addOneMessage: () => undefined,
        saveChat: () => {
            throw new Error('projection must not save');
        },
    };
    const result = await projectWechatUpdates(context, [{
        id: 'wechat-projection',
        messages: [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'reply' },
        ],
    }]);
    assert.equal(result.added, 2);
    assert.deepEqual(result.updateIds, ['wechat-projection']);
    assert.deepEqual(context.chat.map(message => message.mes), ['question', 'reply']);
});

test('a reload event reloads JSONL instead of appending replacement text', async () => {
    let reloads = 0;
    const context = {
        chat: [{ name: 'Alice', is_user: false, mes: 'old reply' }],
        reloadCurrentChat: async () => { reloads += 1; },
        saveChat: () => { throw new Error('reload projection must not save'); },
    };
    const result = await projectWechatUpdates(context, [{
        id: 'wechat-retry',
        action: 'reload',
        reason: 'retry',
        messages: [],
    }]);
    assert.equal(reloads, 1);
    assert.equal(result.reloaded, true);
    assert.deepEqual(result.updateIds, ['wechat-retry']);
    assert.equal(context.chat.length, 1);
});
