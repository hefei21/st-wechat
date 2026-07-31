import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createGenerationOperationId,
    finalizeGenerationLifecycle,
    isEmptyAssistantMessage,
    shouldAcquireBrowserLease,
    waitForBrowserLease,
    waitForGenerationSettled,
} from '../ui-extension/generation-lifecycle.js';

test('generation operation id falls back when randomUUID is unavailable', () => {
    const cryptoApi = {
        getRandomValues(bytes) {
            bytes.fill(0xab);
            return bytes;
        },
    };
    const operationId = createGenerationOperationId(cryptoApi, () => 1234567890);
    assert.equal(operationId, `browser-1234567890-${'ab'.repeat(16)}`);
});

test('generation operation id has a last-resort fallback without Web Crypto', () => {
    const operationId = createGenerationOperationId(null, () => 42, () => 0.5);
    assert.equal(operationId, `browser-42-${'80'.repeat(16)}`);
});

test('browser lease ignores prompt dry-runs and non-mutating quiet generations', () => {
    assert.equal(shouldAcquireBrowserLease('normal', true), false);
    assert.equal(shouldAcquireBrowserLease('quiet', false), false);
    assert.equal(shouldAcquireBrowserLease('normal', false), true);
    assert.equal(shouldAcquireBrowserLease('regenerate', false), true);
});

test('empty assistant detection distinguishes reasoning-only output from a valid reply', () => {
    assert.equal(isEmptyAssistantMessage({ is_user: false, mes: '', extra: { reasoning: 'thinking' } }), true);
    assert.equal(isEmptyAssistantMessage({ is_user: false, mes: '最终回答' }), false);
    assert.equal(isEmptyAssistantMessage({ is_user: true, mes: '' }), false);
});

test('browser generation settles and confirms its lease before saving and releasing', async () => {
    const events = [];
    await finalizeGenerationLifecycle({
        waitUntilSettled: async () => events.push('settled'),
        waitForLease: async () => events.push('lease-acquired'),
        saveChat: async () => events.push('saved'),
        reportFinished: async () => events.push('lease-released'),
        cleanup: () => events.push('cleaned'),
        applyPendingReload: async () => events.push('reloaded'),
    });
    assert.deepEqual(events, [
        'settled',
        'lease-acquired',
        'saved',
        'lease-released',
        'cleaned',
        'reloaded',
    ]);
});

test('browser generation always cleans up when the final save fails', async () => {
    const events = [];
    await assert.rejects(
        finalizeGenerationLifecycle({
            saveChat: async () => {
                events.push('save-failed');
                throw new Error('save failed');
            },
            reportFinished: async () => events.push('must-not-release'),
            cleanup: () => events.push('cleaned'),
            applyPendingReload: async () => events.push('reloaded'),
        }),
        /save failed/
    );
    assert.deepEqual(events, ['save-failed', 'cleaned', 'reloaded']);
});

test('browser generation waits and retries lease acquisition instead of throwing', async () => {
    const attempts = [];
    const notices = [];
    const result = await waitForBrowserLease({
        acquire: async () => {
            attempts.push(attempts.length + 1);
            if (attempts.length === 1) return { lease: false };
            if (attempts.length === 2) throw new Error('temporary network failure');
            return { lease: true, revision: 'ready' };
        },
        onWaiting: () => notices.push('waiting'),
        pollMs: 1,
        delay: async () => undefined,
    });

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(notices, ['waiting']);
    assert.equal(result.waited, true);
    assert.equal(result.state.revision, 'ready');
});

test('generation settle waits until generation stops and stream activity is quiet', async () => {
    let time = 0;
    let generating = true;
    let lastActivityAt = 0;
    const settled = await waitForGenerationSettled({
        isGenerating: () => generating,
        getLastActivityAt: () => lastActivityAt,
        quietMs: 100,
        maxWaitMs: 1000,
        pollMs: 25,
        now: () => time,
        delay: async ms => {
            time += ms;
            if (time === 50) {
                generating = false;
                lastActivityAt = time;
            }
        },
    });
    assert.equal(settled, true);
    assert.equal(time, 150);
});

test('generation settle has a bounded fallback when upstream state never clears', async () => {
    let time = 0;
    const settled = await waitForGenerationSettled({
        isGenerating: () => true,
        getLastActivityAt: () => time,
        maxWaitMs: 100,
        pollMs: 25,
        now: () => time,
        delay: async ms => { time += ms; },
    });
    assert.equal(settled, false);
    assert.equal(time, 100);
});
