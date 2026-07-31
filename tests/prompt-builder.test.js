import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildContinueMessages,
    buildImpersonateMessages,
    buildMessages,
    fitHistoryToBudget,
} from '../src/prompt-builder.js';

test('buildMessages produces deterministic system, history, and user ordering', () => {
    const result = buildMessages({
        char: { data: { name: '测试角色', description: '角色描述' } },
        persona: { name: '测试用户', description: '用户描述' },
        username: '测试用户',
        prompts: {},
        history: [{ role: 'assistant', content: '上一条' }],
        message: '新消息',
        worldBook: null,
        summary: '',
    });
    assert.deepEqual(result.messages.map(message => message.role), ['system', 'assistant', 'user']);
    assert.match(result.messages[0].content, /角色描述/);
    assert.equal(result.messages.at(-1).content, '新消息');
});

test('world book entries are injected even when templates have no world macros', () => {
    const result = buildMessages({
        char: { data: { name: '测试角色', description: '角色描述' } },
        persona: null,
        username: '测试用户',
        prompts: {},
        history: [],
        message: '紫色钥匙',
        worldBook: {
            match: () => ({
                before: '常驻世界设定',
                after: '回复末尾添加 WB-M1-PASS',
            }),
        },
        summary: '',
    });

    const system = result.messages.find(message => message.role === 'system').content;
    assert.match(system, /常驻世界设定/);
    assert.match(system, /回复末尾添加 WB-M1-PASS/);
});

test('world book entries already rendered by a template are not duplicated', () => {
    const result = buildMessages({
        char: { data: { name: '测试角色' } },
        persona: null,
        username: '测试用户',
        prompts: { contextTemplate: '{{wiBefore}}\n{{wiAfter}}' },
        history: [],
        message: '紫色钥匙',
        worldBook: {
            match: () => ({
                before: '唯一前置条目',
                after: '唯一后置条目',
            }),
        },
        summary: '',
    });

    const system = result.messages.find(message => message.role === 'system').content;
    assert.equal(system.match(/唯一前置条目/g)?.length, 1);
    assert.equal(system.match(/唯一后置条目/g)?.length, 1);
});

test('character examples are merged into the single system message', () => {
    const result = buildMessages({
        char: { data: { name: '测试角色', mes_example: '示例对话' } },
        persona: null,
        username: 'User',
        prompts: {},
        history: [],
        message: '你好',
        worldBook: null,
        summary: '',
    });
    assert.equal(result.messages.filter(message => message.role === 'system').length, 1);
    assert.match(result.messages[0].content, /示例对话/);
});

test('golden prompt order is rules, character, persona, world, memory, examples, history', () => {
    const result = buildMessages({
        char: {
            data: {
                name: '角色标记',
                description: '角色描述标记',
                mes_example: '示例标记',
            },
        },
        persona: { name: '用户', description: 'Persona标记' },
        username: '用户',
        prompts: { systemPrompt: '系统规则标记' },
        history: [{ role: 'assistant', content: '历史标记' }],
        message: '当前消息',
        worldBook: { match: () => ({ before: '世界书标记', after: '' }) },
        summary: '记忆标记',
    });
    const system = result.messages[0].content;
    const orderedMarkers = [
        '系统规则标记',
        '角色描述标记',
        'Persona标记',
        '世界书标记',
        '记忆标记',
        '示例标记',
    ];
    let previous = -1;
    for (const marker of orderedMarkers) {
        const current = system.indexOf(marker);
        assert.ok(current > previous, `${marker} 应按固定顺序出现`);
        previous = current;
    }
    assert.equal(result.messages[1].content, '历史标记');
});

test('history budget preserves recent messages and drops older messages', () => {
    const history = [
        { role: 'user', content: '旧'.repeat(80) },
        { role: 'assistant', content: '中'.repeat(80) },
        { role: 'user', content: '最新问题' },
        { role: 'assistant', content: '最新回答' },
    ];
    const selected = fitHistoryToBudget({
        system: '系统',
        history,
        message: '当前',
        maxContextTokens: 100,
        maxOutputTokens: 40,
        charsPerToken: 2,
    });
    assert.deepEqual(selected, history.slice(-2));
});

test('continue and impersonate preserve the configured context budget', () => {
    const common = {
        char: { data: { name: '测试角色' } },
        persona: null,
        username: 'User',
        prompts: {},
        history: [
            { role: 'user', content: '旧'.repeat(100) },
            { role: 'assistant', content: '最近回答' },
        ],
        worldBook: null,
        summary: '',
        maxContextTokens: 80,
        maxOutputTokens: 50,
        charsPerToken: 2,
    };
    const continued = buildContinueMessages({ ...common, direction: '继续' });
    const impersonated = buildImpersonateMessages({ ...common, sentence: '回答' });
    assert.equal(continued.messages.some(message => message.content === '旧'.repeat(100)), false);
    assert.equal(impersonated.messages.some(message => message.content === '旧'.repeat(100)), false);
});
