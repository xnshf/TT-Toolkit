import { describe, expect, it, vi } from 'vitest';
import { WorldInfoAiConfigStore } from '../src/features/world-info-ai/storage.js';

const CONFIG = { schemaVersion: 2, enabled: true, entries: {} };

function createHost(worlds = {}) {
    const worldStore = structuredClone(worlds);
    const table = new Map();
    return {
        loadWorldInfoFresh: vi.fn(async name => structuredClone(worldStore[name] ?? null)),
        saveWorldInfo: vi.fn(async (name, data) => { worldStore[name] = structuredClone(data); }),
        storeTryGetJson: vi.fn(async (tableName, key) => structuredClone(table.get(`${tableName}:${key}`))),
        storeSetJson: vi.fn(async (tableName, key, value) => { table.set(`${tableName}:${key}`, structuredClone(value)); }),
        storeDeleteJson: vi.fn(async (tableName, key) => { table.delete(`${tableName}:${key}`); }),
        _world: worldStore,
        _table: table,
    };
}

describe('WorldInfoAiConfigStore', () => {
    it('propagates a real world write failure instead of reporting a fallback save', async () => {
        const host = createHost({ Lore: { entries: {} } });
        const worldData = await host.loadWorldInfoFresh('Lore');
        host.saveWorldInfo.mockRejectedValueOnce(new Error('disk full'));

        const store = new WorldInfoAiConfigStore(host);
        await expect(store.save('Lore', CONFIG, worldData)).rejects.toThrow('disk full');
        expect(host.storeSetJson).not.toHaveBeenCalled();
        expect(host._world.Lore.extensions).toBeUndefined();
    });

    it('falls back to the extension store when the host drops the extension field', async () => {
        const host = createHost({ Lore: { entries: {} } });
        const worldData = await host.loadWorldInfoFresh('Lore');
        // 写入成功但宿主没有保留扩展字段
        host.saveWorldInfo.mockImplementationOnce(async () => {});

        const store = new WorldInfoAiConfigStore(host);
        const saved = await store.save('Lore', CONFIG, worldData);

        expect(saved.backend).toBe('extension-store');
        expect(host.storeSetJson).toHaveBeenCalledTimes(1);
        expect(await store.fallback('Lore')).toEqual(CONFIG);
    });

    it('round-trips the config through the world extension when the host keeps it', async () => {
        const host = createHost({ Lore: { entries: {} } });
        const worldData = await host.loadWorldInfoFresh('Lore');

        const store = new WorldInfoAiConfigStore(host);
        const saved = await store.save('Lore', CONFIG, worldData);

        expect(saved.backend).toBe('world-extension');
        expect(host._world.Lore.extensions['tt-toolkit'].worldInfoAiRouter).toEqual(CONFIG);
    });
});
