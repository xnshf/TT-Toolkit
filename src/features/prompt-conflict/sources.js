import { sha256Hex } from '../../kernel/hash.js';

export const MAX_SOURCES_PER_BATCH = 30;
export const MAX_CONTENT_CHARS_PER_BATCH = 15000;

export function createPresetSource({ identifierDigest, label, role, position, order, content, contentDigest }) {
    return {
        sourceId: `preset:${identifierDigest}`,
        sourceType: 'preset',
        label: String(label ?? ''),
        role: String(role ?? 'system'),
        position: Number(position ?? 0),
        order: Number(order ?? 0),
        content: String(content ?? ''),
        contentDigest: String(contentDigest ?? ''),
        actionable: false,
    };
}

export function createWorldInfoSource({ worldDigest, uid, worldName, label, position, order, content, contentDigest, rawContentDigest }) {
    return {
        sourceId: `wi:${worldDigest}:${String(uid)}`,
        sourceType: 'world-info',
        worldDigest,
        uid,
        worldName,
        label: String(label ?? ''),
        position: Number(position ?? 0),
        order: Number(order ?? 0),
        content: String(content ?? ''),
        contentDigest: String(contentDigest ?? ''),
        rawContentDigest: String(rawContentDigest ?? ''),
        actionable: true,
    };
}

export function isConstantWorldInfoEntry(entry) {
    return entry?.disable !== true && entry?.constant === true;
}

export function uidKey(uid) {
    if (typeof uid !== 'string' && typeof uid !== 'number')
        return null;
    return `${typeof uid}:${String(uid)}`;
}

export async function computeSnapshotFingerprint(sources) {
    const rows = [...sources]
        .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)
        .map(source => [
            source.sourceId,
            source.sourceType,
            source.contentDigest,
            source.enabledForDetection,
            source.suppressedForCurrentChat,
        ]);
    return sha256Hex(JSON.stringify(rows));
}

export function chunkSources(sources) {
    const batches = [];
    let current = [];
    let used = 0;
    for (const source of sources) {
        const size = String(source.content ?? '').length;
        if (current.length && (current.length >= MAX_SOURCES_PER_BATCH || used + size > MAX_CONTENT_CHARS_PER_BATCH)) {
            batches.push(current);
            current = [];
            used = 0;
        }
        current.push(source);
        used += size;
    }
    if (current.length)
        batches.push(current);
    return batches;
}

export function estimateModelCallCount(sources) {
    return chunkSources(sources).length + 1;
}
