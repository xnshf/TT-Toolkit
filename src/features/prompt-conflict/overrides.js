import { ToolkitError } from '../../kernel/errors.js';
import { sha256Hex } from '../../kernel/hash.js';
import { uidKey } from './sources.js';

export const LORE_LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];

export function createStagedChange({ sourceId, worldDigest, uid, contentDigest, action, dynamic }) {
    if (!['suppress', 'restore'].includes(action))
        throw new ToolkitError('INVALID_SCHEMA', '暂存动作必须是 suppress 或 restore。');
    if (typeof worldDigest !== 'string' || worldDigest.length !== 64)
        throw new ToolkitError('INVALID_SCHEMA', '暂存动作缺少世界书摘要。');
    if (typeof contentDigest !== 'string' || contentDigest.length !== 64)
        throw new ToolkitError('INVALID_SCHEMA', '暂存动作缺少正文摘要。');
    const key = uidKey(uid);
    if (!key)
        throw new ToolkitError('INVALID_SCHEMA', '暂存动作缺少合法 UID。');
    return { sourceId: String(sourceId), worldDigest, uid, contentDigest, action, dynamic: dynamic === true };
}

export function stageChange(plan, change) {
    const next = new Map(plan);
    const existing = next.get(change.sourceId);
    if (existing) {
        if (existing.action === change.action)
            return next;
        next.delete(change.sourceId);
        return next;
    }
    next.set(change.sourceId, change);
    return next;
}

export function overrideRecordKey(record) {
    return `${record.worldDigest}:${uidKey(record.uid)}`;
}

export async function filterWorldInfoPayload(payload, records) {
    const recordByKey = new Map();
    for (const record of records)
        recordByKey.set(overrideRecordKey(record), record);
    let removed = 0;
    for (const listName of LORE_LISTS) {
        const entries = payload?.[listName];
        if (!Array.isArray(entries))
            throw new ToolkitError('HOST_EVENT_INVALID', `WORLDINFO_ENTRIES_LOADED 缺少 ${listName} 数组。`);
        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            if (!entry || typeof entry !== 'object')
                continue;
            if (typeof entry.world !== 'string' || !entry.world)
                continue;
            const key = uidKey(entry.uid);
            if (!key)
                continue;
            const record = recordByKey.get(`${await sha256Hex(entry.world)}:${key}`);
            if (!record)
                continue;
            const contentDigest = await sha256Hex(String(entry.content ?? ''));
            if (record.contentDigest !== contentDigest)
                continue;
            entries.splice(index, 1);
            removed += 1;
        }
    }
    return removed;
}

export async function buildOverrideLookup(groups) {
    const lookup = new Map();
    for (const listName of LORE_LISTS) {
        for (const entry of groups?.[listName] ?? []) {
            if (!entry || typeof entry !== 'object')
                continue;
            if (entry.disable === true || entry.constant !== true)
                continue;
            if (typeof entry.world !== 'string' || !entry.world)
                continue;
            const key = uidKey(entry.uid);
            if (!key)
                continue;
            const worldDigest = await sha256Hex(entry.world);
            const lookupKey = `${worldDigest}:${key}`;
            if (!lookup.has(lookupKey))
                lookup.set(lookupKey, {});
            const contentDigest = await sha256Hex(String(entry.content ?? ''));
            lookup.get(lookupKey).contentDigest = contentDigest;
            lookup.get(lookupKey).entry = entry;
        }
    }
    return lookup;
}

export function applyStagedChanges(metadata, stagedChanges) {
    const current = [...metadata.disabledWorldEntries];
    const records = current.map(record => ({ ...record }));
    const byKey = new Map(records.map(record => [overrideRecordKey(record), record]));
    for (const change of stagedChanges.values()) {
        const key = overrideRecordKey(change);
        if (change.action === 'suppress') {
            const existing = byKey.get(key);
            const record = { worldDigest: change.worldDigest, uid: change.uid, contentDigest: change.contentDigest };
            if (existing) {
                existing.contentDigest = record.contentDigest;
            }
            else {
                records.push(record);
                byKey.set(key, record);
            }
        }
        else {
            const index = records.findIndex(record => overrideRecordKey(record) === key);
            if (index !== -1)
                records.splice(index, 1);
        }
    }
    return { schemaVersion: 1, disabledWorldEntries: records };
}

export function sameMetadata(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
