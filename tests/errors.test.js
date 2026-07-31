import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOperationError, publicOperationError } from '../src/errors.js';

test('public operation errors expose only classification, advice and diagnostic id', () => {
    const upstream = new Error('LLM 500: secret upstream response body');
    upstream.status = 500;

    const safe = publicOperationError(upstream, 'a1b2c3d4');

    assert.equal(classifyOperationError(upstream), 'service_unavailable');
    assert.equal(safe.type, 'service_unavailable');
    assert.equal(safe.diagnosticId, 'a1b2c3d4');
    assert.match(safe.message, /稍后重试/);
    assert.match(safe.message, /诊断编号：a1b2c3d4/);
    assert.doesNotMatch(safe.message, /secret|upstream|LLM 500/);
});

test('queue overload remains actionable without exposing internal details', () => {
    const error = new Error('当前消息队列已满（最多 20 条），本条未处理，请稍后重新发送。');
    error.code = 'queue_overloaded';

    const safe = publicOperationError(error, 'queue123');

    assert.equal(safe.type, 'queue_overloaded');
    assert.match(safe.message, /本条未处理/);
    assert.match(safe.message, /queue123/);
});

test('cancelled, billing and context failures have distinct actionable messages', () => {
    for (const [code, expected] of [
        ['cancelled', /没有写入/],
        ['billing', /余额或额度不足/],
        ['context_limit', /上下文上限/],
    ]) {
        const error = new Error('hidden provider detail');
        error.code = code;
        const safe = publicOperationError(error, `${code}1`);
        assert.equal(safe.type, code);
        assert.match(safe.message, expected);
        assert.doesNotMatch(safe.message, /hidden provider detail/);
    }
});
