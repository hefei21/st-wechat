import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore, safeCharacterDirectoryName } from '../src/chat-store.js';

function withTempStore(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-chat-'));
    let sequence = 0;
    const store = new ChatStore(root, {
        now: () => new Date('2026-07-28T12:34:56.789Z'),
        randomUUID: () => `id-${String(++sequence).padStart(4, '0')}`,
    });
    try {
        return run(store, root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('shared chat listing includes legacy and native SillyTavern files', () => withTempStore((store) => {
    const charDir = store.resolveCharacterDir('测试角色');
    fs.mkdirSync(charDir, { recursive: true });
    fs.writeFileSync(
        path.join(charDir, 'ST chat.jsonl'),
        '{"name":"测试角色","summary":""}\n'
    );
    fs.writeFileSync(
        path.join(charDir, 'legacy wechat.jsonl'),
        '{"name":"测试角色","summary":"","wechat_user":"legacy-owner","wechat_chat":true}\n'
    );

    assert.deepEqual(
        store.list('测试角色').map(chat => path.basename(chat.path)).sort(),
        ['ST chat.jsonl', 'legacy wechat.jsonl']
    );
}));

test('same timestamp still creates unique files without overwriting', () => withTempStore((store) => {
    const first = store.createShared('测试角色');
    const second = store.createShared('测试角色');
    assert.notEqual(first.path, second.path);
    assert.equal(fs.readdirSync(path.dirname(first.path)).length, 2);
    assert.equal(store.parse(first.path).metadata.wechat_user, undefined);
}));

test('metadata update preserves system, unknown, and message lines', () => withTempStore((store) => {
    const chat = store.createShared('测试角色');
    fs.appendFileSync(chat.path, [
        '{"name":"System","is_system":true,"mes":"系统记录"}',
        'not-json-but-preserve',
        '{"name":"You","is_user":true,"mes":"你好"}',
        '',
    ].join('\n'));

    store.updateMetadata(chat.path, { summary: '新记忆' });
    const raw = fs.readFileSync(chat.path, 'utf8');
    assert.match(raw, /"summary":"新记忆"/);
    assert.match(raw, /"is_system":true/);
    assert.match(raw, /not-json-but-preserve/);
    assert.match(raw, /"mes":"你好"/);
}));

test('replaceLastAssistant preserves system records and swipes', () => withTempStore((store) => {
    const chat = store.createShared('测试角色');
    fs.appendFileSync(chat.path, [
        '{"name":"System","is_system":true,"mes":"keep"}',
        '{"name":"You","is_user":true,"mes":"question"}',
        '{"name":"测试角色","is_user":false,"mes":"old","swipes":["old"]}',
        '',
    ].join('\n'));
    assert.deepEqual(
        store.replaceLastAssistant(chat.path, 'new'),
        { swipes: ['old', 'new'], swipeId: 1 }
    );
    const raw = fs.readFileSync(chat.path, 'utf8');
    assert.match(raw, /"is_system":true/);
    assert.match(raw, /"mes":"new","swipes":\["old","new"\],"swipe_id":1/);
}));

test('appendToLastAssistant extends only the selected swipe and preserves other records', () => withTempStore((store) => {
    const chat = store.createShared('测试角色');
    fs.appendFileSync(chat.path, [
        '{"name":"System","is_system":true,"mes":"keep"}',
        'unknown-line',
        '{"name":"You","is_user":true,"mes":"question"}',
        '{"name":"测试角色","is_user":false,"mes":"selected","swipes":["first","selected"],"swipe_id":1,"extra":{"keep":true}}',
        '',
    ].join('\n'));

    assert.deepEqual(
        store.appendToLastAssistant(chat.path, ' continued'),
        {
            content: 'selected continued',
            swipes: ['first', 'selected continued'],
            swipeId: 1,
        }
    );
    const raw = fs.readFileSync(chat.path, 'utf8');
    assert.match(raw, /"is_system":true/);
    assert.match(raw, /unknown-line/);
    assert.match(raw, /"extra":\{"keep":true\}/);
    const parsed = store.parse(chat.path);
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages.at(-1).content, 'selected continued');
}));

test('unsafe character names remain inside chats root', () => withTempStore((store, root) => {
    const safe = safeCharacterDirectoryName('../evil/name');
    assert.doesNotMatch(safe, /[\\/]/);
    const chat = store.createShared('../evil/name');
    const relative = path.relative(root, chat.path);
    assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`), false);
    assert.throws(() => store.parse(path.resolve(root, '..', 'outside.jsonl')), /越出数据目录/);
}));

test('appendExchange writes one complete turn', () => withTempStore((store) => {
    const chat = store.createShared('测试角色');
    store.appendExchange(chat.path, [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '回答' },
    ], '测试角色');
    assert.deepEqual(
        store.parse(chat.path).messages.map(message => [message.role, message.content]),
        [['user', '问题'], ['assistant', '回答']]
    );
}));

test('operation ids make a committed reply discoverable after restart', () => withTempStore((store) => {
    const chat = store.createShared('测试角色');
    store.appendExchange(chat.path, [
        { role: 'user', content: '问题', operationId: 'event-1' },
        { role: 'assistant', content: '回答', operationId: 'event-1' },
    ], '测试角色');

    assert.equal(store.findOperationResult(chat.path, 'event-1'), '回答');
    assert.equal(store.findOperationResult(chat.path, 'event-missing'), null);
}));

test('queued writes to the same chat preserve enqueue order', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-queue-'));
    const store = new ChatStore(root);
    try {
        const chat = store.createShared('测试角色');
        await Promise.all([
            store.appendExchangeQueued(chat.path, [{ role: 'user', content: '第一条' }], '测试角色'),
            store.appendExchangeQueued(chat.path, [{ role: 'user', content: '第二条' }], '测试角色'),
        ]);
        assert.deepEqual(
            store.parse(chat.path).messages.map(message => message.content),
            ['第一条', '第二条']
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
