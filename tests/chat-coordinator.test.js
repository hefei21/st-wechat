import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatCoordinator } from '../src/chat-coordinator.js';

test('same chat operations are serialized while different chats can run independently', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-coordinator-'));
    try {
        const first = path.join(directory, 'first.jsonl');
        const second = path.join(directory, 'second.jsonl');
        fs.writeFileSync(first, '{}\n');
        fs.writeFileSync(second, '{}\n');
        const coordinator = new ChatCoordinator();
        const events = [];
        const a = coordinator.run(first, async () => {
            events.push('a-start');
            await new Promise(resolve => setTimeout(resolve, 20));
            events.push('a-end');
        });
        const b = coordinator.run(first, async () => events.push('b'));
        const c = coordinator.run(second, async () => events.push('c'));
        await Promise.all([a, b, c]);
        assert.ok(events.indexOf('b') > events.indexOf('a-end'));
        assert.ok(events.indexOf('c') < events.indexOf('b'));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('revision conflicts retry at most once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-conflict-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{}\n');
        const coordinator = new ChatCoordinator();
        let attempts = 0;
        const result = await coordinator.run(filePath, async ({ assertUnchanged }) => {
            attempts++;
            if (attempts === 1) fs.appendFileSync(filePath, '{"changed":true}\n');
            assertUnchanged();
            return 'ok';
        });
        assert.equal(result, 'ok');
        assert.equal(attempts, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an active Bot generation rejects a late browser lease', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-late-lease-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{}\n');
        const coordinator = new ChatCoordinator({ pollMs: 5 });
        let releaseFirstAttempt;
        const firstAttemptGate = new Promise(resolve => { releaseFirstAttempt = resolve; });

        const operation = coordinator.run(filePath, async ({ prepareWrite }) => {
            assert.equal(coordinator.isActive(filePath), true);
            await firstAttemptGate;
            await prepareWrite();
            fs.appendFileSync(filePath, '{"source":"bot"}\n');
            return 'bot';
        });

        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(coordinator.acquireLease(filePath, 'browser-generation'), false);
        releaseFirstAttempt();

        assert.equal(await operation, 'bot');
        assert.equal(coordinator.isActive(filePath), false);
        const content = fs.readFileSync(filePath, 'utf8');
        assert.doesNotMatch(content, /"source":"browser"/);
        assert.match(content, /"source":"bot"/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser lease blocks another lease and expires safely', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-lease-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{}\n');
        const coordinator = new ChatCoordinator({ leaseTtlMs: 20, pollMs: 5 });
        assert.equal(coordinator.acquireLease(filePath, 'browser-a'), true);
        assert.equal(coordinator.acquireLease(filePath, 'browser-b'), false);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(coordinator.acquireLease(filePath, 'browser-b'), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an existing browser lease delays a Bot task until release', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-browser-first-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{}\n');
        const coordinator = new ChatCoordinator({ pollMs: 2 });
        assert.equal(coordinator.acquireLease(filePath, 'browser-generation'), true);

        let started = false;
        const operation = coordinator.run(filePath, async () => {
            started = true;
            return 'bot';
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(started, false);

        assert.equal(coordinator.releaseLease(filePath, 'browser-generation'), true);
        assert.equal(await operation, 'bot');
        assert.equal(started, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('browser lease rejects a missing operation id', () => {
    const coordinator = new ChatCoordinator();
    assert.equal(coordinator.acquireLease('chat.jsonl', null), false);
    assert.equal(coordinator.renewLease('chat.jsonl', ''), false);
    assert.equal(coordinator.releaseLease('chat.jsonl', undefined), false);
});
