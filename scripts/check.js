import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirs = ['src', 'ui-extension', 'scripts', 'tests'];
const ignoredFiles = new Set(['qrcode.min.js']);
const files = [];

for (const dirName of sourceDirs) {
    const dir = path.join(projectRoot, dirName);
    if (!fs.existsSync(dir)) continue;
    collectJavaScript(dir, files);
}

let failed = false;
for (const file of files.sort()) {
    if (ignoredFiles.has(path.basename(file))) continue;
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        failed = true;
        process.stderr.write(result.stderr || result.stdout);
    }
}

if (failed) process.exit(1);
console.log(`[check] ${files.length - ignoredFiles.size} 个 JavaScript 文件通过语法检查`);

function collectJavaScript(dir, output) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) collectJavaScript(fullPath, output);
        else if (entry.isFile() && entry.name.endsWith('.js')) output.push(fullPath);
    }
}
