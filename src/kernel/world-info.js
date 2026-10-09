import { ToolkitError } from './errors.js';

export const WORLD_INFO_LORE_LISTS = Object.freeze(['globalLore', 'characterLore', 'chatLore', 'personaLore']);
const VALUE_TYPES = new Set(['undefined', 'null', 'array', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol', 'function']);

// Only boundary-generated, whitelisted diagnostics may enter redacted logs.
export function worldInfoContractFailureData(error) {
    const context = error instanceof ToolkitError && error.code === 'HOST_EVENT_INVALID' ? (error.context ?? {}) : {};
    const field = WORLD_INFO_LORE_LISTS.includes(context.field) ? context.field : 'payload';
    return {
        code: 'HOST_EVENT_INVALID',
        event: 'WORLDINFO_ENTRIES_LOADED',
        stage: 'host.event-validation',
        reason: field === 'payload' ? 'world-info-payload-type-invalid' : 'world-info-lore-array-invalid',
        sourceLocation: 'kernel/host.js:validateWorldInfoEntriesPayload',
        field,
        expected: field === 'payload' ? 'record' : 'array',
        actualType: VALUE_TYPES.has(context.actualType) ? context.actualType : 'unknown',
        outcome: 'round-skipped',
        nextAction: 'retry-generation-or-check-host-version',
    };
}
