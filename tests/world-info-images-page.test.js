import { describe, expect, it, vi } from 'vitest';
import { mountWorldInfoImagesPage } from '../src/features/world-info-images/page.js';
import { WorldInfoImagesRuntime } from '../src/features/world-info-images/runtime.js';
import { featureRegistrations } from '../src/features/registry.js';

function createHost() {
    let world = { entries: { 1: { uid: 1, comment: '圣殿', content: 'user 的原始设定' } } };
    const blobs = new Map();
    const handlers = new Map();
    return {
        listWorldInfoNames: () => ['Lore'],
        activeWorldInfoBindings: () => [],
        loadWorldInfoFresh: async () => structuredClone(world),
        saveWorldInfo: async (_name, next) => { world = structuredClone(next); },
        storeSetBlob: async (_table, key, blob) => { blobs.set(key, blob); },
        storeGetBlob: async (_table, key) => blobs.get(key),
        onHostEvent: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
        buildWorldInfoImageMessage: vi.fn(async ({ text, images }) => ({ chatMessage: { role: 'user', content: [text, ...images] } })),
        recordWorldInfoInjectedPromptMessages: vi.fn(),
        emit: (name, ...args) => handlers.get(name)?.(...args),
    };
}

const imageFile = () => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);

describe('independent world info images feature', () => {
    it('edits and saves the description without replacing the active input or changing entry content', async () => {
        const host = createHost();
        const runtime = new WorldInfoImagesRuntime(host);
        const target = document.createElement('div');
        document.body.append(target);
        const unmount = mountWorldInfoImagesPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelector('select').value).toBe('Lore'));
            expect(target.querySelector('textarea').disabled).toBe(true);
            await runtime.bindEntryImageFromFile(imageFile());
            const input = target.querySelector('textarea');
            input.focus();
            input.value = 'user 手持长剑。';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            expect(target.querySelector('textarea')).toBe(input);
            expect(document.activeElement).toBe(input);
            const save = [...target.querySelectorAll('button')].find(button => button.textContent === '保存图片设置');
            save.click();
            await vi.waitFor(async () => {
                const world = await host.loadWorldInfoFresh();
                expect(world.entries[1].extensions['tt-toolkit'].image.description).toBe('user 手持长剑。');
                expect(world.entries[1].content).toBe('user 的原始设定');
            });
            expect(target.querySelector('.wie-image-thumb')).not.toBeNull();
        } finally { unmount(); target.remove(); }
    });

    it('filters entries, switches entries via cards, and keeps search focus intact', async () => {
        const host = createHost();
        await host.saveWorldInfo('Lore', {
            entries: {
                1: { uid: 1, comment: '圣殿', key: ['骑士'], content: 'user 的原始设定' },
                2: { uid: 2, comment: '皇家图书馆', key: ['古籍'], content: '藏书设定' },
            },
        });
        const runtime = new WorldInfoImagesRuntime(host);
        const target = document.createElement('div');
        document.body.append(target);
        const unmount = mountWorldInfoImagesPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wii-card')).toHaveLength(2));
            await runtime.bindEntryImageFromFile(imageFile());
            await runtime.saveCurrentDraft();

            // 筛选“未绑图”应只显示条目 #2，点击卡片可切换编辑目标。
            const unimagedChip = [...target.querySelectorAll('.wii-chip')].find(btn => btn.textContent.startsWith('未绑图'));
            unimagedChip.click();
            expect(target.querySelectorAll('.wii-card')).toHaveLength(1);
            target.querySelector('.wii-card').click();
            await vi.waitFor(() => expect(runtime.state.selectedUid).toBe(2));

            // 切回“全部”并在搜索框输入时，保持搜索框焦点不丢失。
            const allChip = [...target.querySelectorAll('.wii-chip')].find(btn => btn.textContent.startsWith('全部'));
            allChip.click();
            const search = target.querySelector('[data-control="search"]');
            search.focus();
            search.value = '圣殿';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            expect(document.activeElement).toBe(search);
            expect(target.querySelectorAll('.wii-card')).toHaveLength(1);
        } finally { unmount(); target.remove(); }
    });

    it('injects images without loading the world info editor and stops when disabled', async () => {
        const host = createHost();
        const definition = featureRegistrations.find(feature => feature.id === 'world-info-images');
        const feature = await definition.load({ host, logger: { scoped: () => ({ info: vi.fn(), warn: vi.fn() }) } });
        const binding = {
            schemaVersion: 1, blobKey: `img-${'a'.repeat(64)}.png`, mimeType: 'image/png', sizeBytes: 8, description: '独立描述',
        };
        await host.storeSetBlob('world-info-images', binding.blobKey, imageFile());
        await feature.activate();
        await host.emit('GENERATION_STARTED', 'normal', {}, false);
        await host.emit('WORLDINFO_SCAN_DONE', { isFinal: true, activated: { entries: new Map([[1, {
            world: 'Lore', uid: 1, extensions: { 'tt-toolkit': { image: binding } },
        }]]) } });
        const chat = [{ role: 'user', content: 'hi' }];
        await host.emit('CHAT_COMPLETION_PROMPT_READY', { chat });
        expect(chat).toHaveLength(2);
        expect(chat[1].content[0]).toContain('独立描述');
        await feature.deactivate();
        await host.emit('CHAT_COMPLETION_PROMPT_READY', { chat });
        expect(chat).toHaveLength(2);
    });
});
