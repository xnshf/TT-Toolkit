import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HOST_THEME_ID, THEME_IDS, parseShellSettings, validateTheme } from '../src/kernel/settings.js';
import { THEMES, applyThemeDocument, themeById } from '../src/ui/theme.js';
import { createThemeBridge } from '../src/ui/theme-bridge.js';
import { ToolkitError } from '../src/kernel/errors.js';

const tokensCss = readFileSync('src/ui/tokens.css', 'utf8');

afterEach(() => {
    document.documentElement.removeAttribute('data-ttk-theme');
    document.documentElement.removeAttribute('style');
});

// 相对亮度与对比度：用于锁定“文字在它实际出现的底色上可读”。
function luminance(hex) {
    const channels = [0, 2, 4].map(index => parseInt(hex.slice(1 + index, 3 + index), 16) / 255)
        .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) {
    const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (bright + 0.05) / (dark + 0.05);
}
function paletteOf(themeId) {
    const block = new RegExp(`:root\\[data-ttk-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(tokensCss);
    if (!block)
        return null;
    const palette = {};
    for (const match of block[1].matchAll(/(--ttk-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
        palette[match[1]] = match[2].toLowerCase();
    return palette;
}

describe('theme palette readability', () => {
    // 这些是实际会同时出现在屏幕上的“文字 / 底色”组合。
    const REQUIRED_PAIRS = [
        ['正文/画布', '--ttk-text', '--ttk-bg'],
        ['正文/面板', '--ttk-text', '--ttk-panel'],
        ['正文/卡片', '--ttk-text', '--ttk-card'],
        ['正文/凹陷', '--ttk-text', '--ttk-inset'],
        ['强调按钮反白', '--ttk-accent-contrast', '--ttk-accent'],
        ['危险按钮反白', '--ttk-danger-contrast', '--ttk-danger'],
    ];

    it('covers every non-host theme with a literal palette', () => {
        for (const theme of THEMES) {
            if (theme.id === HOST_THEME_ID)
                continue;
            expect(paletteOf(theme.id), `${theme.id} 缺少可解析的色板`).not.toBeNull();
        }
    });

    it('keeps every text/surface pair at or above the AA 4.5:1 floor', () => {
        const failures = [];
        for (const theme of THEMES) {
            if (theme.id === HOST_THEME_ID)
                continue;
            const palette = paletteOf(theme.id);
            for (const [label, foreground, background] of REQUIRED_PAIRS) {
                const ratio = contrast(palette[foreground], palette[background]);
                if (ratio < 4.5)
                    failures.push(`${theme.id} ${label}: ${ratio.toFixed(2)}:1`);
            }
        }
        expect(failures).toEqual([]);
    });
});

describe('theme registry contract', () => {
    it('rejects unknown theme ids instead of silently guessing', () => {
        expect(() => validateTheme('neon')).toThrow(ToolkitError);
        expect(validateTheme('midnight')).toBe('midnight');
    });

    it('falls back to safe defaults and reports each unrecognized enum instead of guessing', () => {
        const base = parseShellSettings(undefined);
        expect(base.theme).toBe(HOST_THEME_ID);

        // 旧版 v1 未存储 theme：补齐为“跟随宿主”，不算异常。
        const withoutTheme = { ...base };
        delete withoutTheme.theme;
        const issues = [];
        expect(parseShellSettings(withoutTheme, issue => issues.push(issue)).theme).toBe(HOST_THEME_ID);
        expect(issues).toEqual([]);

        expect(parseShellSettings({ ...base, theme: 'slate' }).theme).toBe('slate');

        // 取值异常只影响观感：回退到安全默认并上报，不阻断工具箱启动。
        const reported = [];
        const degraded = parseShellSettings({ ...base, theme: 'neon' }, issue => reported.push(issue));
        expect(degraded.theme).toBe(HOST_THEME_ID);
        expect(reported).toEqual([{
            field: 'theme',
            expected: [...THEME_IDS].join('|'),
            actualType: 'string',
            fallback: HOST_THEME_ID,
        }]);
        // 不记录原始取值，只记录字段、期望集合与类型。
        expect(JSON.stringify(reported)).not.toContain('neon');
    });
});

describe('applying a theme to a document', () => {
    it('writes the theme attribute and the resolved color scheme', () => {
        applyThemeDocument(document, 'midnight', 'light');
        expect(document.documentElement.dataset.ttkTheme).toBe('midnight');
        expect(document.documentElement.style.colorScheme).toBe('dark');
    });

    it('resolves the host theme scheme from the host instead of hardcoding one', () => {
        applyThemeDocument(document, HOST_THEME_ID, 'light');
        expect(document.documentElement.style.colorScheme).toBe('light');
        applyThemeDocument(document, HOST_THEME_ID, 'dark');
        expect(document.documentElement.style.colorScheme).toBe('dark');
    });

    it('leaves the host document color-scheme untouched when asked to', () => {
        document.documentElement.style.colorScheme = 'only light';
        applyThemeDocument(document, 'latte', 'dark', { colorScheme: false });
        expect(document.documentElement.dataset.ttkTheme).toBe('latte');
        expect(document.documentElement.style.colorScheme).toBe('only light');
    });

    it('exposes a fallback theme for unknown ids without throwing', () => {
        expect(themeById('missing').id).toBe(HOST_THEME_ID);
    });
});

describe('host token bridge', () => {
    it('does not pollute the document it reads from when source and target are the same', () => {
        const bridge = createThemeBridge(document);
        const snapshot = bridge.read();
        expect(['dark', 'light']).toContain(snapshot.scheme);
        // 宿主文档内变量本就能解析，写内联值会污染宿主根节点。
        expect(document.documentElement.style.getPropertyValue('--ttk-host-body')).toBe('');
        bridge.dispose();
    });
});
