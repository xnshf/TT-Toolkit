import { describe, expect, it } from 'vitest';
import {
    chunkSources,
    computeSnapshotFingerprint,
    createPresetSource,
    createWorldInfoSource,
} from '../src/features/prompt-conflict/sources.js';

function preset(overrides = {}) {
    return createPresetSource({
        identifierDigest: 'a'.repeat(64),
        label: 'Main',
        role: 'system',
        position: 0,
        order: 100,
        content: '正文',
        contentDigest: 'b'.repeat(64),
        ...overrides,
    });
}

function world(overrides = {}) {
    return createWorldInfoSource({
        worldDigest: 'c'.repeat(64),
        uid: 2,
        worldName: 'Lore',
        label: '条目',
        position: 0,
        order: 10,
        content: '内容',
        contentDigest: 'd'.repeat(64),
        rawContentDigest: 'e'.repeat(64),
        ...overrides,
    });
}

describe('prompt conflict source records', () => {
    it('builds stable opaque source ids for presets and world info', () => {
        const presetSource = preset();
        expect(presetSource.sourceId).toBe(`preset:${'a'.repeat(64)}`);
        expect(presetSource.sourceType).toBe('preset');
        expect(presetSource.actionable).toBe(false);
        const worldSource = world();
        expect(worldSource.sourceId).toBe(`wi:${'c'.repeat(64)}:2`);
        expect(worldSource.sourceType).toBe('world-info');
        expect(worldSource.actionable).toBe(true);
        expect(worldSource.rawContentDigest).toBe('e'.repeat(64));
    });
});

describe('snapshot fingerprint', () => {
    it('is deterministic for the same sorted source set', async () => {
        const sources = [world(), preset()];
        const first = await computeSnapshotFingerprint(structuredClone(sources));
        const second = await computeSnapshotFingerprint(structuredClone(sources.reverse()));
        expect(first).toBe(second);
        expect(first).toMatch(/^[a-f0-9]{64}$/);
    });

    it('changes when content, selection or suppression changes', async () => {
        const base = [preset(), world()];
        const baseline = await computeSnapshotFingerprint(base);
        const contentChanged = await computeSnapshotFingerprint([preset({ contentDigest: 'f'.repeat(64) }), world()]);
        const selectionChanged = await computeSnapshotFingerprint([{ ...preset(), enabledForDetection: false }, world()]);
        const suppressedChanged = await computeSnapshotFingerprint([{ ...preset(), suppressedForCurrentChat: true }, world()]);
        expect(new Set([baseline, contentChanged, selectionChanged, suppressedChanged]).size).toBe(4);
    });
});

describe('source batching', () => {
    it('chunks by the 30-source and 15000-character limits in stable order', () => {
        const sources = Array.from({ length: 65 }, (_, index) => preset({ identifierDigest: String(index).padStart(64, 'a'), contentDigest: String(index).padStart(64, 'b') }));
        const batches = chunkSources(sources);
        expect(batches.map(batch => batch.length)).toEqual([30, 30, 5]);
        expect(batches.flat().map(source => source.sourceId)).toEqual(sources.map(source => source.sourceId));
    });

    it('gives every oversized source its own batch without truncation', () => {
        const sources = [
            preset({ content: 'x'.repeat(20000), contentDigest: 'a'.repeat(64) }),
            preset({ content: 'y'.repeat(100), contentDigest: 'b'.repeat(64) }),
            preset({ content: 'z'.repeat(20000), contentDigest: 'c'.repeat(64) }),
        ];
        const batches = chunkSources(sources);
        expect(batches).toHaveLength(3);
        expect(batches[0][0].content).toHaveLength(20000);
    });
});
