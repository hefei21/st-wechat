import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InboundEventStore } from '../src/inbound-event-store.js';

test('inbound cursor, contexts and pending events survive restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-inbound-events-'));
    try {
        const storePath = path.join(directory, 'ilink-events.json');
        const first = new InboundEventStore(storePath);
        const inserted = first.enqueue(textMessage('message-1', 'owner', 'hello', 'ctx-1'));
        first.setCursor('cursor-2');
        first.setContext('owner', 'ctx-1');
        first.mark(inserted.event.id, 'processing', {
            stage: 'generating',
            startedAt: 100,
        });
        assert.equal(first.latestForUser('owner').stage, 'generating');
        assert.match(first.latestForUser('owner').diagnosticId, /^[a-f0-9]{8}$/);
        first.close();

        const restored = new InboundEventStore(storePath);
        assert.equal(restored.cursor, 'cursor-2');
        assert.equal(restored.contexts.owner, 'ctx-1');
        assert.equal(restored.pending().length, 1);
        assert.equal(restored.pending()[0].status, 'pending');
        restored.mark(inserted.event.id, 'completed');
        assert.equal(restored.latestForUser('owner').status, 'completed');

        const duplicate = restored.enqueue(textMessage('message-1', 'owner', 'hello', 'ctx-1'));
        assert.equal(duplicate.inserted, false);
        assert.equal(duplicate.event.status, 'completed');
        restored.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('unsupported non-text input is persisted without retaining media content', () => {
    const store = new InboundEventStore();
    const image = store.enqueue({
        message_id: 'image-1',
        from_user_id: 'owner',
        context_token: 'ctx-image',
        item_list: [{ type: 2, image_item: { media_id: 'must-not-be-retained' } }],
    });

    assert.equal(image.inserted, true);
    assert.equal(image.event.inputKind, 'image');
    assert.equal(image.event.text, '');
    assert.equal(JSON.stringify(image.event).includes('must-not-be-retained'), false);
    assert.equal(store.pending()[0].contextToken, 'ctx-image');
});

function textMessage(id, userId, text, contextToken) {
    return {
        message_id: id,
        from_user_id: userId,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
    };
}
