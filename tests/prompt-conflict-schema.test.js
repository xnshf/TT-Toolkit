import { describe, expect, it } from 'vitest';
import {
    createDefaultPromptConflictChatMetadata,
    createDefaultPromptConflictFeatureSettings,
    parsePhaseOneResponse,
    parsePhaseTwoResponse,
    parsePromptConflictChatMetadata,
    parsePromptConflictFeatureSettings,
} from '../src/features/prompt-conflict/schema.js';

function batchSource(sourceId, content) {
    return { sourceId, content };
}

function phaseOneResponse(sourceId, directives = []) {
    return JSON.stringify({ sources: [{ sourceId, directives }] });
}

function directive(overrides = {}) {
    return {
        localId: 'a1',
        kind: 'requirement',
        statement: '必须保持简洁',
        condition: null,
        evidence: ['保持简洁'],
        ...overrides,
    };
}

function phaseTwoResponse(conflicts = []) {
    return JSON.stringify({ conflicts });
}

function conflict(overrides = {}) {
    return {
        directiveIds: ['preset:abc#a1', 'wi:def:1#b2'],
        severity: 'high',
        category: 'contradiction',
        title: '角色定位矛盾',
        explanation: '两个来源对角色身份的描述互相否定。',
        options: [
            { label: '保留预设描述', consequence: '世界书定位不再生效。', sourceIds: ['preset:abc'] },
        ],
        ...overrides,
    };
}

describe('prompt conflict feature settings schema', () => {
    it('defaults and round-trips a legal preset selection', () => {
        expect(parsePromptConflictFeatureSettings(undefined)).toEqual({ schemaVersion: 1, presetId: null });
        expect(createDefaultPromptConflictFeatureSettings()).toEqual({ schemaVersion: 1, presetId: null });
        expect(parsePromptConflictFeatureSettings({ schemaVersion: 1, presetId: 'p1' })).toEqual({ schemaVersion: 1, presetId: 'p1' });
    });

    it('rejects unknown fields, unknown versions and non-string preset ids', () => {
        expect(() => parsePromptConflictFeatureSettings({ schemaVersion: 1, presetId: null, extra: true })).toThrow(/未知字段/);
        expect(() => parsePromptConflictFeatureSettings({ schemaVersion: 2, presetId: null })).toThrow(/版本/);
        expect(() => parsePromptConflictFeatureSettings({ schemaVersion: 1, presetId: 5 })).toThrow(/presetId/);
    });
});

describe('prompt conflict chat metadata schema', () => {
    const record = { worldDigest: 'a'.repeat(64), uid: 2, contentDigest: 'b'.repeat(64) };

    it('defaults and parses valid records with deterministic order', () => {
        expect(parsePromptConflictChatMetadata(undefined)).toEqual({ schemaVersion: 1, disabledWorldEntries: [] });
        expect(createDefaultPromptConflictChatMetadata().schemaVersion).toBe(1);
        const parsed = parsePromptConflictChatMetadata({
            schemaVersion: 1,
            disabledWorldEntries: [
                { worldDigest: 'b'.repeat(64), uid: 1, contentDigest: 'c'.repeat(64) },
                record,
            ],
        });
        expect(parsed.disabledWorldEntries[0].worldDigest).toBe('a'.repeat(64));
        expect(parsed.disabledWorldEntries[1].worldDigest).toBe('b'.repeat(64));
    });

    it('preserves the host uid type strictly', () => {
        const parsed = parsePromptConflictChatMetadata({
            schemaVersion: 1,
            disabledWorldEntries: [
                { ...record, uid: 2 },
                { ...record, uid: '2' },
            ],
        });
        expect(parsed.disabledWorldEntries.map(item => [typeof item.uid, item.uid])).toEqual([['number', 2], ['string', '2']]);
    });

    it('rejects damaged schemas and duplicate records', () => {
        expect(() => parsePromptConflictChatMetadata({ schemaVersion: 1, disabledWorldEntries: [{ ...record, unknown: 1 }] })).toThrow(/未知字段/);
        expect(() => parsePromptConflictChatMetadata({ schemaVersion: 1, disabledWorldEntries: [{ ...record, worldDigest: 'x' }] })).toThrow(/十六进制/);
        expect(() => parsePromptConflictChatMetadata({ schemaVersion: 1, disabledWorldEntries: [{ ...record, uid: 1.5 }] })).toThrow(/安全整数/);
        expect(() => parsePromptConflictChatMetadata({ schemaVersion: 1, disabledWorldEntries: [record, record] })).toThrow(/重复/);
        expect(() => parsePromptConflictChatMetadata({ schemaVersion: 1, disabledWorldEntries: [record, { ...record, uid: '2' }] })).not.toThrow();
    });

    it('rejects damaged metadata with the dedicated unsupported code', () => {
        try {
            parsePromptConflictChatMetadata({ schemaVersion: 9, disabledWorldEntries: [] });
            expect.unreachable();
        }
        catch (error) {
            expect(error.code).toBe('PROMPT_CONFLICT_SCHEMA_UNSUPPORTED');
            expect(error.message).toMatch(/重置/);
        }
    });
});

describe('phase one response validation', () => {
    it('accepts a legal batch including empty directive lists', () => {
        const text = JSON.stringify({ sources: [
            { sourceId: 'preset:abc', directives: [directive()] },
            { sourceId: 'wi:def:1', directives: [] },
        ] });
        const parsed = parsePhaseOneResponse(text, [batchSource('preset:abc', '保持简洁'), batchSource('wi:def:1', '')]);
        expect(parsed.sources).toHaveLength(2);
        expect(parsed.sources[0].directives[0]).toMatchObject({ localId: 'a1', kind: 'requirement', statement: '必须保持简洁', condition: null });
        expect(parsed.sources[1].directives).toEqual([]);
    });

    it('trims statement and condition but keeps evidence trimmed', () => {
        const text = phaseOneResponse('preset:abc', [directive({ statement: '  保持简洁  ', condition: '  雨天时  ' })]);
        const parsed = parsePhaseOneResponse(text, [batchSource('preset:abc', '保持简洁')]);
        expect(parsed.sources[0].directives[0].statement).toBe('保持简洁');
        expect(parsed.sources[0].directives[0].condition).toBe('雨天时');
    });

    it('rejects missing, extra and duplicate source ids', () => {
        expect(() => parsePhaseOneResponse('{"sources":[]}', [batchSource('preset:abc', 'x')])).toThrow(/遗漏/);
        expect(() => parsePhaseOneResponse('{"sources":[{"sourceId":"wi:other:1","directives":[]},{"sourceId":"preset:abc","directives":[]}]}', [batchSource('preset:abc', 'x')])).toThrow(/未知来源/);
        expect(() => parsePhaseOneResponse('{"sources":[{"sourceId":"preset:abc","directives":[]},{"sourceId":"preset:abc","directives":[]}]}', [batchSource('preset:abc', 'x')])).toThrow(/重复/);
    });

    it('rejects invalid kinds, duplicate localIds and oversized fields', () => {
        const source = [batchSource('preset:abc', 'x')];
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ kind: 'order', evidence: ['x'] })]), source)).toThrow(/kind/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: ['x'] }), directive({ evidence: ['x'] })]), source)).toThrow(/重复/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ localId: '含中文', evidence: ['x'] })]), source)).toThrow(/localId/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ statement: 'x'.repeat(801), evidence: ['x'] })]), source)).toThrow(/statement/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ condition: 'x'.repeat(401), evidence: ['x'] })]), source)).toThrow(/condition/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ statement: '   ', evidence: ['x'] })]), source)).toThrow(/statement/);
    });

    it('requires every evidence segment to be an exact contiguous substring of the content', () => {
        const source = [batchSource('preset:abc', '正文保持简洁且完整。')];
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: ['不存在的内容'] })]), source)).toThrow(/连续原文/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: ['简洁且'] })]), source)).not.toThrow();
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: ['保持简洁', '完整'] })]), source)).not.toThrow();
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: [] })]), source)).toThrow(/evidence/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: ['简洁且', '简洁且', '简洁且', '简洁且'] })]), source)).toThrow(/evidence/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ evidence: ['x'.repeat(2001) + '简洁且'] })]), source)).toThrow(/字符/);
    });

    it('rejects responses over the per-source directive cap without truncating', () => {
        const many = Array.from({ length: 201 }, (_, index) => directive({ localId: `d${index}` }));
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', many), [batchSource('preset:abc', 'x')])).toThrow(/200/);
    });

    it('rejects unknown top-level and directive fields and non-JSON', () => {
        expect(() => parsePhaseOneResponse('{"sources":[],"extra":1}', [batchSource('preset:abc', 'x')])).toThrow(/未知字段/);
        expect(() => parsePhaseOneResponse(phaseOneResponse('preset:abc', [directive({ extra: 1 })]), [batchSource('preset:abc', 'x')])).toThrow(/未知字段/);
        expect(() => parsePhaseOneResponse('not json', [batchSource('preset:abc', 'x')])).toThrow(/JSON/);
    });
});

describe('phase two response validation', () => {
    const directives = [
        { directiveId: 'preset:abc#a1', sourceId: 'preset:abc' },
        { directiveId: 'preset:abc#b1', sourceId: 'preset:abc' },
        { directiveId: 'wi:def:1#b2', sourceId: 'wi:def:1' },
    ];

    it('accepts a legal empty result and rejects duplicate directive ids', () => {
        expect(parsePhaseTwoResponse('{"conflicts":[]}', directives)).toEqual([]);
        expect(() => parsePhaseTwoResponse('{"conflicts":[{"directiveIds":["preset:abc#a1","preset:abc#a1"],"severity":"low","category":"redundancy","title":"t","explanation":"e","options":[{"label":"l","consequence":"c","sourceIds":[]}]}]}', directives)).toThrow(/重复/);
    });

    it('accepts a legal cross-source conflict and normalizes fields', () => {
        const parsed = parsePhaseTwoResponse(phaseTwoResponse([conflict()]), directives);
        expect(parsed[0]).toMatchObject({
            severity: 'high',
            category: 'contradiction',
            title: '角色定位矛盾',
            options: [{ label: '保留预设描述', consequence: '世界书定位不再生效。', sourceIds: ['preset:abc'] }],
        });
    });

    it('allows same-source conflicts and empty option source ids', () => {
        const emptyOption = conflict({ options: [{ label: '不处理', consequence: '维持现状。', sourceIds: [] }] });
        expect(parsePhaseTwoResponse(phaseTwoResponse([emptyOption]), directives)[0].options[0].sourceIds).toEqual([]);
        const sameSource = conflict({ directiveIds: ['preset:abc#a1', 'preset:abc#b1'] });
        expect(parsePhaseTwoResponse(phaseTwoResponse([sameSource]), directives)).toHaveLength(1);
    });

    it('rejects unknown directive ids, single-directive conflicts and invalid enums', () => {
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ directiveIds: ['preset:abc#a1', 'unknown#z'] })]), directives)).toThrow(/未知指令/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ directiveIds: ['preset:abc#a1'] })]), directives)).toThrow(/至少两个/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ severity: 'urgent' })]), directives)).toThrow(/严重度/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ category: 'tone' })]), directives)).toThrow(/分类/);
    });

    it('rejects out-of-range text fields and option shapes', () => {
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ title: 'x'.repeat(161) })]), directives)).toThrow(/title/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ explanation: 'x'.repeat(1501) })]), directives)).toThrow(/explanation/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ options: [] })]), directives)).toThrow(/options/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ options: Array.from({ length: 7 }, (_, i) => ({ label: `l${i}`, consequence: 'c', sourceIds: [] })) })]), directives)).toThrow(/options/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ options: [{ label: 'x'.repeat(121), consequence: 'c', sourceIds: [] }] })]), directives)).toThrow(/label/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ options: [{ label: 'l', consequence: 'x'.repeat(801), sourceIds: [] }] })]), directives)).toThrow(/consequence/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ options: [{ label: 'l', consequence: 'c', sourceIds: ['unrelated'] }] })]), directives)).toThrow(/无关来源/);
        expect(() => parsePhaseTwoResponse(phaseTwoResponse([conflict({ options: [{ label: 'l', consequence: 'c', sourceIds: ['preset:abc', 'preset:abc'] }] })]), directives)).toThrow(/重复/);
    });

    it('rejects conflicts over the cap and non-JSON payloads', () => {
        const many = Array.from({ length: 501 }, () => conflict({ title: 't' }));
        expect(() => parsePhaseTwoResponse(phaseTwoResponse(many), directives)).toThrow(/500/);
        expect(() => parsePhaseTwoResponse('garbage', directives)).toThrow(/JSON/);
        expect(() => parsePhaseTwoResponse('{"conflicts":{}}', directives)).toThrow(/conflicts/);
        expect(() => parsePhaseTwoResponse('{"conflicts":[],"extra":1}', directives)).toThrow(/未知字段/);
    });
});
