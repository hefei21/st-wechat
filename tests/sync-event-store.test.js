import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SyncEventStore } from '../src/sync-event-store.js';

test('unacknowledged sync events survive restart and acknowledgements persist', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-sync-events-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const chatPath = path.join(chatsDir, 'Alice', 'chat.jsonl');
        const storePath = path.join(directory, 'data', 'sync-events.json');
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.writeFileSync(chatPath, '{}\n');

        const first = new SyncEventStore(storePath, chatsDir, {
            randomUUID: () => 'event-a',
        });
        const event = first.append(chatPath, [
            { role: 'user', content: 'WECHAT_NONCE' },
            { role: 'assistant', content: 'WECHAT_REPLY' },
        ], 'revision-a');
        first.close();

        const restored = new SyncEventStore(storePath, chatsDir);
        assert.equal(restored.list(chatPath).length, 1);
        assert.equal(restored.list(chatPath)[0].messages[0].content, 'WECHAT_NONCE');
        assert.equal(restored.acknowledge(chatPath, [event.id]), 1);
        restored.close();

        const acknowledged = new SyncEventStore(storePath, chatsDir);
        assert.deepEqual(acknowledged.list(chatPath), []);
        acknowledged.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sync events reject chat paths outside the configured chats directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-sync-boundary-'));
    try {
        const store = new SyncEventStore(
            path.join(directory, 'sync-events.json'),
            path.join(directory, 'chats')
        );
        assert.throws(
            () => store.append(path.join(directory, 'outside.jsonl'), [], ''),
            /chatsDir/
        );
        store.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser notifications survive restart until they are acknowledged', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-browser-outbox-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const chatPath = path.join(chatsDir, 'Alice', 'chat.jsonl');
        const storePath = path.join(directory, 'data', 'sync-events.json');
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.writeFileSync(chatPath, '{}\n');

        const first = new SyncEventStore(storePath, chatsDir, {
            randomUUID: () => 'browser-a',
        });
        const event = first.appendBrowserNotification(chatPath, {
            characterName: 'Alice',
            messages: [
                { role: 'user', content: 'BROWSER_QUESTION' },
                { role: 'assistant', content: 'BROWSER_REPLY' },
            ],
            event: 'generation-finished',
        });
        first.close();

        const restored = new SyncEventStore(storePath, chatsDir);
        assert.equal(restored.listBrowserNotifications().length, 1);
        assert.equal(
            restored.listBrowserNotifications()[0].messages[1].content,
            'BROWSER_REPLY'
        );
        assert.equal(restored.acknowledgeBrowserNotifications([event.id]), 1);
        restored.close();

        const acknowledged = new SyncEventStore(storePath, chatsDir);
        assert.deepEqual(acknowledged.listBrowserNotifications(), []);
        acknowledged.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unacknowledged events are never discarded by the retention hint', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-sync-retention-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const chatPath = path.join(chatsDir, 'Alice', 'chat.jsonl');
        const storePath = path.join(directory, 'sync-events.json');
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.writeFileSync(chatPath, '{}\n');
        const store = new SyncEventStore(storePath, chatsDir, {
            maxEvents: 2,
            randomUUID: (() => {
                let index = 0;
                return () => `event-${++index}`;
            })(),
        });
        for (let index = 0; index < 3; index++) {
            store.append(chatPath, [{ role: 'user', content: `message-${index}` }]);
            store.appendBrowserNotification(chatPath, {
                messages: [{ role: 'assistant', content: `reply-${index}` }],
            });
        }
        store.close();

        const restored = new SyncEventStore(storePath, chatsDir, { maxEvents: 2 });
        assert.equal(restored.list(chatPath).length, 3);
        assert.equal(restored.listBrowserNotifications().length, 3);
        restored.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
