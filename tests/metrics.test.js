import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeMetrics } from '../src/metrics.js';

test('runtime metrics expose aggregate values without message content', () => {
    const metrics = new RuntimeMetrics({ maxRecentErrors: 2 });
    metrics.increment('messagesReceived', 3);
    metrics.increment('messagesCompleted', 2);
    metrics.increment('messagesFailed');
    metrics.increment('generationsSucceeded', 2);
    metrics.increment('generationsFailed');
    metrics.timing('generation', 900);
    metrics.timing('send', 120);
    metrics.usage({ input: 80, output: 20, estimated: true });
    metrics.error('timeout', 'abc-123! secret content');

    const snapshot = metrics.snapshot({ queueDepth: 4, activeGenerations: 1, pendingSync: 2 });
    assert.equal(snapshot.messagesReceived, 3);
    assert.equal(snapshot.messageSuccessRate, 0.6667);
    assert.equal(snapshot.generationSuccessRate, 0.6667);
    assert.equal(snapshot.averageGenerationMs, 300);
    assert.equal(snapshot.averageSendMs, 0);
    assert.deepEqual(snapshot.tokenUsage, { input: 80, output: 20, estimated: 1 });
    assert.equal(snapshot.queueDepth, 4);
    assert.deepEqual(snapshot.recentErrors[0], {
        at: snapshot.recentErrors[0].at,
        type: 'timeout',
        diagnosticId: 'abc-123secretcontent',
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /secret content/i);
});

test('runtime metrics retain only the configured number of redacted errors', () => {
    const metrics = new RuntimeMetrics({ maxRecentErrors: 2 });
    metrics.error('network', 'one');
    metrics.error('timeout', 'two');
    metrics.error('billing', 'three');
    assert.deepEqual(metrics.snapshot().recentErrors.map(item => item.type), ['billing', 'timeout']);
});
