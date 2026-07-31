import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWechatUpdates } from '../ui-extension/chat-merge.js';

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
