import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldBook, normalizeEntries } from '../src/worldbook.js';

const fixtureDir = path.resolve('tests/fixtures/worlds');

test('only explicitly selected or character-bound books are active', () => {
    const inactive = new WorldBook(fixtureDir);
    assert.deepEqual(inactive.match('这里有一条龙'), {
        before: '',
        after: '',
        activated: [],
    });

    const global = new WorldBook(fixtureDir, { globalBooks: ['测试世界'] });
    const matched = global.match('这里有一条龙');
    assert.match(matched.before, /龙生活在测试山谷/);
    assert.match(matched.after, /常驻设定/);

    const characterBound = new WorldBook(fixtureDir);
    const byCharacter = characterBound.match('这里有一条龙', {
        character: { name: '角色', extensions: { world: '测试世界' } },
    });
    assert.match(byCharacter.before, /龙生活在测试山谷/);
});

test('unmatched keyed entries stay inactive while constant entries activate', () => {
    const world = new WorldBook(fixtureDir, { globalBooks: ['测试世界'] });
    const result = world.match('这里没有关键词');
    assert.doesNotMatch(result.before, /龙生活/);
    assert.match(result.after, /常驻设定/);
});

test('depth and object-shaped entries are normalized correctly', () => {
    const entries = normalizeEntries({
        a: { uid: 1, key: ['x'], content: 'x', depth: 8 },
        b: { uid: 2, key: [], content: 'always', constant: true },
    }, 'book');
    assert.equal(entries[0].depth, 8);
    assert.equal(entries[1].depth, 0);
});

test('selective secondary logic is applied', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-world-'));
    try {
        fs.writeFileSync(path.join(tempDir, 'selective.json'), JSON.stringify({
            entries: [{
                uid: 1,
                key: ['城堡'],
                keysecondary: ['夜晚', '月亮'],
                selective: true,
                selectiveLogic: 3,
                content: '夜晚的城堡',
            }],
        }));
        const world = new WorldBook(tempDir, { globalBooks: ['selective'] });
        assert.equal(world.match('夜晚的城堡').before, '');
        assert.match(world.match('月亮照着夜晚的城堡').before, /夜晚的城堡/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('probability can be tested deterministically', () => {
    const entries = normalizeEntries([{
        uid: 1,
        key: ['x'],
        content: 'random',
        useProbability: true,
        probability: 50,
    }], 'embedded');
    const world = new WorldBook('__missing__', { random: () => 0.75 });
    world.getActiveEntries = () => entries;
    assert.equal(world.match('x').before, '');
});
