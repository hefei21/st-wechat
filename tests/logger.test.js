import assert from 'node:assert/strict';
import test from 'node:test';
import { pseudonymizeId, redact } from '../src/logger.js';

test('redact hides sensitive object fields and bearer tokens', () => {
    const value = redact({
        apiKey: 'sk-example-secret',
        nested: { token: 'ilink_secret_value' },
        message: 'Authorization: Bearer abc.def.ghi',
        url: 'https://example.com/models?api_key=visible-to-redactor',
        safe: 'visible',
    });

    assert.equal(value.apiKey, '[REDACTED]');
    assert.equal(value.nested.token, '[REDACTED]');
    assert.equal(value.message, 'Authorization: Bearer [REDACTED]');
    assert.equal(value.url, 'https://example.com/models?api_key=[REDACTED]');
    assert.equal(value.safe, 'visible');
});

test('user identifiers are represented by a stable non-reversible pseudonym', () => {
    const first = pseudonymizeId('wechat-user-123');
    const repeated = pseudonymizeId('wechat-user-123');
    const other = pseudonymizeId('wechat-user-456');

    assert.equal(first, repeated);
    assert.notEqual(first, other);
    assert.match(first, /^user#[a-f0-9]{12}$/);
    assert.doesNotMatch(first, /wechat-user-123/);
});
