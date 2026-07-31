import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    extractFromPNG,
    listCharacters,
    loadCharacter,
    normalizeCharacterCard,
    stableCharacterId,
} from '../src/parser.js';

test('listCharacters only exposes installed PNG cards and ignores loose JSON imports', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-parser-'));
    try {
        fs.copyFileSync('tests/fixtures/characters/v1.json', path.join(tempDir, 'v1.json'));
        fs.writeFileSync(path.join(tempDir, 'broken.json'), '{');
        const base64 = fs.readFileSync('tests/fixtures/characters/png-card.base64', 'utf8').trim();
        fs.writeFileSync(path.join(tempDir, 'card.png'), Buffer.from(base64, 'base64'));
        const characters = listCharacters(tempDir);
        assert.equal(characters.length, 1);
        assert.equal(characters[0].name, 'PNG测试角色');
        assert.equal(characters[0].file, 'card.png');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('extractFromPNG reads a ccv3 fixture without real character data', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-png-'));
    try {
        const pngPath = path.join(tempDir, 'card.png');
        const base64 = fs.readFileSync('tests/fixtures/characters/png-card.base64', 'utf8').trim();
        fs.writeFileSync(pngPath, Buffer.from(base64, 'base64'));
        const character = extractFromPNG(pngPath);
        assert.equal(character.name, 'PNG测试角色');
        assert.equal(character.first_mes, 'PNG开场');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('normalizeCharacterCard produces the same internal fields for V1 and V2', () => {
    const v1 = normalizeCharacterCard(JSON.parse(
        fs.readFileSync('tests/fixtures/characters/v1.json', 'utf8')
    ));
    const v2 = normalizeCharacterCard(JSON.parse(
        fs.readFileSync('tests/fixtures/characters/v2.json', 'utf8')
    ));

    for (const card of [v1, v2]) {
        assert.equal(typeof card.name, 'string');
        assert.equal(typeof card.description, 'string');
        assert.equal(typeof card.first_mes, 'string');
        assert.equal(typeof card.mes_example, 'string');
        assert.equal(Array.isArray(card.alternate_greetings), true);
        assert.equal(typeof card.extensions, 'object');
    }
    assert.equal(v2.name, '测试角色');
    assert.equal(v2.first_mes, '你好，这是测试开场白。');
});

test('stable character id follows the file identity instead of display name', () => {
    assert.equal(stableCharacterId('Alice.png'), stableCharacterId('alice.PNG'));
    assert.notEqual(stableCharacterId('Alice.png'), stableCharacterId('Bob.png'));
});

test('duplicate display names are resolved by stable id or filename, not ambiguously by name', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-parser-duplicates-'));
    try {
        const base64 = fs.readFileSync('tests/fixtures/characters/png-card.base64', 'utf8').trim();
        const png = Buffer.from(base64, 'base64');
        fs.writeFileSync(path.join(tempDir, 'alice-a.png'), png);
        fs.writeFileSync(path.join(tempDir, 'alice-b.png'), png);

        const characters = listCharacters(tempDir);
        assert.equal(characters.length, 2);
        assert.equal(loadCharacter(tempDir, 'PNG测试角色'), null);
        assert.equal(loadCharacter(tempDir, 'alice-a')?.file, 'alice-a.png');
        assert.equal(loadCharacter(tempDir, characters[1].id)?.file, characters[1].file);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('WebP cards are explicitly skipped until metadata parsing is supported', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wechat-parser-webp-'));
    try {
        fs.writeFileSync(path.join(tempDir, 'unsupported.webp'), Buffer.from('RIFF'));
        assert.deepEqual(listCharacters(tempDir), []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
