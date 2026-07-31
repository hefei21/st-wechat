import assert from 'node:assert/strict';
import test from 'node:test';
import { splitText } from '../src/ilink.js';
import {
    formatBrowserSyncBatches,
    formatSwitchHistory,
    FULL_PREVIEW_LIMIT,
    NOTIFY_PREVIEW_LIMIT,
    projectionCost,
    SWITCH_PREVIEW_LIMIT,
    visibleLength,
} from '../src/wechat-projection.js';

test('switch preview uses recent complete turns and stays in one iLink message', () => {
    const messages = [{ role: 'assistant', content: '角色开场白' }];
    for (let index = 1; index <= 5; index++) {
        messages.push({ role: 'user', content: `问题 ${index}` });
        messages.push({ role: 'assistant', content: `回答 ${index}` });
    }

    const output = formatSwitchHistory('Alice', messages);
    assert.match(output, /历史共 5 轮，以下为最近 3 轮摘要/);
    assert.doesNotMatch(output, /角色开场白|问题 1|问题 2/);
    assert.match(output, /问题 3[\s\S]*回答 3[\s\S]*问题 5[\s\S]*回答 5/);
    assert.match(output, /另有 2 轮较早历史未展开/);
    assert.ok(projectionCost(output) <= SWITCH_PREVIEW_LIMIT);
    assert.equal(splitText(output, 2000).length, 1);
});

test('switch preview explicitly truncates long content without breaking fenced code', () => {
    const code = `\`\`\`json\n${'"key": "value"\n'.repeat(180)}\`\`\``;
    const output = formatSwitchHistory('Alice', [
        { role: 'user', content: `😀${'很长的问题。'.repeat(200)}` },
        { role: 'assistant', content: `${code}\n${'很长的回答。'.repeat(350)}` },
    ]);

    assert.ok(projectionCost(output) <= SWITCH_PREVIEW_LIMIT);
    assert.equal(splitText(output, 2000).length, 1);
    assert.match(output, /原文 \d+ 字|代码块已省略/);
    assert.equal((output.match(/```/g) || []).length % 2, 0);
});

test('notify sync prioritizes a complete recent turn and has a single-message budget', () => {
    const batches = [];
    for (let index = 1; index <= 5; index++) {
        batches.push({
            messages: [
                { role: 'user', content: `浏览器问题 ${index} ${'问题内容。'.repeat(80)}` },
                { role: 'assistant', content: `浏览器回答 ${index} ${'回答内容。'.repeat(180)}` },
            ],
        });
    }

    const output = formatBrowserSyncBatches(batches, 'notify');
    assert.doesNotMatch(output, /浏览器问题 1|浏览器回答 1/);
    assert.match(output, /浏览器问题 3[\s\S]*浏览器回答 5/);
    assert.match(output, /另有 2 轮较早的浏览器对话未展开/);
    assert.match(output, /已截断，原文 \d+ 字/);
    assert.ok(projectionCost(output) <= NOTIFY_PREVIEW_LIMIT);
    assert.equal(splitText(output, 2000).length, 1);
});

test('full sync is bounded, preserves the answer tail, and remains transport-safe', () => {
    const tail = 'FINAL-CHECKLIST-TAIL';
    const output = formatBrowserSyncBatches([{
        messages: [
            { role: 'user', content: `长问题 ${'请求。'.repeat(800)}` },
            { role: 'assistant', content: `${'详细回答。'.repeat(1800)}${tail}` },
        ],
    }], 'full');

    assert.match(output, /用户消息已截断，原文 \d+ 字/);
    assert.match(output, /角色回复已截断，原文 \d+ 字/);
    assert.match(output, new RegExp(tail));
    assert.ok(projectionCost(output) <= FULL_PREVIEW_LIMIT);
    const chunks = splitText(output, 2000);
    assert.ok(chunks.length <= 4);
    assert.ok(chunks.every(chunk => chunk.length <= 2000));
});

test('visible length counts grapheme clusters instead of UTF-16 units', () => {
    assert.equal(visibleLength('A😀家庭'), 4);
    const output = formatSwitchHistory('Emoji', [
        { role: 'user', content: '😀'.repeat(2000) },
        { role: 'assistant', content: '完成' },
    ]);
    assert.ok(projectionCost(output) <= SWITCH_PREVIEW_LIMIT);
    assert.equal(splitText(output, 2000).length, 1);
});
