import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnostics, buildHealth } from '../src/diagnostics.js';

test('health exposes only minimal live state', () => {
    const result = buildHealth({
        running: true, connected: true, connectionState: 'online',
        token: 'secret-token', userId: 'secret-user', characters: ['secret-role'],
    }, 12);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, state: 'online', uptimeSeconds: 12 });
});

test('diagnostics explicitly redacts credentials, endpoints, users and chat content', () => {
    const report = buildDiagnostics({
        state: {
            running: true, loggedIn: true, connectionState: 'online',
            token: 'secret-token', userId: 'secret-user',
        },
        llm: {
            provider: 'deepseek', model: 'test-model', apiKey: 'secret-key',
            endpoint: 'https://secret-endpoint.invalid',
        },
        ownerClaimed: true,
        metrics: { messagesCompleted: 1 },
        version: '1.2.3',
    });
    const json = JSON.stringify(report);
    assert.equal(report.llm.apiKeyConfigured, true);
    assert.doesNotMatch(json, /secret-token|secret-user|secret-key|secret-endpoint/);
    assert.deepEqual(Object.keys(report.llm), ['provider', 'model', 'apiKeyConfigured']);
});
