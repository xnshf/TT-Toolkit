import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/kernel/hash.js';
import {
    applyStagedChanges,
    buildOverrideLookup,
    createStagedChange,
    filterWorldInfoPayload,
    stageChange,
} from '../src/features/prompt-conflict/overrides.js';
import { parsePromptConflictChatMetadata } from '../src/features/prompt-conflict/schema.js';

function record(overrides = {}) {
    return { worldDigest: 'a'.repeat(64), uid: 2, contentDigest: 'b'.repeat(64), ...overrides };
}

async function recordFor(world, uid, content, uidValue = uid) {
    return {
        worldDigest: await sha256Hex(world),
        uid: uidValue,
        contentDigest: await sha256Hex(content),
    };
}

function payload(entries) {
    return { globalLore: entries, characterLore: [], chatLore: [], personaLore: [] };
}

function entry(world, uid, overrides = {}) {
    return { world, uid, content: '正文', constant: true, disable: false, order: 100, ...overrides };
}

describe('staged change plan', () => {
    it('validates required fields and actions', () => {
        expect(() => createStagedChange({ sourceId: 'wi:a:1', worldDigest: 'a'.repeat(64), uid: 1, contentDigest: 'b'.repeat(64), action: 'move', dynamic: false })).toThrow(/suppress 或 restore/);
        expect(() => createStagedChange({ sourceId: 'wi:a:1', worldDigest: 'x', uid: 1, contentDigest: 'b'.repeat(64), action: 'suppress' })).toThrow(/摘要/);
        expect(() => createStagedChange({ sourceId: 'wi:a:1', worldDigest: 'a'.repeat(64), uid: null, contentDigest: 'b'.repeat(64), action: 'suppress' })).toThrow(/UID/);
        expect(createStagedChange({ sourceId: 'wi:a:1', worldDigest: 'a'.repeat(64), uid: 1, contentDigest: 'b'.repeat(64), action: 'suppress', dynamic: true }).dynamic).toBe(true);
    });

    it('keeps a repeated action and cancels opposite actions', () => {
        const suppress = createStagedChange({ sourceId: 'wi:a:1', worldDigest: 'a'.repeat(64), uid: 1, contentDigest: 'b'.repeat(64), action: 'suppress' });
        const restore = createStagedChange({ sourceId: 'wi:a:1', worldDigest: 'a'.repeat(64), uid: 1, contentDigest: 'b'.repeat(64), action: 'restore' });
        let plan = new Map();
        plan = stageChange(plan, suppress);
        plan = stageChange(plan, suppress);
        expect(plan.size).toBe(1);
        plan = stageChange(plan, restore);
        expect(plan.size).toBe(0);
        plan = stageChange(plan, suppress);
        plan = stageChange(plan, suppress);
        expect([...plan.values()][0].action).toBe('suppress');
    });
});

describe('world info payload filtering', () => {
    it('removes only exact worldDigest + uid + contentDigest matches from all four lists', async () => {
        const keep = entry('Other', 9, { content: '保留' });
        const target = entry('Lore', 2, { content: '屏蔽我' });
        const changed = entry('Lore', 3, { content: '旧正文' });
        const lore = {
            globalLore: [keep, target, changed],
            characterLore: [entry('Lore', 2, { content: '屏蔽我' })],
            chatLore: [],
            personaLore: [target],
        };
        const records = [await recordFor('Lore', 2, '屏蔽我')];
        const removed = await filterWorldInfoPayload(lore, records);
        expect(removed).toBe(3);
        expect(lore.globalLore.map(item => item.uid)).toEqual([9, 3]);
        expect(lore.characterLore).toHaveLength(0);
        expect(lore.personaLore).toHaveLength(0);
        expect(lore.globalLore[0]).toBe(keep);
    });

    it('fails open when content changed, entry deleted or uid type differs', async () => {
        const changed = entry('Lore', 2, { content: '新正文' });
        const wrongType = entry('Lore', '2', { content: '屏蔽我' });
        const lore = payload([changed, wrongType]);
        const removed = await filterWorldInfoPayload(lore, [await recordFor('Lore', 2, '屏蔽我')]);
        expect(removed).toBe(0);
        expect(lore.globalLore).toHaveLength(2);
    });

    it('preserves the relative order of remaining entries and mutates in place', async () => {
        const first = entry('Lore', 1, { content: 'a' });
        const target = entry('Lore', 2, { content: '屏蔽我' });
        const last = entry('Lore', 3, { content: 'c' });
        const lore = payload([first, target, last]);
        await filterWorldInfoPayload(lore, [await recordFor('Lore', 2, '屏蔽我')]);
        expect(lore.globalLore.map(item => item.uid)).toEqual([1, 3]);
    });

});

describe('apply-time lookup and metadata merge', () => {
    it('builds a lookup of only enabled constant entries with raw content digests', async () => {
        const groups = {
            globalLore: [entry('Lore', 1), entry('Lore', 2, { constant: false }), entry('Lore', 3, { disable: true })],
            characterLore: [],
            chatLore: [],
            personaLore: [],
        };
        const lookup = await buildOverrideLookup(groups);
        expect(lookup.size).toBe(1);
        const key = [...lookup.keys()][0];
        expect(key).toBe(`${await sha256Hex('Lore')}:number:1`);
    });

    it('merges staged changes into metadata deterministically', () => {
        const metadata = parsePromptConflictChatMetadata({
            schemaVersion: 1,
            disabledWorldEntries: [record()],
        });
        const suppress = createStagedChange({ sourceId: 'wi:new:5', worldDigest: 'c'.repeat(64), uid: 5, contentDigest: 'd'.repeat(64), action: 'suppress' });
        const restore = createStagedChange({ sourceId: 'wi:a:2', worldDigest: 'a'.repeat(64), uid: 2, contentDigest: 'b'.repeat(64), action: 'restore' });
        const plan = stageChange(stageChange(new Map(), suppress), restore);
        const next = applyStagedChanges(metadata, plan);
        expect(next.disabledWorldEntries.map(item => item.uid)).toEqual([5]);
        expect(JSON.stringify(next)).not.toContain('Lore');
    });

    it('deduplicates by worldDigest + uid and keeps the latest digest on suppress', () => {
        const metadata = parsePromptConflictChatMetadata({ schemaVersion: 1, disabledWorldEntries: [record()] });
        const update = createStagedChange({ sourceId: 'wi:a:2', worldDigest: 'a'.repeat(64), uid: 2, contentDigest: 'z'.repeat(64), action: 'suppress' });
        const next = applyStagedChanges(metadata, stageChange(new Map(), update));
        expect(next.disabledWorldEntries).toHaveLength(1);
        expect(next.disabledWorldEntries[0].contentDigest).toBe('z'.repeat(64));
    });
});
