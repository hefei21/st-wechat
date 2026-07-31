import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OwnerStore } from '../src/owner-store.js';

test('owner must claim with the local one-time code and persists as a hash', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-owner-'));
    try {
        const filePath = path.join(directory, 'owner.json');
        const store = new OwnerStore(filePath, { randomInt: () => 123456 });

        assert.equal(store.getClaimCode(), '123456');
        assert.equal(store.claim('owner-user-id', '000000'), false);
        assert.equal(store.claim('owner-user-id', '123456'), true);
        assert.equal(store.isOwner('owner-user-id'), true);
        assert.equal(store.isOwner('other-user-id'), false);

        const raw = fs.readFileSync(filePath, 'utf8');
        assert.equal(raw.includes('owner-user-id'), false);

        const restarted = new OwnerStore(filePath);
        assert.equal(restarted.isOwner('owner-user-id'), true);
        assert.equal(restarted.getClaimCode(), null);
        const nextCode = restarted.reset();
        assert.match(nextCode, /^\d{6}$/);
        assert.equal(restarted.isClaimed(), false);
        assert.equal(restarted.isOwner('owner-user-id'), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
