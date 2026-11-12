import { describe, expect, it } from 'vitest';
import {
    assertPromptSnapshot,
    createDefaultPromptViewerSettings,
    parsePromptViewerSettings,
} from '../src/features/prompt-viewer/schema.js';

function snapshot(overrides = {}) {
    return {
        schemaVersion: 1,
        kind: 'sent',
        capturedAtMs: 1,
        generationType: 'normal',
        groupMemberLabel: null,
        assemblyRoundCount: 1,
        removedAgentItemCount: 0,
        model: null,
        tokenBudget: null,
        squashSystemMessages: false,
        items: [],
        worldEntries: [],
        messages: [],
        tokenTotal: 0,
        ...overrides,
    };
}

describe('prompt viewer settings schema', () => {
    it('defaults to collapsed and round-trips valid settings', () => {
        expect(createDefaultPromptViewerSettings()).toEqual({ schemaVersion: 1, defaultCollapsed: true });
        expect(parsePromptViewerSettings(undefined)).toEqual({ schemaVersion: 1, defaultCollapsed: true });
        expect(parsePromptViewerSettings({ schemaVersion: 1, defaultCollapsed: false }))
            .toEqual({ schemaVersion: 1, defaultCollapsed: false });
    });

    it('rejects invalid and unsupported settings', () => {
        expect(() => parsePromptViewerSettings([])).toThrow(/必须是对象/);
        expect(() => parsePromptViewerSettings({ schemaVersion: 2, defaultCollapsed: true })).toThrow(/不支持/);
        expect(() => parsePromptViewerSettings({ schemaVersion: 1, defaultCollapsed: 'yes' })).toThrow(/布尔值/);
    });
});

describe('prompt snapshot validation', () => {
    it('accepts a well-formed snapshot', () => {
        expect(assertPromptSnapshot(snapshot())).toBeDefined();
    });

    it('rejects malformed snapshots', () => {
        expect(() => assertPromptSnapshot(null)).toThrow(/必须是对象/);
        expect(() => assertPromptSnapshot(snapshot({ schemaVersion: 2 }))).toThrow(/版本/);
        expect(() => assertPromptSnapshot(snapshot({ kind: 'other' }))).toThrow(/类型非法/);
        expect(() => assertPromptSnapshot(snapshot({ generationType: 'quiet' }))).toThrow(/生成类型非法/);
        expect(() => assertPromptSnapshot(snapshot({ items: null }))).toThrow(/items/);
        expect(() => assertPromptSnapshot(snapshot({ worldEntries: null }))).toThrow(/worldEntries/);
        expect(() => assertPromptSnapshot(snapshot({ tokenTotal: Number.NaN }))).toThrow(/token/);
    });
});
