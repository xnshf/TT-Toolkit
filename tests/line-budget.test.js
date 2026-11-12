import { describe, expect, it } from 'vitest';
import { countLines, lineBudgetWarnings } from '../scripts/line-budget.mjs';

const options = (allowList) => ({ limit: 3, allowList });

describe('单文件行数预算', () => {
    it('warns about oversized files that are not explicitly allowed', () => {
        const warnings = lineBudgetWarnings([{ path: 'src/big.js', lines: 4 }], options({}));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('src/big.js');
        expect(warnings[0]).toContain('oversizedAllowList');
    });

    it('stays silent for allowed oversized files and for files under the limit', () => {
        expect(lineBudgetWarnings([
            { path: 'src/allowed.js', lines: 900 },
            { path: 'src/small.js', lines: 3 },
        ], options({ 'src/allowed.js': '已放行的大文件' }))).toEqual([]);
    });

    it('warns about allowlist entries that are no longer oversized', () => {
        const warnings = lineBudgetWarnings([{ path: 'src/allowed.js', lines: 2 }], options({ 'src/allowed.js': '已放行的大文件' }));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('src/allowed.js');
        expect(warnings[0]).toContain('移除');
    });

    it('warns about allowlist entries whose file is gone', () => {
        const warnings = lineBudgetWarnings([{ path: 'src/small.js', lines: 1 }], options({ 'src/gone.js': '文件已不存在' }));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('src/gone.js');
        expect(warnings[0]).toContain('清理');
    });

    it('counts lines the same way regardless of the trailing newline', () => {
        expect(countLines('a\nb\n')).toBe(2);
        expect(countLines('a\nb')).toBe(2);
        expect(countLines('')).toBe(0);
        expect(countLines('a\r\nb\r\n')).toBe(2);
    });
});
