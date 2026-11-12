import { describe, expect, it } from 'vitest';
import {
    cloneEntry,
    convertEntryUserPlaceholders,
    createDefaultWorldInfoEditorSettings,
    createNewEntry,
    estimateTokens,
    getFreeWorldEntryUid,
    isRegexKey,
    normalizeEntry,
    parseWorldInfoEditorSettings,
    projectEntrySummary,
    replaceUserPlaceholder,
    SELECTIVE_LOGIC,
    POSITION_OPTIONS,
} from '../src/features/world-info-editor/schema.js';

describe('world-info-editor schema', () => {
    it('matches TauriTavern 2.3.0 logic and position enums without shifting values', () => {
        expect(SELECTIVE_LOGIC).toEqual({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });
        expect(POSITION_OPTIONS.map(position => position.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(createNewEntry(4).selective).toBe(true);
        expect(createNewEntry(4).addMemo).toBe(false);
    });

    it('estimates tokens reasonably for English and Chinese text', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens(null)).toBe(0);
        // English words
        const enTokens = estimateTokens('The quick brown fox jumps over the lazy dog');
        expect(enTokens).toBeGreaterThan(8);
        expect(enTokens).toBeLessThan(20);
        // Chinese characters
        const zhTokens = estimateTokens('帝国圣殿骑士团直属于皇室');
        expect(zhTokens).toBeGreaterThan(6);
        expect(zhTokens).toBeLessThan(24);
        // Mixed text
        const mixedTokens = estimateTokens('帝国 Knights 共有 100 名士兵');
        expect(mixedTokens).toBeGreaterThan(5);
    });

    it('identifies regex keys accurately', () => {
        expect(isRegexKey('/knight/')).toBe(true);
        expect(isRegexKey('/[0-9]+号/i')).toBe(true);
        expect(isRegexKey('/regex/gim')).toBe(true);
        expect(isRegexKey('normal_keyword')).toBe(false);
        expect(isRegexKey('slash/in/the/middle')).toBe(false);
        expect(isRegexKey('/unfinished')).toBe(false);
        expect(isRegexKey(null)).toBe(false);
    });

    it('allocates the next available UID correctly', () => {
        expect(getFreeWorldEntryUid(null)).toBe(0);
        expect(getFreeWorldEntryUid({ entries: {} })).toBe(0);
        expect(getFreeWorldEntryUid({ entries: { 0: { uid: 0 }, 1: { uid: 1 }, 5: { uid: 5 } } })).toBe(2);
        expect(getFreeWorldEntryUid({ entries: { '10': { uid: 10 } } })).toBe(0);
    });

    it('normalizes entries and fills all required defaults safely', () => {
        const raw = {
            uid: '12',
            comment: '测试条目',
            content: '这是测试内容',
            key: ['测试', '骑士'],
            constant: true,
            disable: false,
        };

        const normalized = normalizeEntry(raw);
        expect(normalized.uid).toBe(12);
        expect(normalized.comment).toBe('测试条目');
        expect(normalized.content).toBe('这是测试内容');
        expect(normalized.key).toEqual(['测试', '骑士']);
        expect(normalized.keysecondary).toEqual([]);
        expect(normalized.constant).toBe(true);
        expect(normalized.selective).toBe(true);
        expect(normalized.selectiveLogic).toBe(SELECTIVE_LOGIC.AND_ANY);
        expect(normalized.position).toBe(0);
        expect(normalized.depth).toBe(4);
        expect(normalized.order).toBe(100);
    });

    it('clones entry deeply without referencing original mutated fields', () => {
        const entry = createNewEntry(7, '原始条目');
        entry.key.push('初始词');

        const cloned = cloneEntry(entry);
        expect(cloned.uid).toBe(7);
        expect(cloned.comment).toBe('原始条目');
        expect(cloned.key).toEqual(['初始词']);

        // Mutate original
        entry.key.push('新词');
        entry.comment = '已修改';
        expect(cloned.key).toEqual(['初始词']);
        expect(cloned.comment).toBe('原始条目');
    });

    it('projects entry summary for fast listing and filtering', () => {
        const entry = createNewEntry(3, '圣殿');
        entry.constant = true;
        entry.disable = true;
        entry.position = 4;
        entry.depth = 2;
        entry.content = '设定正文';

        const summary = projectEntrySummary(entry);
        expect(summary.uid).toBe(3);
        expect(summary.comment).toBe('圣殿');
        expect(summary.constant).toBe(true);
        expect(summary.disabled).toBe(true);
        expect(summary.position).toBe(4);
        expect(summary.depth).toBe(2);
        expect(summary.tokenEstimate).toBeGreaterThan(0);
    });

    it('replaces standalone user words with the {{user}} macro without touching existing macros', () => {
        expect(replaceUserPlaceholder('user')).toEqual({ value: '{{user}}', count: 1 });
        expect(replaceUserPlaceholder('User 与 USER 独处')).toEqual({ value: '{{user}} 与 {{user}} 独处', count: 2 });
        expect(replaceUserPlaceholder('{{user}} 和 {{char}}')).toEqual({ value: '{{user}} 和 {{char}}', count: 0 });
        // 中英文标点仍是合法分隔符，独立 user 照常转换。
        expect(replaceUserPlaceholder('与user独处')).toEqual({ value: '与{{user}}独处', count: 1 });
        expect(replaceUserPlaceholder('the user, (user).')).toEqual({ value: 'the {{user}}, ({{user}}).', count: 2 });
        expect(replaceUserPlaceholder(null)).toEqual({ value: null, count: 0 });
    });

    it('tightens the boundary so identifiers, hyphenated compounds and angle-bracket tags are preserved', () => {
        expect(replaceUserPlaceholder('username user_name user-defined')).toEqual({ value: 'username user_name user-defined', count: 0 });
        expect(replaceUserPlaceholder('user1 1user')).toEqual({ value: 'user1 1user', count: 0 });
        expect(replaceUserPlaceholder('<user> </user> <USER/>')).toEqual({ value: '<user> </user> <USER/>', count: 0 });
        expect(replaceUserPlaceholder('{{ user }}')).toEqual({ value: '{{ user }}', count: 0 });
    });

    it('converts user words across every string field of an entry', () => {
        const { entry, count } = convertEntryUserPlaceholders({
            uid: 3,
            comment: 'user 的记录',
            key: ['user', 'user_name'],
            keysecondary: ['与user独处'],
            content: '{{user}} 对 user 表示',
            order: 100,
        });
        expect(count).toBe(4);
        expect(entry.comment).toBe('{{user}} 的记录');
        expect(entry.key).toEqual(['{{user}}', 'user_name']);
        expect(entry.keysecondary).toEqual(['与{{user}}独处']);
        expect(entry.content).toBe('{{user}} 对 {{user}} 表示');
        expect(entry.order).toBe(100);
    });

    it('parses functional settings and rejects unknown or malformed schema', () => {
        expect(createDefaultWorldInfoEditorSettings()).toEqual({ schemaVersion: 1, convertUserMacro: true });
        expect(parseWorldInfoEditorSettings(undefined)).toEqual({ schemaVersion: 1, convertUserMacro: true });
        expect(parseWorldInfoEditorSettings({ schemaVersion: 1, convertUserMacro: false })).toEqual({ schemaVersion: 1, convertUserMacro: false });
        expect(() => parseWorldInfoEditorSettings({ schemaVersion: 1 })).toThrow(/缺失或未知字段/);
        expect(() => parseWorldInfoEditorSettings({ schemaVersion: 1, convertUserMacro: 'yes' })).toThrow(/布尔值/);
        expect(() => parseWorldInfoEditorSettings({ schemaVersion: 2, convertUserMacro: true })).toThrow(/版本/);
    });
});
