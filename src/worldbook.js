/**
 * worldbook.js - 世界书加载与关键词匹配
 *
 * 从 ST 的 worlds/ 目录加载世界书，
 * 根据当前对话内容匹配激活的条目，
 * 按 depth 分组返回用于提示词注入。
 */
import fs from 'node:fs';
import path from 'node:path';

export class WorldBook {
    /**
     * @param {string} worldsDir - ST 的 worlds/ 目录路径
     */
    constructor(worldsDir) {
        this.worldsDir = worldsDir;
        this.allEntries = [];
        this.refresh();
    }

    /**
     * 重新加载所有世界书
     */
    refresh() {
        this.allEntries = [];
        if (!fs.existsSync(this.worldsDir)) return;

        const files = fs.readdirSync(this.worldsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const world = JSON.parse(
                    fs.readFileSync(path.join(this.worldsDir, file), 'utf-8')
                );
                for (const entry of world.entries || []) {
                    // 跳过被禁用的条目
                    if (entry.enabled === false || entry.disable === true) continue;

                    // 标准化 keys
                    const keys = entry.keys
                        ? (Array.isArray(entry.keys) ? entry.keys : [entry.keys])
                        : entry.key
                            ? (Array.isArray(entry.key) ? entry.key : [entry.key])
                            : [];

                    this.allEntries.push({
                        id: entry.id || entry.uid,
                        keys,
                        content: entry.content || '',
                        depth: entry.depth ?? entry.constant ? 0 : 4,
                        order: entry.order ?? entry.insertion_order ?? 100,
                        caseSensitive: entry.case_sensitive ?? false,
                        selective: entry.selective ?? false,
                    });
                }
            } catch (err) {
                // 跳过无法解析的文件
            }
        }

        // 按 order 排序
        this.allEntries.sort((a, b) => a.order - b.order);
    }

    /**
     * 根据对话上下文匹配激活的世界书条目
     * @param {string} contextText - 用于匹配的文本（最近的几条消息）
     * @returns {{ before: string, after: string }} 按位置分组的条目内容
     */
    match(contextText) {
        const before = [];
        const after = [];

        for (const entry of this.allEntries) {
            if (entry.keys.length === 0) {
                // 没有 key 的条目视为始终激活
                this.addEntry(entry, before, after);
                continue;
            }

            const matched = entry.keys.some(k => {
                if (entry.caseSensitive) {
                    return contextText.includes(k);
                }
                return contextText.toLowerCase().includes(k.toLowerCase());
            });

            if (matched || entry.selective === false) {
                this.addEntry(entry, before, after);
            }
        }

        return {
            before: before.join('\n'),
            after: after.join('\n'),
        };
    }

    /**
     * 按 depth 分组添加条目
     * depth <= 4: before（注入到消息历史之前）
     * depth > 4: after（注入到消息历史之后）
     */
    addEntry(entry, before, after) {
        if (entry.depth <= 4) {
            before.push(entry.content);
        } else {
            after.push(entry.content);
        }
    }

    /**
     * 获取条目总数（用于 /world 命令显示）
     */
    getCount() {
        return this.allEntries.length;
    }
}
