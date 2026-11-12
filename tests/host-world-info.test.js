import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { ToolkitError } from '../src/kernel/errors.js';
import { WORLD_INFO_LORE_LISTS, worldInfoContractFailureData } from '../src/kernel/world-info.js';
import { projectLogPayload } from '../src/kernel/logging/serialize.js';

function setup() {
    const host = new TauriTavernHost();
    const events = {};
    const eventSource = {
        on: vi.fn((name, handler) => { events[name] = handler; }),
        removeListener: vi.fn(name => { delete events[name]; }),
    };
    host.contextModule = { getContext: () => ({ chat: [], eventSource, eventTypes: { WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded' } }) };
    return { host, events, eventSource };
}

function payload() {
    return Object.fromEntries(WORLD_INFO_LORE_LISTS.map(name => [name, []]));
}

describe('shared world info subscription boundary', () => {
    it('requires both a consumer and an explicit contract-error handler', () => {
        const { host, eventSource } = setup();
        for (const callbacks of [[undefined, vi.fn()], [vi.fn(), undefined], [vi.fn(), null]])
            expect(() => host.subscribeWorldInfoEntriesLoaded(...callbacks)).toThrow(TypeError);
        expect(eventSource.on).not.toHaveBeenCalled();
    });

    it('keeps payload and array references and returns the consumer promise so scanning waits for filtering', async () => {
        const { host, events, eventSource } = setup();
        const lore = payload();
        lore.globalLore.push({ world: 'Lore', uid: 1 });
        const original = lore.globalLore;
        let finish;
        const work = new Promise(resolve => { finish = resolve; }).then(() => { original.splice(0, 1); });
        const listener = vi.fn(received => {
            expect(received).toBe(lore);
            expect(received.globalLore).toBe(original);
            return work;
        });
        const onContractError = vi.fn();
        const dispose = host.subscribeWorldInfoEntriesLoaded(listener, onContractError);
        const delivery = events.worldinfo_entries_loaded(lore);
        expect(delivery).toBe(work);
        expect(original).toHaveLength(1);
        finish();
        await delivery;
        expect(original).toEqual([]);
        expect(onContractError).not.toHaveBeenCalled();
        dispose();
        expect(eventSource.removeListener).toHaveBeenCalledWith('worldinfo_entries_loaded', expect.any(Function));
        expect(events.worldinfo_entries_loaded).toBeUndefined();
    });

    it.each([
        [undefined, 'undefined'], [null, 'null'], [[], 'array'], ['private-body', 'string'], [1, 'number'], [false, 'boolean'],
    ])('routes invalid root %j to the error callback without delivering or leaking it', (value, actualType) => {
        const { host, events } = setup();
        const listener = vi.fn();
        const onContractError = vi.fn();
        host.subscribeWorldInfoEntriesLoaded(listener, onContractError);
        expect(() => events.worldinfo_entries_loaded(value)).not.toThrow();
        expect(listener).not.toHaveBeenCalled();
        expect(onContractError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            code: 'HOST_EVENT_INVALID', context: { field: 'payload', expected: 'record', actualType },
        }));
        expect(JSON.stringify(projectLogPayload(worldInfoContractFailureData(onContractError.mock.calls[0][0]), undefined, false))).not.toContain('private-body');
    });

    it.each(WORLD_INFO_LORE_LISTS)('validates all lists before delivery, including malformed %s', field => {
        for (const [value, actualType] of [[undefined, 'undefined'], [null, 'null'], [{ secret: 'private-body' }, 'object'], ['private-body', 'string']]) {
            const { host, events } = setup();
            const lore = payload();
            lore.globalLore.push({ content: 'private-content' });
            if (value === undefined)
                delete lore[field];
            else
                lore[field] = value;
            const before = structuredClone(lore);
            const listener = vi.fn(received => { received.globalLore.splice(0); });
            const onContractError = vi.fn();
            host.subscribeWorldInfoEntriesLoaded(listener, onContractError);
            events.worldinfo_entries_loaded(lore);
            expect(listener).not.toHaveBeenCalled();
            expect(lore).toEqual(before);
            expect(onContractError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                code: 'HOST_EVENT_INVALID', context: { field, expected: 'array', actualType },
            }));
            const data = worldInfoContractFailureData(onContractError.mock.calls[0][0]);
            expect(data).toMatchObject({ field, expected: 'array', actualType, reason: 'world-info-lore-array-invalid', outcome: 'round-skipped', sourceLocation: 'kernel/host.js:validateWorldInfoEntriesPayload' });
            expect(JSON.stringify(data)).not.toMatch(/private-content|private-body/);
        }
    });

    it('returns the error callback result and resumes delivery on the next valid event', async () => {
        const { host, events } = setup();
        const listener = vi.fn();
        const handled = Promise.resolve('handled');
        const onContractError = vi.fn(() => handled);
        host.subscribeWorldInfoEntriesLoaded(listener, onContractError);
        const result = events.worldinfo_entries_loaded({ globalLore: [] });
        expect(result).toBe(handled);
        await result;
        const valid = payload();
        events.worldinfo_entries_loaded(valid);
        expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
        expect(onContractError).toHaveBeenCalledOnce();
    });

    it('does not misclassify a consumer failure as an invalid host contract', async () => {
        const { host, events } = setup();
        const error = new Error('consumer failure');
        const onContractError = vi.fn();
        host.subscribeWorldInfoEntriesLoaded(() => Promise.reject(error), onContractError);
        await expect(events.worldinfo_entries_loaded(payload())).rejects.toBe(error);
        expect(onContractError).not.toHaveBeenCalled();
    });

    it('drops arbitrary context and unknown diagnostics from redacted contract records', () => {
        const error = new ToolkitError('HOST_EVENT_INVALID', 'private-message', {
            field: 'private-field', actualType: 'private-type', expected: 'private-constraint',
            sourceLocation: 'private-location', body: 'private-body',
        });
        const data = worldInfoContractFailureData(error);
        expect(data).toMatchObject({ field: 'payload', actualType: 'unknown', expected: 'record' });
        expect(JSON.stringify(projectLogPayload(data, undefined, false))).not.toContain('private');
    });
});
