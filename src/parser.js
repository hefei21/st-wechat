/**
 * parser.js - PNG 角色卡元数据解析器
 *
 * SillyTavern 的角色卡是 PNG 图片，角色 JSON 数据嵌入在 PNG chunk 中。
 * 支持两种格式：
 *   - 旧格式: tEXt chunk 中 key 为 "ccv3"，value 为 base64 编码的 JSON
 *   - CharX 格式: 多 chunk 嵌入
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 从 PNG 文件中提取角色数据
 * @param {string} pngPath - PNG 文件路径
 * @returns {object|null} 角色数据
 */
export function extractFromPNG(pngPath) {
    const buffer = fs.readFileSync(pngPath);
    const parsed = parsePNGChunks(buffer);
    return parsed ? normalizeCharacterCard(parsed) : null;
}

/**
 * 解析 PNG chunk 结构，查找角色数据
 */
function parsePNGChunks(buffer) {
    // PNG 签名: 8 bytes
    // Chunk: [4字节length][4字节type][data][4字节CRC]
    let offset = 8;

    while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;

        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('utf-8', offset + 4, offset + 8);

        if (offset + 12 + length > buffer.length) break;

        const data = buffer.subarray(offset + 8, offset + 8 + length);

        if (type === 'tEXt') {
            // tEXt chunk: key\0value
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1) {
                const key = data.toString('utf-8', 0, nullIdx);
                const value = data.toString('utf-8', nullIdx + 1);

                // 旧格式: ccv3 key
                if (key === 'ccv3') {
                    try {
                        const decoded = Buffer.from(value, 'base64').toString('utf-8');
                        const parsed = JSON.parse(decoded);
                        // 可能是 { data: {...} } 或直接是角色数据
                        return parsed.data || parsed;
                    } catch {
                        // 不是 base64，跳过
                    }
                }

                // CharX 格式: chara key
                if (key === 'chara') {
                    try {
                        const decoded = Buffer.from(value, 'base64').toString('utf-8');
                        return JSON.parse(decoded);
                    } catch {
                        // 解码失败
                    }
                }
            }
        }

        offset += 12 + length;
    }

    return null;
}

/**
 * 加载目录下的所有角色卡
 * @param {string} charsDir - 角色卡目录
 * @returns {Array<{name: string, data: object}>}
 */
export function listCharacters(charsDir) {
    if (!fs.existsSync(charsDir)) return [];

    const files = fs.readdirSync(charsDir);
    const chars = [];

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const name = path.basename(file, ext);

        // SillyTavern stores installed character cards as PNG files. JSON is an
        // import/export format: dropping it into the characters directory does
        // not make it visible in the SillyTavern UI. Treating those files as
        // installed characters would create Bot-only "ghost" roles.
        if (ext === '.webp') {
            console.warn(`[Parser] 暂不支持 WebP 角色卡: ${file}`);
            continue;
        }
        if (ext !== '.png') continue;

        try {
            const imgPath = path.join(charsDir, file);
            const data = extractFromPNG(imgPath);

            if (data) {
                chars.push({
                    id: stableCharacterId(file),
                    name: data.name || name,
                    file,
                    data,
                });
            }
        } catch (err) {
            console.warn(`[Parser] 加载角色失败: ${file} - ${err.message}`);
        }
    }

    return chars;
}

/**
 * 加载单个角色卡
 * @param {string} charsDir - 角色卡目录
 * @param {string} charName - 角色名称
 * @returns {object|null}
 */
export function loadCharacter(charsDir, charName) {
    const chars = listCharacters(charsDir);
    const query = String(charName || '').trim().toLowerCase();
    if (!query) return null;

    const byId = chars.find(character => character.id.toLowerCase() === query);
    if (byId) return byId;

    const byFile = chars.find(character =>
        path.basename(character.file).toLowerCase() === query
        || path.basename(character.file, path.extname(character.file)).toLowerCase() === query
    );
    if (byFile) return byFile;

    const byName = chars.filter(character => character.name.toLowerCase() === query);
    return byName.length === 1 ? byName[0] : null;
}

/**
 * 将 Character Card V1/V2/V3 及 SillyTavern 包装格式统一为内部结构。
 */
export function normalizeCharacterCard(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('角色卡必须是 JSON 对象');
    }

    const source = input.data && typeof input.data === 'object' && !Array.isArray(input.data)
        ? input.data
        : input;
    const name = stringField(source.name);
    if (!name) throw new Error('角色卡缺少 name');

    return {
        ...source,
        name,
        description: stringField(source.description),
        personality: stringField(source.personality),
        scenario: stringField(source.scenario),
        first_mes: stringField(source.first_mes ?? source.first_message),
        mes_example: stringField(source.mes_example ?? source.example_dialogue),
        creator_notes: stringField(source.creator_notes),
        system_prompt: stringField(source.system_prompt),
        post_history_instructions: stringField(source.post_history_instructions),
        alternate_greetings: stringArray(source.alternate_greetings),
        tags: stringArray(source.tags),
        extensions: objectField(source.extensions),
        character_book: objectOrNull(source.character_book),
        spec: stringField(input.spec),
        spec_version: stringField(input.spec_version),
    };
}

export function stableCharacterId(fileName) {
    const fileKey = path.basename(String(fileName || ''), path.extname(String(fileName || '')))
        .normalize('NFKC')
        .trim()
        .toLowerCase();
    if (!fileKey) throw new Error('角色文件名不能为空');
    return `char_${crypto.createHash('sha256').update(fileKey).digest('hex').slice(0, 16)}`;
}

function stringField(value) {
    return typeof value === 'string' ? value : '';
}

function stringArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function objectField(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function objectOrNull(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
