import { describe, expect, it, vi } from 'vitest';
import { WorldInfoImagesRuntime } from '../src/features/world-info-images/runtime.js';

function createMockHost(worlds = {}) {
    const dataStore = structuredClone(worlds);
    const globalStore = {};
    return {
        listWorldInfoNames: vi.fn(() => Object.keys(dataStore)),
        activeWorldInfoBindings: vi.fn(() => [
            { name: 'LoreChat', source: 'chat' },
            { name: 'LoreChar', source: 'character' },
        ]),
        loadWorldInfoFresh: vi.fn(async name => structuredClone(dataStore[name] ?? null)),
        saveWorldInfo: vi.fn(async (name, data) => {
            dataStore[name] = structuredClone(data);
        }),
        globalGet: vi.fn(async key => structuredClone(globalStore[key])),
        globalSet: vi.fn(async (key, value) => { globalStore[key] = structuredClone(value); }),
        globalDelete: vi.fn(async key => { delete globalStore[key]; }),
        _store: dataStore,
        _global: globalStore,
    };
}

describe('WorldInfoImagesRuntime entry images', () => {
    const PNG_BYTES = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52,
    ]);

    function imageHost() {
        const host = createMockHost({ LoreChat: { entries: { 1: { uid: 1, comment: 'A', content: '正文' } } } });
        const blobs = new Map();
        host.storeSetBlob = vi.fn(async (table, key, data) => { blobs.set(key, data); });
        host.storeGetBlob = vi.fn(async (table, key) => {
            if (!blobs.has(key))
                throw new Error('not found');
            return blobs.get(key);
        });
        host._blobs = blobs;
        return host;
    }

    it('binds an uploaded image to the entry draft and keeps it through save', async () => {
        const host = imageHost();
        const runtime = new WorldInfoImagesRuntime(host);
        await runtime.init();

        const binding = await runtime.bindEntryImageFromFile(new Blob([PNG_BYTES], { type: 'image/png' }));
        expect(binding.mimeType).toBe('image/png');
        expect(host.storeSetBlob).toHaveBeenCalledWith('world-info-images', binding.blobKey, expect.any(Blob));
        expect(runtime.state.currentDraft.extensions['tt-toolkit'].image).toEqual(binding);
        expect(runtime.state.currentImagePreviewUrl.startsWith('data:image/png;base64,')).toBe(true);
        expect(runtime.state.dirty).toBe(true);

        runtime.setImageDescription('user 的肖像');
        await runtime.saveCurrentDraft();
        expect(host._store.LoreChat.entries[1].extensions['tt-toolkit'].image).toEqual({ ...binding, description: 'user 的肖像' });
        expect(host._store.LoreChat.entries[1].content).toBe('正文');
        const reloaded = new WorldInfoImagesRuntime(host);
        await reloaded.init();
        expect(reloaded.state.currentDraft.extensions['tt-toolkit'].image.description).toBe('user 的肖像');
        await runtime.bindEntryImageFromFile(new Blob([PNG_BYTES]));
        expect(runtime.state.currentDraft.extensions['tt-toolkit'].image.description).toBe('user 的肖像');

        runtime.removeEntryImage();
        await runtime.saveCurrentDraft();
        expect(host._store.LoreChat.entries[1].extensions).toBeUndefined();
        runtime.cancelTimer();
    });

    it('does not bind an asynchronous upload to a different entry', async () => {
        const host = imageHost();
        const runtime = new WorldInfoImagesRuntime(host);
        await runtime.init();
        let finish;
        const pending = runtime.bindEntryImage(() => new Promise(resolve => { finish = resolve; }));
        await runtime.createEntry();
        finish({ binding: {}, dataUrl: '' });
        await expect(pending).rejects.toThrow(/切换/);
        expect(runtime.state.currentDraft.extensions).toBeUndefined();
        runtime.cancelTimer();
    });

    it('reports a broken binding and a missing blob without breaking the entry', async () => {
        const host = imageHost();
        host._store.LoreChat.entries[1].extensions = { 'tt-toolkit': { image: { schemaVersion: 1 } } };
        const runtime = new WorldInfoImagesRuntime(host);
        await runtime.init();
        await runtime.refreshCurrentImagePreview();
        expect(runtime.state.currentImageError).toContain('结构异常');
        expect(runtime.getFilteredEntries()[0]).toMatchObject({ imageInvalid: true, hasImage: false });

        // 结构正常但存储里没有对应 Blob：只提示，正文与草稿仍可编辑。
        host._store.LoreChat.entries[1].extensions = { 'tt-toolkit': { image: {
            schemaVersion: 1, blobKey: `img-${'b'.repeat(64)}.png`, mimeType: 'image/png', sizeBytes: 10,
        } } };
        await runtime.discardDraft();
        await runtime.refreshCurrentImagePreview();
        expect(runtime.state.currentImageError).toContain('缺失');
        expect(runtime.state.currentDraft.content).toBe('正文');
        runtime.cancelTimer();
    });
});
