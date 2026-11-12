import fs from 'node:fs';
import path from 'node:path';

// 单文件行数预算：超过上限的文件需要在下方的 oversizedAllowList 里显式放行，否则只打印 warning。
// 这是体量提醒，不是门禁——warning 不改变退出码。
export const LINE_LIMIT = 500;
export const CHECKED_EXTENSIONS = ['.js', '.css'];

// 放行清单：仓库相对路径 → 放行理由。条目失效（已降到上限内或文件不存在）时也会提醒清理。
// 当前为空：所有超限文件均已拆分（需要长期超限的文件在此登记，而不是放宽上限）。
export const oversizedAllowList = {};

export function countLines(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines.length;
}

function collect(directory) {
    const output = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory())
            output.push(...collect(fullPath));
        else if (entry.isFile() && CHECKED_EXTENSIONS.includes(path.extname(entry.name)))
            output.push(fullPath);
    }
    return output;
}

// root 为仓库根目录；统计其下 src/ 的 js 与 css。
export function readLineCounts(root = process.cwd()) {
    return collect(path.join(root, 'src'))
        .sort()
        .map(file => ({
            path: path.relative(root, file).split(path.sep).join('/'),
            lines: countLines(fs.readFileSync(file, 'utf8')),
        }));
}

export function lineBudgetWarnings(entries, { limit = LINE_LIMIT, allowList = oversizedAllowList } = {}) {
    const warnings = [];
    for (const { path: file, lines } of entries) {
        const reason = allowList[file];
        if (lines > limit && !reason)
            warnings.push(`${file} 有 ${lines} 行，超过 ${limit} 行上限；如确实需要，请在 scripts/line-budget.mjs 的 oversizedAllowList 中登记理由。`);
        else if (lines <= limit && reason)
            warnings.push(`${file} 已降到 ${lines} 行（上限 ${limit}），可以从 oversizedAllowList 中移除。`);
    }
    const scanned = new Set(entries.map(entry => entry.path));
    for (const file of Object.keys(allowList)) {
        if (!scanned.has(file))
            warnings.push(`${file} 登记在 oversizedAllowList 中但不在统计范围内，请清理。`);
    }
    return warnings;
}
