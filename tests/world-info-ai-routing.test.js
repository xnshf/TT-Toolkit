import { describe, expect, it } from 'vitest';
import { applyActivationDecision } from '../src/features/world-info-ai/routing.js';
import { worldEntryKey } from '../src/features/world-info-ai/schema.js';

function entry(uid, overrides = {}) {
    return {
        world: 'Lore', uid, content: `content-${uid}`, comment: `Entry ${uid}`,
        key: ['match'], keysecondary: ['secondary'], constant: false, vectorized: true,
        disable: false, triggers: ['normal'], characterFilter: { names: ['actor'], tags: ['tag'] },
        position: 4, depth: 9, role: 2, order: 222, outletName: 'x', ignoreBudget: true,
        useProbability: true, probability: 25, sticky: 10, cooldown: 8, delay: 3,
        delayUntilRecursion: 2, excludeRecursion: true, preventRecursion: true,
        group: 'group-a', groupOverride: true, useGroupScoring: true, groupWeight: 7,
        extensions: { custom: { keep: true } }, ...overrides,
    };
}
function payload(entries) {
    return { globalLore: entries, characterLore: [], chatLore: [], personaLore: [] };
}
const id = uid => worldEntryKey('Lore', uid);

describe('temporary world info decision overlay', () => {
    it('replaces activation basis only, preserving native filters, scoring, placement and content', () => {
        const native = entry(1, { constant: true });
        const denied = entry(2, { constant: true, content: '@@activate\nbody' });
        const allowed = entry(3, { content: '@@activate\nselected-body' });
        const before = structuredClone([native, denied, allowed]);
        const lore = payload([native, denied, allowed]);
        const originalArray = lore.globalLore;
        expect(applyActivationDecision(lore, [id(2), id(3)], new Set([id(3)]))).toEqual({ activatedCount: 1, suppressedCount: 1 });
        expect(lore.globalLore).toBe(originalArray);
        expect(lore.globalLore).toHaveLength(3);
        expect(lore.globalLore[0]).toBe(native);
        expect(lore.globalLore[1]).toEqual({ ...denied, disable: true });
        expect(lore.globalLore[2]).toEqual({
            ...allowed, constant: true, useProbability: false, probability: 100,
            sticky: null, cooldown: null, delay: null, delayUntilRecursion: false, excludeRecursion: false,
        });
        expect([native, denied, allowed]).toEqual(before);
        for (const index of [1, 2]) {
            expect(lore.globalLore[index]).not.toBe([native, denied, allowed][index]);
            expect(lore.globalLore[index].key).not.toBe([native, denied, allowed][index].key);
            expect(lore.globalLore[index].characterFilter).not.toBe([native, denied, allowed][index].characterFilter);
            expect(lore.globalLore[index].extensions.custom).not.toBe([native, denied, allowed][index].extensions.custom);
        }
    });

    it('suppresses every managed entry on an empty selection without removing entries or force events', () => {
        const lore = payload([entry(1), entry(2, { constant: true })]);
        const result = applyActivationDecision(lore, new Set([id(1), id(2)]), []);
        expect(result).toEqual({ activatedCount: 0, suppressedCount: 2 });
        expect(lore.globalLore.map(item => item.disable)).toEqual([true, true]);
    });

    it('does not resurrect a native-disabled entry or strip a dont_activate decorator', () => {
        const source = entry(1, { disable: true, content: '@@dont_activate\nbody' });
        const lore = payload([source]);
        applyActivationDecision(lore, [id(1)], [id(1)]);
        expect(lore.globalLore[0]).toMatchObject({ disable: true, content: source.content });
    });

    it('supports all four lists and distinguishes numeric from string UIDs', () => {
        const lore = { globalLore: [entry(1)], characterLore: [entry('1')], chatLore: [entry(3)], personaLore: [entry(4)] };
        expect(applyActivationDecision(lore, [id(1), id('1'), id(3), id(4)], [id('1'), id(4)])).toEqual({ activatedCount: 2, suppressedCount: 2 });
        expect(lore.globalLore[0].disable).toBe(true);
        expect(lore.characterLore[0].constant).toBe(true);
        expect(lore.chatLore[0].disable).toBe(true);
        expect(lore.personaLore[0].constant).toBe(true);
    });

    it.each([
        [[id(1)], [id(9)], 'unknown-selected-id'],
        [[id(1), id(9)], [id(1)], 'missing-managed-match'],
        [[id(1), id(1)], [id(1)], 'duplicate-decision-id'],
        [[id(1)], [1], 'invalid-id-type'],
    ])('rejects inconsistent decisions before any mutation', (managed, selected, reason) => {
        const source = entry(1);
        const lore = payload([source]);
        expect(() => applyActivationDecision(lore, managed, selected)).toThrow(expect.objectContaining({ code: 'DECISION_OVERLAY_INVALID', context: { reason } }));
        expect(lore.globalLore[0]).toBe(source);
        expect(source.constant).toBe(false);
    });

    it('rejects duplicate managed matches across lists before applying even the first clone', () => {
        const source = entry(1);
        const lore = payload([source, entry(2)]);
        lore.personaLore.push(entry(2, { content: 'conflicting-body' }));
        const before = structuredClone(lore);
        expect(() => applyActivationDecision(lore, [id(1), id(2)], [id(1)])).toThrow(expect.objectContaining({ context: { reason: 'duplicate-managed-match' } }));
        expect(lore).toEqual(before);
        expect(lore.globalLore[0]).toBe(source);
    });

    it('plans all clones before mutation and sanitizes a later cloning failure', () => {
        const source = entry(1);
        const lore = payload([source, entry(2, { unknown: () => 'private-body' })]);
        let error;
        try { applyActivationDecision(lore, [id(1), id(2)], [id(1)]); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: 'DECISION_OVERLAY_INVALID', context: { reason: 'entry-clone-failed' } });
        expect(JSON.stringify(error)).not.toContain('private-body');
        expect(lore.globalLore[0]).toBe(source);
    });

    it('ignores malformed unmanaged entries without changing them', () => {
        const lore = payload([null, 'unexpected', entry(1)]);
        expect(applyActivationDecision(lore, [], [])).toEqual({ activatedCount: 0, suppressedCount: 0 });
        expect(lore.globalLore.slice(0, 2)).toEqual([null, 'unexpected']);
    });
});
