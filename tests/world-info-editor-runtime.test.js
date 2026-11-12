import { describe, expect, it, vi } from 'vitest';
import { WorldInfoEditorRuntime } from '../src/features/world-info-editor/runtime.js';

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

describe('WorldInfoEditorRuntime', () => {
    it('initializes and selects world matching chat binding by default', async () => {
        const host = createMockHost({
            LoreGlobal: { entries: {} },
            LoreChat: {
                entries: {
                    1: { uid: 1, comment: '条目一', key: ['词一'], content: '正文一', constant: true },
                    2: { uid: 2, comment: '条目二', key: ['词二'], content: '正文二', disable: true },
                },
            },
        });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        expect(runtime.state.selectedWorld).toBe('LoreChat');
        expect(runtime.state.selectedUid).toBe(1);
        expect(runtime.state.currentDraft?.comment).toBe('条目一');
        expect(runtime.state.dirty).toBe(false);
    });

    it('updates draft fields, tracks dirty state and auto-saves on debounce', async () => {
        vi.useFakeTimers();
        try {
            const host = createMockHost({
                TestWorld: {
                    entries: {
                        10: { uid: 10, comment: '原始标题', key: ['主词'], content: '原正文' },
                    },
                },
            });
            host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

            const runtime = new WorldInfoEditorRuntime(host);
            await runtime.init();

            runtime.updateDraftField('comment', '修改后标题');
            expect(runtime.state.dirty).toBe(true);
            expect(runtime.state.saveStatus).toBe('unsaved');
            expect(runtime.state.currentDraft.comment).toBe('修改后标题');

            // 尚未触发定时器前未写入
            expect(host.saveWorldInfo).not.toHaveBeenCalled();

            // 前进 1000ms 触发防抖自动保存
            await vi.advanceTimersByTimeAsync(1100);

            expect(host.saveWorldInfo).toHaveBeenCalledWith('TestWorld', expect.any(Object));
            expect(runtime.state.dirty).toBe(false);
            expect(runtime.state.saveStatus).toBe('saved_auto');
            expect(host._store.TestWorld.entries[10].comment).toBe('修改后标题');
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('flushes unsaved draft immediately when manually saving or switching entries', async () => {
        const host = createMockHost({
            TestWorld: {
                entries: {
                    1: { uid: 1, comment: '条目一', key: [], content: '正文一' },
                    2: { uid: 2, comment: '条目二', key: [], content: '正文二' },
                },
            },
        });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        runtime.updateDraftField('content', '新正文内容');
        expect(runtime.state.dirty).toBe(true);

        // 切换条目时应自动 flush 保存条目一
        await runtime.selectEntry(2);

        expect(host.saveWorldInfo).toHaveBeenCalledWith('TestWorld', expect.any(Object));
        expect(host._store.TestWorld.entries[1].content).toBe('新正文内容');
        expect(runtime.state.selectedUid).toBe(2);
        expect(runtime.state.dirty).toBe(false);
    });

    it('creates, duplicates, and deletes entries accurately', async () => {
        const host = createMockHost({
            TestWorld: {
                entries: {
                    0: { uid: 0, comment: '起始条目', key: ['词A'], content: '正文A', constant: false },
                },
            },
        });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        // 创建新条目
        await runtime.createEntry();
        expect(runtime.state.selectedUid).toBe(1);
        expect(runtime.state.worldData.entries[1]).toBeDefined();

        // 复制条目 1
        await runtime.duplicateEntry(1);
        expect(runtime.state.selectedUid).toBe(2);
        expect(runtime.state.worldData.entries[2].comment).toContain('副本');

        // 删除条目 1
        await runtime.deleteEntry(1);
        expect(runtime.state.worldData.entries[1]).toBeUndefined();
        expect(Object.keys(runtime.state.worldData.entries)).toHaveLength(2);
    });

    it('toggles entry active status directly from list view', async () => {
        const host = createMockHost({
            TestWorld: {
                entries: {
                    5: { uid: 5, comment: '条目五', key: [], content: '', disable: false },
                },
            },
        });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        await runtime.toggleEntryActive(5, false);
        expect(host._store.TestWorld.entries[5].disable).toBe(true);

        await runtime.toggleEntryActive(5, true);
        expect(host._store.TestWorld.entries[5].disable).toBe(false);
    });

    it('preserves the draft and refuses navigation after a failed write or external change', async () => {
        const host = createMockHost({ LoreChat: { entries: { 1: { uid: 1, comment: 'A', content: 'original' }, 2: { uid: 2, comment: 'B' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();
        runtime.updateDraftField('content', 'draft');
        host.saveWorldInfo.mockRejectedValueOnce(new Error('disk failed'));
        await expect(runtime.selectEntry(2)).rejects.toThrow('disk failed');
        expect(runtime.state.selectedUid).toBe(1);
        expect(runtime.state.currentDraft.content).toBe('draft');
        expect(runtime.state.dirty).toBe(true);
        expect(runtime.state.saveStatus).toBe('error');
        // The failed write may have polluted host cache; fresh read remains authoritative.
        host._store.LoreChat.entries[2].comment = 'external edit';
        await expect(runtime.saveCurrentDraft()).rejects.toThrow(/世界书已被其它操作修改/);
        expect(runtime.state.dirty).toBe(true);
        expect(host._store.LoreChat.entries[1].content).toBe('original');
        runtime.cancelTimer();
    });

    it('keeps external fields intact and writes only changed fields', async () => {
        const host = createMockHost({ LoreChat: { extensions: { custom: { keep: true } }, entries: {
            1: { uid: 1, comment: 'A', key: ['x'], content: 'old', extensions: { vendor: 'untouched' } },
        } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();
        runtime.updateDraftField('comment', 'new');
        await runtime.saveCurrentDraft();
        expect(host._store.LoreChat.entries[1].extensions).toEqual({ vendor: 'untouched' });
        expect(host._store.LoreChat.entries[1]).not.toHaveProperty('groupWeight');
        expect(host._store.LoreChat.extensions.custom.keep).toBe(true);
    });

    it('filters and sorts entries correctly', async () => {
        const host = createMockHost({
            TestWorld: {
                entries: {
                    1: { uid: 1, comment: '骑士团设定', key: ['骑士', '佩剑'], content: '帝国精锐武装', constant: true, disable: false, order: 100 },
                    2: { uid: 2, comment: '魔法学院', key: ['法师', '卷轴'], content: '古老学院', constant: false, disable: false, order: 50 },
                    3: { uid: 3, comment: '废弃矿道', key: ['矿石'], content: '危险区域', constant: false, disable: true, order: 200, position: 4, depth: 2 },
                },
            },
        });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        // 默认按 order 排序：学院 (50) -> 骑士 (100) -> 矿道 (200)
        let list = runtime.getFilteredEntries();
        expect(list.map(e => e.uid)).toEqual([2, 1, 3]);

        // 搜索关键词 '卷轴'
        runtime.setSearchQuery('卷轴');
        list = runtime.getFilteredEntries();
        expect(list.map(e => e.uid)).toEqual([2]);

        // 清空搜索，过滤常驻条目
        runtime.setSearchQuery('');
        runtime.setFilter('constant');
        list = runtime.getFilteredEntries();
        expect(list.map(e => e.uid)).toEqual([1]);

        // 过滤已禁用条目
        runtime.setFilter('disabled');
        list = runtime.getFilteredEntries();
        expect(list.map(e => e.uid)).toEqual([3]);

        // 过滤深度注入
        runtime.setFilter('depth');
        list = runtime.getFilteredEntries();
        expect(list.map(e => e.uid)).toEqual([3]);

        // 统计数据验证
        const stats = runtime.getStats();
        expect(stats.total).toBe(3);
        expect(stats.constant).toBe(1);
        expect(stats.active).toBe(2);
        expect(stats.disabled).toBe(1);
        expect(stats.totalTokens).toBeGreaterThan(0);
    });

    it('converts standalone user words across the whole entry only on manual save', async () => {
        vi.useFakeTimers();
        try {
            const host = createMockHost({
                TestWorld: { entries: { 1: { uid: 1, comment: 'user 条目', key: ['user'], keysecondary: ['与user独处'], content: '与 user 独处' } } },
            });
            host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

            const runtime = new WorldInfoEditorRuntime(host);
            await runtime.init();

            runtime.updateDraftField('content', '与 user 独处');
            await vi.advanceTimersByTimeAsync(1100);
            // 自动保存不改写内容，user 原样写入。
            expect(host._store.TestWorld.entries[1].content).toBe('与 user 独处');
            expect(runtime.state.currentDraft.content).toBe('与 user 独处');

            await runtime.saveCurrentDraft({ isAuto: false });
            expect(host._store.TestWorld.entries[1].content).toBe('与 {{user}} 独处');
            expect(host._store.TestWorld.entries[1].comment).toBe('{{user}} 条目');
            expect(host._store.TestWorld.entries[1].key).toEqual(['{{user}}']);
            expect(host._store.TestWorld.entries[1].keysecondary).toEqual(['与{{user}}独处']);
            expect(runtime.state.currentDraft.content).toBe('与 {{user}} 独处');
            expect(runtime.state.lastConversionCount).toBe(4);
            expect(runtime.state.dirty).toBe(false);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('converts user words when manually saving an otherwise unmodified entry', async () => {
        const host = createMockHost({ TestWorld: { entries: { 1: { uid: 1, content: 'user 独自' } } } });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();
        expect(runtime.state.dirty).toBe(false);

        await runtime.saveCurrentDraft({ isAuto: false });
        expect(host._store.TestWorld.entries[1].content).toBe('{{user}} 独自');
        expect(runtime.state.lastConversionCount).toBe(1);
    });

    it('skips user conversion when the functional toggle is off', async () => {
        const host = createMockHost({ TestWorld: { entries: { 1: { uid: 1, content: 'user 独自' } } } });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);
        host._global['world-info-editor-settings-v1'] = { schemaVersion: 1, convertUserMacro: false };

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();
        expect(runtime.state.settings.convertUserMacro).toBe(false);

        await runtime.saveCurrentDraft({ isAuto: false });
        expect(host._store.TestWorld.entries[1].content).toBe('user 独自');
        expect(runtime.state.lastConversionCount).toBe(0);
    });

    it('persists the toggle and falls back to defaults on a corrupted settings schema', async () => {
        const host = createMockHost({ TestWorld: { entries: {} } });
        host.activeWorldInfoBindings.mockReturnValue([{ name: 'TestWorld', source: 'chat' }]);
        host._global['world-info-editor-settings-v1'] = { schemaVersion: 1, convertUserMacro: 'yes' };

        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();
        expect(runtime.state.settings.convertUserMacro).toBe(true);
        expect(runtime.state.settingsError).toContain('回退默认值');

        await runtime.setConvertUserMacro(false);
        expect(host._global['world-info-editor-settings-v1']).toEqual({ schemaVersion: 1, convertUserMacro: false });
        expect(runtime.state.settingsError).toBe('');
    });
});

// TauriTavern 的 serde_json 未启用 preserve_order：对象键在磁盘与响应里都被重排为字典序。
// 客户端自己构造的对象保留 JS 插入顺序，宿主往返一次就不再逐字节相同。
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    return value;
}

function createKeyReorderingHost(worlds = {}) {
    const dataStore = structuredClone(worlds);
    return {
        listWorldInfoNames: vi.fn(() => Object.keys(dataStore)),
        activeWorldInfoBindings: vi.fn(() => [{ name: 'Lore', source: 'chat' }]),
        loadWorldInfoFresh: vi.fn(async name => structuredClone(sortKeys(dataStore[name] ?? null))),
        saveWorldInfo: vi.fn(async (name, data) => { dataStore[name] = structuredClone(sortKeys(data)); }),
        globalGet: vi.fn(async () => undefined),
        globalSet: vi.fn(async () => undefined),
        globalDelete: vi.fn(async () => undefined),
        _store: dataStore,
    };
}

describe('WorldInfoEditorRuntime host key ordering', () => {
    it('keeps saving after a created entry is edited again', async () => {
        const host = createKeyReorderingHost({ Lore: { entries: { 1: { uid: 1, comment: 'A', content: 'x' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        await runtime.createEntry();
        const createdUid = runtime.state.selectedUid;
        runtime.updateDraftField('order', 101);
        await runtime.saveCurrentDraft();
        expect(host._store.Lore.entries[createdUid].order).toBe(101);

        runtime.updateDraftField('content', '正文');
        await runtime.saveCurrentDraft();
        expect(host._store.Lore.entries[createdUid].content).toBe('正文');
        expect(runtime.state.saveStatus).toBe('saved_manual');
        expect(runtime.state.dirty).toBe(false);
        runtime.cancelTimer();
    });

    it('keeps saving after a field absent from the stored entry is added', async () => {
        const host = createKeyReorderingHost({ Lore: { entries: { 1: { uid: 1, comment: 'A', content: 'x' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        runtime.updateDraftField('matchWholeWords', true);
        await runtime.saveCurrentDraft();
        runtime.updateDraftField('content', '第二版');
        await runtime.saveCurrentDraft();

        expect(host._store.Lore.entries[1]).toMatchObject({ matchWholeWords: true, content: '第二版' });
        runtime.cancelTimer();
    });

    it('keeps the book-level extension fields intact across key reordering', async () => {
        const extension = { 'tt-toolkit': { worldInfoAiRouter: { schemaVersion: 2, enabled: true, entries: {} } } };
        const host = createKeyReorderingHost({ Lore: { extensions: extension, entries: { 1: { uid: 1, content: 'x' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        runtime.updateDraftField('content', 'y');
        await runtime.saveCurrentDraft();

        expect(host._store.Lore.extensions).toEqual(extension);
        runtime.cancelTimer();
    });
});

describe('WorldInfoEditorRuntime conflict recovery', () => {
    it('re-reads the book while keeping the draft, without writing it', async () => {
        const host = createMockHost({ LoreChat: { entries: { 1: { uid: 1, comment: 'A', content: 'original' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        runtime.updateDraftField('content', 'draft');
        host._store.LoreChat.entries[1].content = 'external';
        await expect(runtime.saveCurrentDraft()).rejects.toThrow(/世界书已被其它操作修改/);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();

        const result = await runtime.refreshWorlds({ keepDraft: true });
        expect(result.draftKept).toBe(true);
        expect(runtime.state.dirty).toBe(true);
        expect(runtime.state.currentDraft.content).toBe('draft');
        expect(runtime.state.worldData.entries[1].content).toBe('external');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        runtime.cancelTimer();
    });

    it('writes the kept draft onto the refreshed baseline afterwards', async () => {
        const host = createMockHost({ LoreChat: { entries: { 1: { uid: 1, comment: 'A', content: 'original' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        runtime.updateDraftField('content', 'draft');
        host._store.LoreChat.entries[1].content = 'external';
        await expect(runtime.saveCurrentDraft()).rejects.toThrow(/世界书已被其它操作修改/);
        await runtime.refreshWorlds({ keepDraft: true });
        await runtime.saveCurrentDraft();

        expect(host._store.LoreChat.entries[1].content).toBe('draft');
        expect(runtime.state.dirty).toBe(false);
        runtime.cancelTimer();
    });

    it('drops the draft back to the stored facts without writing', async () => {
        const host = createMockHost({ LoreChat: { entries: { 1: { uid: 1, content: 'original' } } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        runtime.updateDraftField('content', 'draft');
        await runtime.discardDraft();

        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(runtime.state.dirty).toBe(false);
        expect(runtime.state.saveStatus).toBe('idle');
        expect(runtime.state.currentDraft.content).toBe('original');
        runtime.cancelTimer();
    });
});

describe('WorldInfoEditorRuntime malformed entries', () => {
    it('degrades a malformed entry to one readable, deletable row', async () => {
        const host = createMockHost({ LoreChat: { entries: { 1: { uid: 1, comment: 'A' }, 2: ['broken'] } } });
        const runtime = new WorldInfoEditorRuntime(host);
        await runtime.init();

        const entries = runtime.getFilteredEntries();
        expect(entries).toHaveLength(2);
        expect(entries.find(item => item.uid === 2)).toMatchObject({ broken: true, comment: '(结构异常的条目)' });
        await expect(runtime.selectEntry(2)).rejects.toThrow(/结构异常/);

        await runtime.deleteEntry(2);
        expect(host._store.LoreChat.entries[2]).toBeUndefined();
        expect(runtime.getFilteredEntries()).toHaveLength(1);
        runtime.cancelTimer();
    });
});

