import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatTracker } from '../src/chat-tracker.js';

test('chat tracker reads only appended messages after the baseline', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-tracker-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{"name":"Alice"}\n');
        const tracker = new ChatTracker();
        assert.equal(tracker.observe(filePath).initialized, true);
        fs.appendFileSync(filePath, '{"is_user":true,"mes":"hello","send_date":1}\n');
        const update = tracker.observe(filePath);
        assert.equal(update.reset, false);
        assert.deepEqual(update.addedMessages.map(item => item.content), ['hello']);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('chat tracker reports rewrites and truncation as reset events', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-tracker-reset-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{"mes":"long message"}\n');
        const tracker = new ChatTracker();
        tracker.observe(filePath);
        fs.writeFileSync(filePath, '{}\n');
        assert.equal(tracker.observe(filePath).reset, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('persisted checkpoint resumes incremental reads after restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-tracker-checkpoint-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{"name":"Alice"}\n');
        const first = new ChatTracker();
        const baseline = first.observe(filePath);
        fs.appendFileSync(filePath, '{"is_user":true,"mes":"offline update","send_date":2}\n');

        const restarted = new ChatTracker();
        const update = await restarted.observeAsync(filePath, {
            revision: baseline.revision,
            cursor: baseline.cursor,
            lastMessageFingerprint: baseline.lastMessageFingerprint,
        });
        assert.deepEqual(update.addedMessages.map(message => message.content), ['offline update']);
        assert.match(update.lastMessageFingerprint, /^[a-f0-9]{24}$/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('large offline gaps advance the cursor without replaying all content', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-tracker-overflow-'));
    try {
        const filePath = path.join(directory, 'chat.jsonl');
        fs.writeFileSync(filePath, '{"name":"Alice"}\n');
        const tracker = new ChatTracker({ maxIncrementBytes: 64 });
        tracker.observe(filePath);
        fs.appendFileSync(
            filePath,
            `${JSON.stringify({ is_user: false, mes: 'x'.repeat(200), send_date: 3 })}\n`
        );
        const update = await tracker.observeAsync(filePath);
        assert.equal(update.overflow, true);
        assert.equal(update.reset, true);
        assert.deepEqual(update.addedMessages, []);
        assert.equal(update.cursor, fs.statSync(filePath).size);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
