import { ToolkitError } from '../../kernel/errors.js';
import { worldEntryKey } from './schema.js';
import { WORLD_INFO_LORE_LISTS } from '../../kernel/world-info.js';

function invalid(reason) {
    throw new ToolkitError('DECISION_OVERLAY_INVALID', '决策与本轮世界书条目不一致，未应用任何变更，请使用原生激活。', { reason });
}
function idSet(ids) {
    if (!(Array.isArray(ids) || ids instanceof Set)) invalid('invalid-id-collection');
    const result = new Set();
    for (const id of ids) {
        if (typeof id !== 'string') invalid('invalid-id-type');
        if (result.has(id)) invalid('duplicate-decision-id');
        result.add(id);
    }
    return result;
}

// Payload has passed the kernel boundary. Only scan-local clones are replaced;
// arrays, cached entries, native eligibility, group scoring and budget stay intact.
export function applyActivationDecision(payload, managedIds, selectedIds) {
    const managed = idSet(managedIds);
    const selected = idSet(selectedIds);
    for (const id of selected) if (!managed.has(id)) invalid('unknown-selected-id');
    const found = new Set();
    const changes = [];
    let activatedCount = 0;
    let suppressedCount = 0;
    for (const name of WORLD_INFO_LORE_LISTS) {
        const entries = payload[name];
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const id = worldEntryKey(entry.world, entry.uid);
            if (!managed.has(id)) continue;
            if (found.has(id)) invalid('duplicate-managed-match');
            found.add(id);
            let copy;
            try { copy = structuredClone(entry); }
            catch { invalid('entry-clone-failed'); }
            if (selected.has(id)) {
                Object.assign(copy, {
                    constant: true, useProbability: false, probability: 100,
                    sticky: null, cooldown: null, delay: null,
                    delayUntilRecursion: false, excludeRecursion: false,
                });
                activatedCount++;
            }
            else {
                copy.disable = true;
                suppressedCount++;
            }
            changes.push({ entries, index, copy });
        }
    }
    if (found.size !== managed.size) invalid('missing-managed-match');
    // Finish every validation and clone before touching any host array.
    for (const { entries, index, copy } of changes) entries[index] = copy;
    return { activatedCount, suppressedCount };
}
