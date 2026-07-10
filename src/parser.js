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
    return parsePNGChunks(buffer);
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
    const seen = new Set();
    const chars = [];

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const name = path.basename(file, ext);

        if (seen.has(name)) continue;
        seen.add(name);

        try {
            let data = null;

            if (ext === '.json') {
                const jsonPath = path.join(charsDir, file);
                data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            } else if (ext === '.png' || ext === '.webp') {
                const imgPath = path.join(charsDir, file);
                data = extractFromPNG(imgPath);
            }

            if (data) {
                chars.push({ name: data.name || name, file: file, data });
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
    const found = chars.find(c =>
        c.name === charName ||
        c.name.toLowerCase() === charName.toLowerCase()
    );
    return found || null;
}
