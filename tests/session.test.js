import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatRegistry } from '../src/chat-registry.js';
import { ChatStore } from '../src/chat-store.js';
import { OwnerStore } from '../src/owner-store.js';
import { countUserTurns, findRetryTarget, SessionManager } from '../src/session.js';

test('SessionManager exposes help without keeping the process alive', async () => {
    const sessions = new SessionManager();
    try {
        const help = await sessions.handle('test-user', '/help');
        assert.match(help, /\/switch/);
        assert.doesNotMatch(help, /\/bind/);
        assert.match(help, /\/chats/);
        assert.match(help, /\/chat/);
        assert.match(help, /\/new/);
    } finally {
        sessions.close();
    }
});

test('unknown command returns a useful message', async () => {
    const sessions = new SessionManager();
    try {
        assert.match(await sessions.handle('test-user', '/unknown'), /未知命令/);
    } finally {
        sessions.close();
    }
});

test('first switch reuses the latest shared chat and restart restores it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-restore-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const existing = chatStore.createShared('Alice');
        chatStore.appendExchange(existing.path, [
            { role: 'user', content: '旧问题' },
            { role: 'assistant', content: '旧回答' },
        ], 'Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const registryPath = path.join(dataRoot, 'st-wechat', 'chat-registry.json');
        const first = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            registry: new ChatRegistry(registryPath, chatsDir),
            characterProvider: () => [character],
        });
        const switched = await first.cmdSwitch('owner', 'Alice');
        assert.equal(typeof switched, 'string');
        assert.match(switched, /已切换/);
        assert.match(switched, /旧问题\n\n💬 角色：旧回答/);
        assert.equal(chatStore.list('Alice').length, 1);
        assert.equal(first.getCharSession('owner').chatPath, existing.path);
        first.close();

        const restarted = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore: new ChatStore(chatsDir),
            registry: new ChatRegistry(registryPath, chatsDir),
            characterProvider: () => [character],
        });
        const status = await restarted.handle('owner', '/status');
        assert.match(status, /当前角色：Alice/);
        assert.match(status, /对话轮次：1/);
        assert.ok(status.includes(`当前聊天：${path.basename(existing.path)}`));
        const restored = restarted.getCharSession('owner');
        assert.equal(restored.chatPath, existing.path);
        assert.equal(restored.history.length, 2);
        restarted.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser updates notify only when both ends currently select the same file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-sync-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const first = chatStore.createShared('Alice');
        const second = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        manager.registry.setBotSelection(character.id, first.path);

        await manager.reportBrowserState({
            characterRef: 'Alice',
            chatId: path.basename(second.path),
            event: 'state',
        });
        chatStore.appendMessage(second.path, 'assistant', '其他文件更新', 'Alice');
        await manager.reportBrowserState({
            characterRef: 'Alice',
            chatId: path.basename(second.path),
            event: 'file-updated',
        });
        assert.match(manager.cmdSync(), /没有待同步/);

        await manager.reportBrowserState({
            characterRef: 'Alice',
            chatId: path.basename(first.path),
            event: 'state',
        });
        chatStore.appendMessage(first.path, 'assistant', '当前文件更新', 'Alice');
        await manager.reportBrowserState({
            characterRef: 'Alice',
            chatId: path.basename(first.path),
            event: 'file-updated',
        });
        assert.match(manager.cmdSync(), /当前文件更新/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser updates from a previously selected different character never notify the Bot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-cross-character-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const aliceChat = chatStore.createShared('Alice');
        const bobChat = chatStore.createShared('Bob');
        const characters = [
            {
                id: 'char_alice',
                name: 'Alice',
                file: 'Alice.json',
                data: { name: 'Alice', first_mes: '你好' },
            },
            {
                id: 'char_bob',
                name: 'Bob',
                file: 'Bob.json',
                data: { name: 'Bob', first_mes: '你好' },
            },
        ];
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => characters,
        });

        // Bob retains a valid historical Bot selection after the Bot switches to Alice.
        manager.registry.setBotSelection('char_bob', bobChat.path);
        manager.registry.setBotSelection('char_alice', aliceChat.path);
        await manager.reportBrowserState({
            characterRef: 'Bob',
            chatId: path.basename(bobChat.path),
            event: 'state',
        });
        chatStore.appendExchange(bobChat.path, [
            { role: 'user', content: 'Bob 浏览器问题' },
            { role: 'assistant', content: 'Bob 浏览器回答' },
        ], 'Bob');
        const reported = await manager.reportBrowserState({
            characterRef: 'Bob',
            chatId: path.basename(bobChat.path),
            event: 'generation-finished',
            operationId: 'bob-browser-op',
        });

        assert.equal(reported.sameCurrent, false);
        assert.match(manager.cmdSync(), /没有待同步/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser sync returns exact WeChat increments until the browser acknowledges them', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-source-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        manager.registry.setBotSelection(character.id, chat.path);
        const baseline = await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'state',
        });
        chatStore.appendExchange(chat.path, [
            { role: 'user', content: '微信问题' },
            { role: 'assistant', content: '微信回答' },
        ], 'Alice');
        const wechatUpdate = manager.observeChat(chat.path, { source: 'wechat' });
        manager.queueWechatBrowserUpdate(chat.path, wechatUpdate.addedMessages, wechatUpdate.revision);

        const sync = await manager.getBrowserSyncState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            revision: baseline.revision,
        });
        assert.equal(sync.changed, true);
        assert.equal(sync.sameCurrent, true);
        assert.equal(sync.changeSource, 'wechat');
        assert.equal(sync.updates.length, 1);
        assert.deepEqual(sync.updates[0].messages.map(message => message.content), [
            '微信问题',
            '微信回答',
        ]);
        assert.match(manager.cmdSync(), /没有待同步/);

        const acknowledged = manager.acknowledgeWechatBrowserUpdates({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            updateIds: [sync.updates[0].id],
        });
        assert.equal(acknowledged.acknowledged, 1);
        const afterAck = await manager.getBrowserSyncState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            revision: sync.revision,
        });
        assert.deepEqual(afterAck.updates, []);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a Bot generation publishes its written exchange as a browser merge increment', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-wechat-delta-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
            generator: async (session, _userId, _characterId, message, _type, _extra, options) => {
                await options.beforeWrite?.();
                await chatStore.appendExchangeQueued(session.chatPath, [
                    { role: 'user', content: message },
                    { role: 'assistant', content: '微信回答' },
                ], character.name);
                return '微信回答';
            },
        });
        await manager.cmdSwitch('owner', character.id);
        manager.registry.setBotSelection(character.id, chat.path);
        manager.registry.setBrowserSelection(character.id, chat.path);

        assert.equal(await manager.handleChat('owner', '微信问题'), '微信回答');
        const sync = await manager.getBrowserSyncState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            revision: '',
        });
        assert.equal(sync.updates.length, 1);
        assert.deepEqual(sync.updates[0].messages.map(message => message.content), [
            '微信问题',
            '微信回答',
        ]);
        assert.match(manager.cmdSync(), /没有待同步/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a browser report cannot consume a Bot write before its sync event is published', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-write-race-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.png',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let manager;
        manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
            generator: async (session, _userId, _characterId, message, _type, _extra, options) => {
                await options.beforeWrite?.();
                await chatStore.appendExchangeQueued(session.chatPath, [
                    { role: 'user', content: message, operationId: options.operationId },
                    { role: 'assistant', content: '微信回答', operationId: options.operationId },
                ], character.name);
                const report = await manager.reportBrowserState({
                    characterRef: character.id,
                    chatId: path.basename(chat.path),
                    event: 'file-updated',
                });
                assert.equal(report.deferred, true);
                return '微信回答';
            },
        });
        await manager.cmdSwitch('owner', character.id);
        manager.registry.setBotSelection(character.id, chat.path);
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'state',
        });

        assert.equal(
            await manager.handleChat('owner', '微信问题', { operationId: 'wechat-race' }),
            '微信回答'
        );
        const updates = manager.syncEvents.list(chat.path);
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0].messages.map(message => message.content), [
            '微信问题',
            '微信回答',
        ]);
        assert.match(manager.cmdSync(), /没有待同步/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a browser sync poll cannot consume a Bot write before its direct event is published', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-poll-race-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.png',
            data: { name: 'Alice', first_mes: 'hello' },
        };
        let manager;
        manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
            generator: async (session, _userId, _characterId, message, _type, _extra, options) => {
                await options.beforeWrite?.();
                const written = await chatStore.appendExchangeQueued(session.chatPath, [
                    { role: 'user', content: message, operationId: options.operationId },
                    { role: 'assistant', content: 'wechat reply', operationId: options.operationId },
                ], character.name);
                const poll = await manager.getBrowserSyncState({
                    characterRef: character.id,
                    chatId: path.basename(chat.path),
                    revision: '',
                });
                assert.equal(poll.deferred, true);
                await options.onWrite?.(written);
                return 'wechat reply';
            },
        });
        await manager.cmdSwitch('owner', character.id);
        manager.registry.setBotSelection(character.id, chat.path);
        manager.registry.setBrowserSelection(character.id, chat.path);
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'state',
        });

        assert.equal(
            await manager.handleChat('owner', 'wechat question', { operationId: 'poll-race' }),
            'wechat reply'
        );
        const updates = manager.syncEvents.list(chat.path);
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0].messages.map(message => message.content), [
            'wechat question',
            'wechat reply',
        ]);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser reports do not echo WeChat projection records back to the Bot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-projection-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.png',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
        });
        manager.registry.setBotSelection(character.id, chat.path);
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'state',
        });

        chatStore.appendExchange(chat.path, [
            { role: 'user', content: '微信问题', operationId: 'wechat-operation' },
            { role: 'assistant', content: '微信回答', operationId: 'wechat-operation' },
        ], character.name);
        const wechatUpdate = manager.observeChat(chat.path, { source: 'wechat' });
        manager.queueWechatBrowserUpdate(chat.path, wechatUpdate.addedMessages, wechatUpdate.revision);
        const update = manager.syncEvents.list(chat.path)[0];

        fs.appendFileSync(chat.path, [
            JSON.stringify({
                name: 'You', is_user: true, mes: '微信问题', send_date: Date.now(),
                st_wechat_operation_id: 'wechat-operation',
                extra: { st_wechat_sync_id: `${update.id}:0` },
            }),
            JSON.stringify({
                name: 'Alice', is_user: false, mes: '微信回答', send_date: Date.now(),
                st_wechat_operation_id: 'wechat-operation',
                extra: { st_wechat_sync_id: `${update.id}:1` },
            }),
        ].join('\n') + '\n', 'utf8');
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'file-updated',
        });
        assert.match(manager.cmdSync(), /没有待同步/);
        assert.equal(manager.registry.getChatState(chat.path)?.source, 'wechat');

        chatStore.appendExchange(chat.path, [
            { role: 'user', content: '浏览器问题' },
            { role: 'assistant', content: '浏览器回答' },
        ], character.name);
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'file-updated',
        });
        const notification = manager.cmdSync();
        assert.match(notification, /浏览器问题/);
        assert.match(notification, /浏览器回答/);
        assert.doesNotMatch(notification, /微信问题|微信回答/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('retry target excludes the original user message from retained history', () => {
    const history = [
        { role: 'assistant', content: '开场' },
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '旧回答' },
    ];
    const target = findRetryTarget(history);
    assert.deepEqual(target, {
        lastUserMsg: '问题',
        lastUserIdx: 1,
        lastAssistIdx: 2,
    });
    assert.equal(history.slice(0, target.lastUserIdx).some(item => item.content === '问题'), false);
});

test('new role chat persists only first_mes and /new becomes the restart target', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-new-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const registryPath = path.join(dataRoot, 'st-wechat', 'chat-registry.json');
        const character = {
            id: 'char_alice',
            name: 'Alice Display',
            file: 'alice-card.png',
            data: { name: 'Alice Display', first_mes: '真实开场白' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            characterProvider: () => [character],
        });
        await manager.cmdSwitch('owner', character.id);
        const firstPath = manager.getCharSession('owner').chatPath;
        const first = manager.chatStore.parse(firstPath);
        assert.deepEqual(
            first.messages.map(message => [message.role, message.content]),
            [['assistant', '真实开场白']]
        );
        assert.equal(first.metadata.wechat_user, undefined);
        assert.equal(path.basename(path.dirname(firstPath)), 'alice-card');

        await manager.cmdNew('owner');
        const secondPath = manager.getCharSession('owner').chatPath;
        assert.notEqual(secondPath, firstPath);
        manager.close();

        const restarted = new SessionManager({
            config: { chatsDir, dataRoot },
            registry: new ChatRegistry(registryPath, chatsDir),
            characterProvider: () => [character],
        });
        assert.equal(restarted.ensureCharSession('owner').chatPath, secondPath);
        restarted.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('duplicate display names keep separate SillyTavern chat directories', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-duplicates-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const characters = [
            { id: 'char_a', name: '同名', file: 'card-a.png', data: { name: '同名', first_mes: 'A' } },
            { id: 'char_b', name: '同名', file: 'card-b.png', data: { name: '同名', first_mes: 'B' } },
        ];
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            characterProvider: () => characters,
        });
        await manager.cmdSwitch('owner', 'card-a');
        const first = manager.getCharSession('owner').chatPath;
        await manager.cmdSwitch('owner', 'card-b');
        const second = manager.getCharSession('owner').chatPath;
        assert.equal(path.basename(path.dirname(first)), 'card-a');
        assert.equal(path.basename(path.dirname(second)), 'card-b');
        assert.notEqual(first, second);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser notification waits for a complete user and assistant turn', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-complete-turn-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
        });
        manager.registry.setBotSelection(character.id, chat.path);
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'state',
        });
        chatStore.appendMessage(chat.path, 'user', '浏览器问题', 'You');
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'file-updated',
        });
        assert.match(manager.cmdSync(), /没有待同步/);
        chatStore.appendMessage(chat.path, 'assistant', '浏览器回答', 'Alice');
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'file-updated',
        });
        const synced = manager.cmdSync();
        assert.match(synced, /浏览器问题/);
        assert.match(synced, /浏览器回答/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser notification reconstructs the adjacent user when the first observed delta is assistant only', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-complete-delta-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
        });
        manager.registry.setBotSelection(character.id, chat.path);
        chatStore.appendMessage(chat.path, 'user', '浏览器问题', 'You');
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'state',
        });
        chatStore.appendMessage(chat.path, 'assistant', '浏览器回答', 'Alice');
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId: path.basename(chat.path),
            event: 'generation-finished',
            operationId: 'browser-op',
        });
        const synced = manager.cmdSync();
        assert.match(synced, /浏览器问题/);
        assert.match(synced, /浏览器回答/);
        assert.match(synced, /浏览器问题[\s\S]*\n\n💬 角色：浏览器回答/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser sync notice is delivered independently while a Bot generation is running', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-inbound-sync-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let releaseGeneration;
        const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
        const proactive = [];
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
            generator: async () => {
                await generationGate;
                return 'Bot 当前回复';
            },
            notifier: async (_userId, text) => proactive.push(text),
            notificationDelayMs: 5,
        });
        await manager.cmdSwitch('owner', character.id);
        manager.registry.setBotSelection(character.id, chat.path);
        manager.registry.setBrowserSelection(character.id, chat.path);

        const handling = manager.handle('owner', 'Bot 当前问题');
        manager.queueBrowserNotification(chat.path, character.name, [
            { role: 'user', content: '浏览器问题' },
            { role: 'assistant', content: '浏览器回答' },
        ], false, false, 'generation-finished');
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(proactive.length, 1);
        assert.match(proactive[0], /酒馆端已更新当前聊天/);
        assert.match(proactive[0], /浏览器问题[\s\S]*浏览器回答/);
        releaseGeneration();

        assert.equal(await handling, 'Bot 当前回复');
        assert.equal(manager.pendingSync.length, 0);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('read-only status commands bypass a queued Bot generation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-fast-command-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let releaseGeneration;
        const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
            generator: async () => {
                await generationGate;
                return 'slow reply';
            },
        });
        await manager.cmdSwitch('owner', character.id);

        const slow = manager.handle('owner', 'slow message');
        await new Promise(resolve => setImmediate(resolve));
        const status = await manager.handle('owner', '/whoami');
        assert.match(status, /Alice/);

        releaseGeneration();
        assert.equal(await slow, 'slow reply');
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('normal messages are rejected explicitly when the owner queue reaches its limit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-queue-limit-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore: new ChatStore(chatsDir),
            characterProvider: () => [character],
            maxQueuedMessages: 1,
            generator: async () => {
                await blocked;
                return '完成';
            },
        });
        await manager.cmdSwitch('owner', character.id);

        const first = manager.handle('owner', '第一条');
        await new Promise(resolve => setImmediate(resolve));

        await assert.rejects(
            manager.handle('owner', '第二条'),
            error => error?.code === 'queue_overloaded' && /本条未处理/.test(error.message)
        );
        assert.match(await manager.handle('owner', '/status'), /当前角色：Alice/);

        release();
        assert.equal(await first, '完成');
        assert.equal(manager.userQueueDepth.size, 0);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser avatar filename with extension resolves to the stable role', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-avatar-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [{
                id: 'char_alice',
                name: '展示名',
                file: 'Alice.png',
                data: { name: '展示名' },
            }],
        });
        const state = await manager.reportBrowserState({
            characterRef: 'Alice.png',
            chatId: path.basename(chat.path),
            event: 'state',
        });
        assert.equal(state.characterId, 'char_alice');
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unclaimed and non-owner accounts cannot inspect roles or chats', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-owner-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const ownerStore = new OwnerStore(path.join(dataRoot, 'st-wechat', 'owner.json'), {
            randomInt: () => 123456,
        });
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            ownerStore,
            characterProvider: () => [{
                id: 'char_alice',
                name: 'Alice',
                file: 'Alice.json',
                data: { name: 'Alice' },
            }],
        });
        assert.doesNotMatch(await manager.handle('intruder', '/list'), /Alice/);
        assert.match(await manager.handle('owner', '/claim 123456'), /已认领/);
        assert.match(await manager.handle('owner', '/list'), /Alice/);
        assert.doesNotMatch(await manager.handle('intruder', '/list'), /Alice/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('cache cleanup and a deleted selected chat safely recover from persistent state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-recovery-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const oldChat = chatStore.createShared('Alice');
        const fallback = chatStore.createShared('Alice');
        chatStore.appendMessage(fallback.path, 'assistant', '最近聊天', 'Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        manager.registry.setBotSelection(character.id, oldChat.path);
        const user = manager.getUser('owner');
        user.lastActive = Date.now() - 3600001;
        manager.cleanup();
        assert.equal(manager.sessions.has('owner'), false);

        fs.unlinkSync(oldChat.path);
        const recovered = manager.ensureCharSession('owner');
        assert.equal(recovered.chatPath, fallback.path);
        assert.match(recovered.history.at(-1).content, /最近聊天/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an active session recovers when its selected chat is deleted in the browser', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-active-delete-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const fallback = chatStore.createShared('Alice');
        chatStore.appendMessage(fallback.path, 'assistant', '保留聊天', 'Alice');
        const selected = chatStore.createShared('Alice');
        chatStore.appendMessage(selected.path, 'assistant', '即将删除', 'Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        await manager.cmdSwitch('owner', character.id);
        const session = manager.getCharSession('owner');
        session.chatPath = selected.path;
        session.history = chatStore.parse(selected.path).messages;
        manager.registry.setBotSelection(character.id, selected.path);

        fs.unlinkSync(selected.path);
        const recovered = await manager.ensureActiveChat('owner');
        assert.equal(recovered.session.chatPath, fallback.path);
        assert.match(recovered.recoveryNotice, /原聊天已被删除/);
        assert.match(recovered.recoveryNotice, /已切换/);
        assert.equal(manager.registry.getBotSelection(character.id).chatPath, fallback.path);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the first message after browser deletion only recovers the chat and is not generated', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-delete-guard-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const fallback = chatStore.createShared('Alice');
        chatStore.appendMessage(fallback.path, 'assistant', '保留聊天', 'Alice');
        const selected = chatStore.createShared('Alice');
        chatStore.appendMessage(selected.path, 'assistant', '即将删除', 'Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let generated = 0;
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
            generator: async () => {
                generated += 1;
                return '不应生成';
            },
        });
        await manager.cmdSwitch('owner', character.id);
        const session = manager.getCharSession('owner');
        session.chatPath = selected.path;
        session.history = chatStore.parse(selected.path).messages;
        manager.registry.setBotSelection(character.id, selected.path);
        const before = fs.readFileSync(fallback.path, 'utf8');

        fs.unlinkSync(selected.path);
        const result = await manager.handleChat('owner', '这条消息不能发送');

        assert.match(result, /原聊天已被删除/);
        assert.match(result, /本条消息未发送/);
        assert.equal(generated, 0);
        assert.equal(manager.getCharSession('owner').chatPath, fallback.path);
        assert.equal(fs.readFileSync(fallback.path, 'utf8'), before);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('turn count uses user messages and excludes the character greeting', () => {
    assert.equal(countUserTurns([
        { role: 'assistant', content: '开场白' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
        { role: 'assistant', content: '第二答' },
    ]), 2);
});

test('removed clear command cannot create a new chat or change current state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-no-clear-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        chatStore.appendMessage(chat.path, 'assistant', '保留聊天', 'Alice');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        await manager.cmdSwitch('owner', character.id);
        const before = fs.readFileSync(chat.path, 'utf8');
        const chatCount = chatStore.list('Alice').length;

        assert.match(await manager.handleCommand('owner', '/clear'), /未知命令/);
        assert.equal(manager.getCharSession('owner').chatPath, chat.path);
        assert.equal(chatStore.list('Alice').length, chatCount);
        assert.equal(fs.readFileSync(chat.path, 'utf8'), before);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('removed clear-context command cannot create a hidden history fork', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-no-clear-context-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        chatStore.appendExchange(chat.path, [
            { role: 'user', content: '问题' },
            { role: 'assistant', content: '回答' },
        ], 'Alice');
        chatStore.updateMetadata(chat.path, { summary: '长期记忆' });
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        await manager.cmdSwitch('owner', character.id);
        const before = fs.readFileSync(chat.path, 'utf8');
        const historyBefore = structuredClone(manager.getCharSession('owner').history);
        assert.match(await manager.handleCommand('owner', '/clear-context'), /未知命令/);
        assert.deepEqual(manager.getCharSession('owner').history, historyBefore);
        assert.equal(manager.getCharSession('owner').summary, '长期记忆');
        assert.equal(fs.readFileSync(chat.path, 'utf8'), before);
        assert.equal(manager.getCharSession('owner').lastWritten, 2);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('swipe selection is persisted in JSONL and restored after restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-session-swipe-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const chat = chatStore.createShared('Alice');
        fs.appendFileSync(chat.path, [
            '{"name":"You","is_user":true,"mes":"问题","send_date":1}',
            '{"name":"Alice","is_user":false,"mes":"回答一","send_date":2,"swipes":["回答一","回答二"],"swipe_id":0}',
            '',
        ].join('\n'));
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
        });
        await manager.cmdSwitch('owner', character.id);
        assert.match(await manager.cmdSwipe('owner'), /回答二/);
        const registryPath = manager.registry.filePath;
        manager.close();

        const restarted = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore: new ChatStore(chatsDir),
            registry: new ChatRegistry(registryPath, chatsDir),
            characterProvider: () => [character],
        });
        const restored = restarted.ensureCharSession('owner');
        assert.equal(restored.swipeIndex, 1);
        assert.deepEqual(restored.alternatives, ['回答一', '回答二']);
        assert.equal(restored.history.at(-1).content, '回答二');
        restarted.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a dangling browser user blocks the next Bot prompt instead of merging two requests', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-incomplete-browser-turn-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let generationCalls = 0;
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
            generator: async () => {
                generationCalls += 1;
                return '不应生成';
            },
        });
        await manager.cmdSwitch('owner', character.id);
        const session = manager.getCharSession('owner');
        chatStore.appendExchange(session.chatPath, [
            { role: 'user', content: '浏览器未完成的问题' },
        ], character.name);
        const before = fs.readFileSync(session.chatPath, 'utf8');

        const reply = await manager.handle('owner', '微信的新问题');

        assert.match(reply, /上一轮没有生成有效正文/);
        assert.match(reply, /本条微信消息未发送/);
        assert.equal(generationCalls, 0);
        assert.equal(fs.readFileSync(session.chatPath, 'utf8'), before);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser completion without an assistant body flushes an explicit failure notification', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-incomplete-browser-notice-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const notices = [];
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore,
            characterProvider: () => [character],
            notifier: async (_userId, text) => notices.push(text),
            notificationDelayMs: 1,
        });
        await manager.cmdSwitch('owner', character.id);
        const session = manager.getCharSession('owner');
        manager.activeOwnerId = 'owner';
        manager.registry.setBotSelection(character.id, session.chatPath);
        manager.observeChat(session.chatPath);

        chatStore.appendExchange(session.chatPath, [
            { role: 'user', content: '浏览器未完成的问题' },
        ], character.name);
        const chatId = path.basename(session.chatPath, path.extname(session.chatPath));
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId,
            event: 'file-updated',
        });
        await manager.reportBrowserState({
            characterRef: character.id,
            chatId,
            event: 'generation-finished',
            operationId: 'browser-failed',
        });
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.equal(notices.length, 1);
        assert.match(notices[0], /没有有效正文/);
        assert.match(notices[0], /浏览器未完成的问题/);
        assert.equal(manager.pendingSyncByChat.size, 0);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser notification outbox is delivered after restart and then acknowledged', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-browser-outbox-session-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const first = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore: new ChatStore(chatsDir),
            characterProvider: () => [character],
            notificationDelayMs: 1,
        });
        await first.cmdSwitch('owner', character.id);
        const session = first.getCharSession('owner');
        first.queueBrowserNotification(session.chatPath, character.name, [
            { role: 'user', content: 'BROWSER_QUESTION' },
            { role: 'assistant', content: 'BROWSER_REPLY' },
        ], false, false, 'generation-finished');
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(first.pendingSync.length, 1);
        first.close();

        const notices = [];
        const restarted = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'notify' },
            chatStore: new ChatStore(chatsDir),
            characterProvider: () => [character],
            notifier: async (_userId, text) => {
                notices.push(text);
                return true;
            },
            notificationDelayMs: 1,
        });
        await restarted.handle('owner', '/whoami');
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.equal(notices.length, 1);
        assert.match(notices[0], /BROWSER_QUESTION/);
        assert.match(notices[0], /BROWSER_REPLY/);
        assert.equal(restarted.pendingSync.length, 0);
        assert.deepEqual(restarted.syncEvents.listBrowserNotifications(), []);
        restarted.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a retried inbound operation reuses its committed reply without calling the model', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-inbound-idempotency-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const chatStore = new ChatStore(chatsDir);
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let generationCalls = 0;
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore,
            characterProvider: () => [character],
            generator: async () => {
                generationCalls += 1;
                return '不应重新生成';
            },
        });
        await manager.cmdSwitch('owner', character.id);
        const session = manager.getCharSession('owner');
        chatStore.appendExchange(session.chatPath, [
            { role: 'user', content: '原始问题', operationId: 'ilink-event-1' },
            { role: 'assistant', content: '已提交回答', operationId: 'ilink-event-1' },
        ], character.name);

        const reply = await manager.handle(
            'owner',
            '原始问题',
            { operationId: 'ilink-event-1' }
        );

        assert.equal(reply, '已提交回答');
        assert.equal(generationCalls, 0);
        assert.equal(
            chatStore.parse(session.chatPath).messages
                .filter(message => message._raw?.st_wechat_operation_id === 'ilink-event-1')
                .length,
            2
        );
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('/status reports the previous operation with a safe diagnostic id', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-operation-status-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const character = {
            id: 'char_alice',
            name: 'Alice',
            file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        let excluded = '';
        const manager = new SessionManager({
            config: { chatsDir, dataRoot },
            chatStore: new ChatStore(chatsDir),
            characterProvider: () => [character],
            runtimeStatusProvider: (_userId, excludeOperationId) => {
                excluded = excludeOperationId;
                return {
                    status: 'completed',
                    stage: 'completed',
                    durationMs: 321,
                    diagnosticId: 'a1b2c3d4',
                };
            },
        });
        await manager.cmdSwitch('owner', character.id);

        const reply = await manager.handle('owner', '/status', {
            operationId: 'current-status-command',
        });

        assert.equal(excluded, 'current-status-command');
        assert.match(reply, /最近消息：已完成，耗时 321ms，诊断编号 a1b2c3d4/);
        assert.doesNotMatch(reply, /current-status-command/);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('/list supports pagination and case-insensitive search with stable global indexes', () => {
    const characters = Array.from({ length: 12 }, (_, index) => ({
        id: `char_${index + 1}`,
        name: index === 11 ? 'Special Alice' : `Role ${index + 1}`,
        file: index === 11 ? 'alice-special.json' : `role-${index + 1}.json`,
        data: { name: `Role ${index + 1}` },
    }));
    const manager = new SessionManager({
        config: { chatsDir: '.', dataRoot: '.', syncMode: 'off' },
        characterProvider: () => characters,
    });
    try {
        const secondPage = manager.cmdList('2');
        assert.match(secondPage, /第 2\/2 页/);
        assert.match(secondPage, /11\. Role 11/);
        assert.doesNotMatch(secondPage, /1\. Role 1\n/);

        const search = manager.cmdList('ALICE');
        assert.match(search, /Special Alice/);
        assert.match(search, /12\. Special Alice/);
    } finally {
        manager.close();
    }
});

test('/stop bypasses the owner queue, aborts generation and leaves chat history untouched', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-stop-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const dataRoot = path.join(directory, 'data');
        const character = {
            id: 'char_alice', name: 'Alice', file: 'Alice.json',
            data: { name: 'Alice', first_mes: '你好' },
        };
        const manager = new SessionManager({
            config: { chatsDir, dataRoot, syncMode: 'off' },
            chatStore: new ChatStore(chatsDir),
            characterProvider: () => [character],
            generator: async (_cs, _userId, _characterId, _message, _type, _extra, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        const error = new Error('cancelled');
                        error.code = 'cancelled';
                        reject(error);
                    }, { once: true });
                }),
        });
        await manager.cmdSwitch('owner', character.id);
        const before = manager.getCharSession('owner').history.length;
        const generation = manager.handle('owner', 'slow request');
        await new Promise(resolve => setImmediate(resolve));

        assert.match(await manager.handle('owner', '/stop'), /已请求停止/);
        await assert.rejects(generation, error => error.code === 'cancelled');
        assert.equal(manager.getCharSession('owner').history.length, before);
        assert.equal(manager.activeGenerations.size, 0);
        manager.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('help is layered and removed remote commands are unavailable', async () => {
    const manager = new SessionManager({
        config: { chatsDir: '.', dataRoot: '.', syncMode: 'off' },
        characterProvider: () => [],
    });
    try {
        const core = manager.cmdHelp();
        assert.match(core, /\/stop/);
        assert.doesNotMatch(core, /\/sync|\/memory|\/whoami|\/reload|\/imp/);
        assert.match(manager.cmdHelp('advanced'), /\/sync/);
        assert.match(manager.cmdHelp('advanced'), /\/memory/);
        assert.match(await manager.handleCommand('owner', '/reload'), /未知命令/);
        assert.match(await manager.handleCommand('owner', '/imp test'), /未知命令/);
    } finally {
        manager.close();
    }
});
