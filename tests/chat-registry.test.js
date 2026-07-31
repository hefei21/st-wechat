import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatRegistry } from '../src/chat-registry.js';

test('chat registry persists independent bot and browser selections', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-registry-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const first = path.join(chatsDir, 'Alice', 'first.jsonl');
        const second = path.join(chatsDir, 'Alice', 'second.jsonl');
        fs.mkdirSync(path.dirname(first), { recursive: true });
        fs.writeFileSync(first, '{}\n');
        fs.writeFileSync(second, '{}\n');

        const filePath = path.join(directory, 'state', 'chat-registry.json');
        const registry = new ChatRegistry(filePath, chatsDir);
        registry.setBotSelection('char_alice', first);
        registry.setBrowserSelection('char_alice', second);
        assert.equal(registry.isSameCurrentChat('char_alice'), false);
        registry.flush();

        const restarted = new ChatRegistry(filePath, chatsDir);
        assert.equal(restarted.getBotSelection('char_alice').chatPath, path.resolve(first));
        restarted.setBrowserSelection('char_alice', first);
        assert.equal(restarted.isSameCurrentChat('char_alice'), true);
        restarted.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('chat registry rejects paths outside chatsDir', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-registry-path-'));
    try {
        const registry = new ChatRegistry(
            path.join(directory, 'state.json'),
            path.join(directory, 'chats')
        );
        assert.throws(
            () => registry.setBotSelection('char_alice', path.join(directory, 'outside.jsonl')),
            /chatsDir/
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a historical matching path is not current after the Bot switches characters', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-registry-character-'));
    try {
        const chatsDir = path.join(directory, 'chats');
        const alice = path.join(chatsDir, 'Alice', 'chat.jsonl');
        const bob = path.join(chatsDir, 'Bob', 'chat.jsonl');
        fs.mkdirSync(path.dirname(alice), { recursive: true });
        fs.mkdirSync(path.dirname(bob), { recursive: true });
        fs.writeFileSync(alice, '{}\n');
        fs.writeFileSync(bob, '{}\n');

        const registry = new ChatRegistry(path.join(directory, 'state.json'), chatsDir);
        registry.setBotSelection('char_alice', alice);
        registry.setBrowserSelection('char_alice', alice);
        assert.equal(registry.isSameCurrentChat('char_alice'), true);

        registry.setBotSelection('char_bob', bob);
        assert.equal(registry.isSameCurrentChat('char_alice'), false);
        registry.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
