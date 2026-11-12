import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/kernel/hash.js';
import { createStagedChange, stageChange } from '../src/features/prompt-conflict/overrides.js';
import { PromptConflictRuntime } from '../src/features/prompt-conflict/runtime.js';
import { TauriTavernHost } from '../src/kernel/host.js';

function worldEntry(world, uid, overrides = {}) {
    return {
        world,
        uid,
        comment: `条目 ${uid}`,
        content: `内容-${uid}`,
        constant: true,
        disable: false,
        order: 100 - uid,
        position: 0,
        ...overrides,
    };
}

async function suppressedRecord(world, uid, content) {
    return { worldDigest: await sha256Hex(world), uid, contentDigest: await sha256Hex(content) };
}

function setup(options = {}) {
    const handlers = {};
    let stableId = 'chat-1';
    let metadata = options.chatMetadata;
    const host = {
        subscribePromptConflictSourceInvalidation: vi.fn(listener => {
            handlers.invalidation = listener;
            return () => { handlers.invalidation = null; };
        }),
        subscribeWorldInfoEntriesLoaded: vi.fn(TauriTavernHost.prototype.subscribeWorldInfoEntriesLoaded),
        validateWorldInfoEntriesPayload: TauriTavernHost.prototype.validateWorldInfoEntriesPayload,
        onHostEvent: vi.fn((name, handler) => {
            expect(name).toBe('WORLDINFO_ENTRIES_LOADED');
            handlers.worldInfo = handler;
            return () => { handlers.worldInfo = null; };
        }),
        getCurrentChatIdentity: vi.fn(async () => ({ stableId, label: 'Test chat', ref: {} })),
        getPromptConflictChatMetadata: vi.fn(async () => metadata),
        setPromptConflictChatMetadata: vi.fn(async (_id, value) => { metadata = value; }),
        getMountedWorldInfoEntries: vi.fn(async () => structuredClone(options.mounted ?? { globalLore: [], characterLore: [], chatLore: [], personaLore: [] })),
        getPromptConflictPresetSources: vi.fn(async () => structuredClone(options.presetSources ?? [])),
        expandPromptConflictSourceMacros: vi.fn(async content => String(content ?? '')),
        globalGet: vi.fn(async key => {
            if (key === 'prompt-conflict-settings-v1')
                return host.featureSettings;
            if (key === 'llm-presets-v1')
                return {
                    schemaVersion: 1,
                    activePresetId: 'p1',
                    presets: [
                        { id: 'p1', name: 'Local', apiUrl: 'https://local.invalid/v1', model: 'model-a', apiKey: '' },
                        { id: 'p2', name: 'Backup', apiUrl: 'https://backup.invalid/v1', model: 'model-b', apiKey: '' },
                    ],
                };
            return undefined;
        }),
        globalSet: vi.fn(async (key, value) => {
            if (key === 'prompt-conflict-settings-v1')
                host.featureSettings = structuredClone(value);
        }),
        activeWorldInfoNames: vi.fn(() => ['Lore']),
        setStableId(value) { stableId = value; },
    };
    const analysis = {
        run: vi.fn(async () => ({
            directives: [{ directiveId: 'preset:main#a1', sourceId: 'preset:main', kind: 'requirement', statement: '保持简洁', condition: null, evidence: ['保持简洁'] }],
            conflicts: [{ directiveIds: ['preset:main#a1'], severity: 'high', category: 'contradiction', title: 't', explanation: 'e', options: [{ label: 'l', consequence: 'c', sourceIds: [] }] }],
            batches: 1,
            calls: 2,
        })),
    };
    if (options.analysisError)
        analysis.run.mockRejectedValue(options.analysisError);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new PromptConflictRuntime(host, log, { analysis });
    return { runtime, host, handlers, analysis, log };
}

const DEFAULT_PRESET = [{ identifier: 'main', label: 'Main', role: 'system', position: 0, order: 100, content: '保持简洁' }];

describe('prompt conflict runtime lifecycle', () => {
    it('activates host subscriptions and deactivates symmetrically', async () => {
        const { runtime, host, handlers } = setup();
        await runtime.activate();
        expect(host.subscribePromptConflictSourceInvalidation).toHaveBeenCalledOnce();
        expect(host.subscribeWorldInfoEntriesLoaded).toHaveBeenCalledOnce();
        await runtime.deactivate();
        expect(handlers.invalidation).toBeNull();
        expect(handlers.worldInfo).toBeNull();
    });

    it('deactivation cancels runs, clears staging and keeps persisted metadata', async () => {
        const { runtime, host } = setup();
        await runtime.activate();
        const world = worldEntry('Lore', 1);
        host.getMountedWorldInfoEntries.mockResolvedValueOnce({ globalLore: [world], characterLore: [], chatLore: [], personaLore: [] });
        await runtime.refresh();
        const source = runtime.snapshotSources().find(item => item.uid === 1);
        runtime.stageSuppress(source.sourceId);
        expect(runtime.state.stagedChanges.size).toBe(1);
        await runtime.deactivate();
        expect(runtime.state.stagedChanges.size).toBe(0);
        expect(host.setPromptConflictChatMetadata).not.toHaveBeenCalled();
    });
});

describe('prompt conflict snapshot building', () => {
    it('collects preset and constant world sources with defaults selected', async () => {
        const { runtime, host } = setup({ presetSources: DEFAULT_PRESET });
        host.getMountedWorldInfoEntries.mockResolvedValueOnce({
            globalLore: [worldEntry('Lore', 1)],
            characterLore: [],
            chatLore: [],
            personaLore: [],
        });
        await runtime.refresh();
        const sources = runtime.snapshotSources();
        expect(sources).toHaveLength(2);
        const presetSource = sources.find(source => source.sourceType === 'preset');
        expect(presetSource.label).toBe('Main');
        expect(presetSource.sourceId).toBe(`preset:${await sha256Hex('main')}`);
        const worldSource = sources.find(source => source.sourceType === 'world-info');
        expect(worldSource.sourceId).toBe(`wi:${await sha256Hex('Lore')}:1`);
        expect(runtime.state.selectedSourceIds.size).toBe(2);
        expect(runtime.state.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(runtime.state.status).toContain('可检测 2');
    });

    it('excludes non-constant and disabled entries and marks dynamic ones unsupported', async () => {
        const { runtime, host } = setup();
        host.getMountedWorldInfoEntries.mockResolvedValueOnce({
            globalLore: [
                worldEntry('Lore', 1, { constant: false }),
                worldEntry('Lore', 2, { disable: true }),
                worldEntry('Lore', 3, { content: '@@if variables.ready\n<%- variables.x %>' }),
            ],
            characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const sources = runtime.snapshotSources();
        expect(sources.map(source => source.uid)).toEqual([3]);
        expect(sources[0].dynamic).toBe(true);
        expect(runtime.state.selectedSourceIds.size).toBe(0);
        expect(runtime.state.status).toContain('可检测 0');
        expect(runtime.state.status).toContain('无法静态检测 1');
    });

    it('flags entries suppressed by current chat metadata and keeps them out of selection', async () => {
        const { runtime, host } = setup({
            chatMetadata: {
                schemaVersion: 1,
                disabledWorldEntries: [await suppressedRecord('Lore', 1, '内容-1')],
            },
        });
        host.getMountedWorldInfoEntries.mockResolvedValueOnce({
            globalLore: [worldEntry('Lore', 1), worldEntry('Lore', 2)],
            characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const suppressed = runtime.snapshotSources().find(source => source.uid === 1);
        expect(suppressed.suppressedForCurrentChat).toBe(true);
        expect(runtime.state.selectedSourceIds.has(suppressed.sourceId)).toBe(false);
        expect(runtime.state.status).toContain('已屏蔽 1');
    });

    it('surfaces damaged chat metadata with a reset path instead of guessing', async () => {
        const { runtime, host } = setup({ chatMetadata: { schemaVersion: 9, disabledWorldEntries: [] } });
        await runtime.refresh();
        expect(runtime.state.metadataError).toMatch(/版本/);
        expect(runtime.metadataRecords).toEqual([]);
        await runtime.resetChatMetadata();
        expect(host.setPromptConflictChatMetadata).toHaveBeenCalledWith('chat-1', { schemaVersion: 1, disabledWorldEntries: [] });
        expect(runtime.state.metadataError).toBe('');
    });

    it('expands macros before analysis and preserves raw digests for override records', async () => {
        const { runtime, host } = setup();
        host.expandPromptConflictSourceMacros.mockImplementation(async content => String(content).replaceAll('{{user}}', '小明'));
        host.getMountedWorldInfoEntries.mockResolvedValueOnce({
            globalLore: [worldEntry('Lore', 1, { content: '与 {{user}} 独处时保持简洁' })],
            characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const source = runtime.snapshotSources()[0];
        expect(source.content).toBe('与 小明 独处时保持简洁');
        expect(source.contentDigest).toBe(await sha256Hex('与 小明 独处时保持简洁'));
        expect(source.rawContentDigest).toBe(await sha256Hex('与 {{user}} 独处时保持简洁'));
    });

    it('keeps prior selection only for still-analyzable sources', async () => {
        const { runtime, host } = setup({ presetSources: DEFAULT_PRESET });
        host.getMountedWorldInfoEntries.mockResolvedValue({ globalLore: [worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: [] });
        await runtime.refresh();
        const presetSource = runtime.snapshotSources().find(source => source.sourceType === 'preset');
        const worldSource = runtime.snapshotSources().find(source => source.sourceType === 'world-info');
        await runtime.setSourceSelected(presetSource.sourceId, false);
        expect(runtime.state.selectedSourceIds.size).toBe(1);
        await runtime.refresh();
        expect(runtime.state.selectedSourceIds.has(presetSource.sourceId)).toBe(false);
        expect(runtime.state.selectedSourceIds.has(worldSource.sourceId)).toBe(true);
    });
});

describe('prompt conflict selection', () => {
    it('only ever selects analyzable sources', async () => {
        const { runtime, host } = setup({ presetSources: DEFAULT_PRESET });
        host.getMountedWorldInfoEntries.mockResolvedValue({
            globalLore: [worldEntry('Lore', 1, { content: '@@if x\n<%- x %>' })],
            characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const presetSource = runtime.snapshotSources()[0];
        const dynamic = runtime.snapshotSources()[1];
        await runtime.setSourceSelected(dynamic.sourceId, true);
        expect(runtime.state.selectedSourceIds.has(dynamic.sourceId)).toBe(false);
        expect(runtime.state.selectedSourceIds.has(presetSource.sourceId)).toBe(true);
        await runtime.setSourceSelected(presetSource.sourceId, true);
        expect(runtime.state.selectedSourceIds.size).toBe(1);
        await runtime.clearSelection();
        expect(runtime.state.selectedSourceIds.size).toBe(0);
        await runtime.selectAllAnalyzable();
        expect(runtime.state.selectedSourceIds.has(presetSource.sourceId)).toBe(true);
    });

    it('marks the report stale when selection changes after a completed detection', async () => {
        const { runtime, host, analysis } = setup({ presetSources: DEFAULT_PRESET });
        await runtime.refresh();
        await runtime.runDetection();
        expect(runtime.state.reportStale).toBe(false);
        await runtime.setSourceSelected(runtime.state.selectedSourceIds.values().next().value, false);
        expect(runtime.state.reportStale).toBe(true);
    });
});

describe('prompt conflict detection', () => {
    it('runs a full detection and atomically replaces the report', async () => {
        const { runtime, analysis } = setup({ presetSources: DEFAULT_PRESET });
        await runtime.refresh();
        await runtime.runDetection();
        expect(analysis.run).toHaveBeenCalledOnce();
        expect(runtime.state.report).toMatchObject({ sourceIds: [runtime.state.selectedSourceIds.values().next().value], batches: 1, calls: 2 });
        expect(runtime.state.report.counts.high).toBe(1);
        expect(runtime.state.reportStale).toBe(false);
        expect(runtime.state.status).toContain('检测完成');
    });

    it('keeps the old report on failure and reports a classified error', async () => {
        const { runtime, analysis } = setup({ presetSources: DEFAULT_PRESET });
        await runtime.refresh();
        await runtime.runDetection();
        const oldReport = runtime.state.report;
        analysis.run.mockRejectedValueOnce(new Error('network down'));
        await runtime.runDetection();
        expect(runtime.state.report).toBe(oldReport);
        expect(runtime.state.error).toContain('network down');
    });

    it('cancels an in-flight run without replacing the old report', async () => {
        const { runtime, analysis } = setup({ presetSources: DEFAULT_PRESET });
        await runtime.refresh();
        await runtime.runDetection();
        const oldReport = runtime.state.report;
        let resolveRun;
        analysis.run.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve; }));
        const detection = runtime.runDetection();
        await vi.waitFor(() => expect(runtime.state.phase).toBe('detecting'));
        runtime.cancelRun();
        resolveRun({ directives: [], conflicts: [], batches: 1, calls: 2 });
        await detection;
        expect(runtime.state.report).toBe(oldReport);
        expect(runtime.state.status).toContain('已取消');
    });

    it('refuses to detect without sources or without a model preset', async () => {
        const { runtime, analysis } = setup();
        await runtime.refresh();
        await runtime.runDetection();
        expect(analysis.run).not.toHaveBeenCalled();
        expect(runtime.state.error).toContain('未选择任何可分析来源');
        runtime.state.error = '';

        const { runtime: presetMissing } = setup({ presetSources: DEFAULT_PRESET });
        presetMissing.host.globalGet.mockImplementation(async key => {
            if (key === 'llm-presets-v1')
                return { schemaVersion: 1, activePresetId: null, presets: [] };
            return undefined;
        });
        await presetMissing.refresh();
        await presetMissing.runDetection();
        expect(presetMissing.state.error).toContain('未选择模型服务预设');
    });

    it('detection progress surfaces extraction and comparison stages', async () => {
        const { runtime, analysis } = setup({ presetSources: DEFAULT_PRESET });
        await runtime.refresh();
        let resolveRun;
        analysis.run.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve; }));
        const detection = runtime.runDetection();
        await vi.waitFor(() => expect(runtime.state.phase).toBe('detecting'));
        expect(runtime.state.activeRun).toMatchObject({ stage: 'extracting', total: 1 });
        resolveRun({ directives: [], conflicts: [], batches: 1, calls: 2 });
        await detection;
        expect(runtime.state.activeRun).toBeNull();
        expect(runtime.state.report).not.toBeNull();
    });
});

describe('prompt conflict chat overrides', () => {
    it('allows staging a suppression for dynamic template world entries with the warning flag', async () => {
        const { runtime, host } = setup();
        host.getMountedWorldInfoEntries.mockResolvedValue({
            globalLore: [worldEntry('Lore', 1, { content: '@@if variables.ready\n<%- variables.x %>' })],
            characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const dynamic = runtime.snapshotSources()[0];
        expect(dynamic.dynamic).toBe(true);
        runtime.stageSuppress(dynamic.sourceId);
        expect(runtime.state.stagedChanges.size).toBe(1);
        expect([...runtime.state.stagedChanges.values()][0].dynamic).toBe(true);
        await runtime.beginApplyReview();
        await runtime.commitStagedChanges();
        expect(host.setPromptConflictChatMetadata).toHaveBeenCalledOnce();
        expect(runtime.state.stagedChanges.size).toBe(0);
    });

    it('stages suppress and restore with cancel-out semantics', async () => {
        const { runtime, host } = setup();
        host.getMountedWorldInfoEntries.mockResolvedValue({
            globalLore: [worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const source = runtime.snapshotSources()[0];
        runtime.stageSuppress(source.sourceId);
        expect(runtime.state.stagedChanges.size).toBe(1);
        runtime.stageSuppress(source.sourceId);
        expect(runtime.state.stagedChanges.size).toBe(1);
        await runtime.beginApplyReview();
        await runtime.commitStagedChanges();
        expect(host.setPromptConflictChatMetadata).toHaveBeenCalledOnce();
        expect(runtime.state.stagedChanges.size).toBe(0);
        const suppressedSource = runtime.snapshotSources()[0];
        expect(suppressedSource.suppressedForCurrentChat).toBe(true);
        runtime.stageRestore(suppressedSource.sourceId);
        expect(runtime.state.stagedChanges.size).toBe(1);
        await runtime.beginApplyReview();
        await runtime.commitStagedChanges();
        expect(runtime.state.stagedChanges.size).toBe(0);
        expect(runtime.snapshotSources()[0].suppressedForCurrentChat).toBe(false);
    });

    it('applies a staged plan after revalidation and writes metadata once', async () => {
        const { runtime, host } = setup();
        host.getMountedWorldInfoEntries.mockResolvedValue({
            globalLore: [worldEntry('Lore', 5, { content: '新内容' }), worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const source = runtime.snapshotSources().find(item => item.uid === 5);
        runtime.stageSuppress(source.sourceId);
        await runtime.beginApplyReview();
        await runtime.commitStagedChanges();
        expect(host.setPromptConflictChatMetadata).toHaveBeenCalledOnce();
        expect(host.setPromptConflictChatMetadata.mock.calls[0][0]).toBe('chat-1');
        const written = host.setPromptConflictChatMetadata.mock.calls[0][1];
        expect(written.schemaVersion).toBe(1);
        expect(written.disabledWorldEntries).toHaveLength(1);
        expect(written.disabledWorldEntries[0].uid).toBe(5);
        expect(runtime.state.stagedChanges.size).toBe(0);
        expect(runtime.state.status).toContain('屏蔽 1 项');
        const suppressedSource = runtime.snapshotSources().find(item => item.uid === 5);
        expect(suppressedSource.suppressedForCurrentChat).toBe(true);
    });

    it('refuses to apply when the target entry changed or the chat switched', async () => {
        const { runtime, host } = setup();
        host.getMountedWorldInfoEntries.mockResolvedValue({
            globalLore: [worldEntry('Lore', 5, { content: '旧内容' })], characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const source = runtime.snapshotSources().find(item => item.uid === 5);
        runtime.stageSuppress(source.sourceId);
        await runtime.beginApplyReview();
        host.getMountedWorldInfoEntries.mockResolvedValueOnce({
            globalLore: [worldEntry('Lore', 5, { content: '已修改' })], characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.commitStagedChanges();
        expect(host.setPromptConflictChatMetadata).not.toHaveBeenCalled();
        expect(runtime.state.error).toMatch(/已删除、已修改/);
        expect(runtime.state.stagedChanges.size).toBe(1);

        runtime.clearStagedChanges();
        runtime.stageSuppress(source.sourceId);
        await runtime.beginApplyReview();
        host.setStableId('chat-2');
        await runtime.commitStagedChanges();
        expect(runtime.state.error).toMatch(/聊天已切换/);
        expect(runtime.state.stagedChanges.size).toBe(1);
    });

    it('skips a no-op write when the plan produces the current metadata', async () => {
        const { runtime, host } = setup({ chatMetadata: { schemaVersion: 1, disabledWorldEntries: [await suppressedRecord('Lore', 1, '内容-1')] } });
        host.getMountedWorldInfoEntries.mockResolvedValue({
            globalLore: [worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: [],
        });
        await runtime.refresh();
        const source = runtime.snapshotSources()[0];
        const change = createStagedChange({
            sourceId: source.sourceId,
            worldDigest: source.worldDigest,
            uid: source.uid,
            contentDigest: source.rawContentDigest,
            action: 'suppress',
            dynamic: false,
        });
        runtime.mutable.stagedChanges = stageChange(new Map(), change);
        await runtime.beginApplyReview();
        await runtime.commitStagedChanges();
        expect(host.setPromptConflictChatMetadata).not.toHaveBeenCalled();
        expect(runtime.state.status).toContain('屏蔽 1 项');
    });

    it('restores an invalid record from chat metadata', async () => {
        const { runtime, host } = setup({
            chatMetadata: { schemaVersion: 1, disabledWorldEntries: [await suppressedRecord('Lore', 9, '已删除条目')] },
        });
        host.getMountedWorldInfoEntries.mockResolvedValue({ globalLore: [], characterLore: [], chatLore: [], personaLore: [] });
        await runtime.refresh();
        const record = runtime.metadataRecords[0];
        runtime.stageRestoreRecord(record);
        await runtime.beginApplyReview();
        await runtime.commitStagedChanges();
        expect(host.setPromptConflictChatMetadata).toHaveBeenCalledOnce();
        expect(host.setPromptConflictChatMetadata.mock.calls[0][1].disabledWorldEntries).toEqual([]);
    });
});

describe('prompt conflict runtime suppression and invalidation', () => {
    it('filters the world info payload for the current chat records', async () => {
        const { runtime, handlers } = setup({
            chatMetadata: { schemaVersion: 1, disabledWorldEntries: [await suppressedRecord('Lore', 1, '内容-1')] },
        });
        await runtime.activate();
        const lore = { globalLore: [worldEntry('Lore', 1), worldEntry('Lore', 2)], characterLore: [], chatLore: [], personaLore: [] };
        await handlers.worldInfo(lore);
        expect(lore.globalLore.map(entry => entry.uid)).toEqual([2]);
        await runtime.deactivate();
    });

    it('fails open when metadata is damaged and never filters', async () => {
        const { runtime, handlers } = setup({ chatMetadata: { schemaVersion: 9, disabledWorldEntries: [] } });
        await runtime.activate();
        const lore = { globalLore: [worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: [] };
        await handlers.worldInfo(lore);
        expect(lore.globalLore).toHaveLength(1);
        await runtime.deactivate();
    });

    it('skips malformed payloads before any filtering, logs safe diagnostics and recovers on the next valid event', async () => {
        const { runtime, handlers, host, log } = setup({ chatMetadata: { schemaVersion: 1, disabledWorldEntries: [await suppressedRecord('Lore', 1, '内容-1')] } });
        await runtime.activate();
        const lore = { globalLore: [worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: { secret: 'private-payload' } };
        const before = structuredClone(lore);
        const filter = vi.spyOn(runtime, 'onWorldInfoLoaded');
        runtime.mutable.phase = 'detecting';
        await handlers.worldInfo(lore);
        expect(filter).not.toHaveBeenCalled();
        expect(lore).toEqual(before);
        expect(runtime.state.phase).toBe('detecting');
        expect(runtime.state.error).toMatch(/本轮未应用聊天屏蔽/);
        expect(host.setPromptConflictChatMetadata).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledExactlyOnceWith('host.event_contract_failed', {
            data: expect.objectContaining({ operation: 'suppression.filter', code: 'HOST_EVENT_INVALID', field: 'personaLore', expected: 'array', actualType: 'object', outcome: 'round-skipped' }),
        });
        expect(log.error).not.toHaveBeenCalled();
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private-payload');
        lore.personaLore = [];
        await handlers.worldInfo(lore);
        expect(lore.globalLore).toEqual([]);
        expect(runtime.state.error).toBe('');
        expect(log.warn).toHaveBeenCalledOnce();
        await runtime.deactivate();
        expect(handlers.worldInfo).toBeNull();
    });

    it('chat change cancels the run, clears staging and marks the report stale', async () => {
        const { runtime, host, handlers, analysis } = setup({ presetSources: DEFAULT_PRESET });
        host.getMountedWorldInfoEntries.mockResolvedValue({ globalLore: [worldEntry('Lore', 1)], characterLore: [], chatLore: [], personaLore: [] });
        await runtime.activate();
        await runtime.refresh();
        await runtime.runDetection();
        expect(runtime.state.reportStale).toBe(false);
        const source = runtime.snapshotSources().find(item => item.sourceType === 'world-info');
        runtime.stageSuppress(source.sourceId);
        expect(runtime.state.stagedChanges.size).toBe(1);
        let resolveRun;
        analysis.run.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve; }));
        void runtime.runDetection();
        await vi.waitFor(() => expect(runtime.state.phase).toBe('detecting'));
        handlers.invalidation({ type: 'CHAT_CHANGED', args: [] });
        expect(runtime.state.stagedChanges.size).toBe(0);
        expect(runtime.state.reportStale).toBe(true);
        resolveRun({ directives: [], conflicts: [], batches: 1, calls: 2 });
        await vi.waitFor(() => expect(runtime.state.phase).toBe('idle'));
        expect(runtime.state.status).toContain('已取消');
        await runtime.deactivate();
    });

    it('ignores world updates for unmounted books and cancels on mounted ones during detection', async () => {
        const { runtime, handlers, analysis } = setup({ presetSources: DEFAULT_PRESET });
        await runtime.activate();
        handlers.invalidation({ type: 'WORLDINFO_UPDATED', args: ['Unrelated'] });
        expect(runtime.state.reportStale).toBe(false);
        handlers.invalidation({ type: 'WORLDINFO_UPDATED', args: ['Lore'] });
        expect(runtime.state.reportStale).toBe(true);
        await vi.waitFor(() => expect(runtime.state.phase).toBe('idle'));
        let resolveRun;
        analysis.run.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve; }));
        void runtime.runDetection();
        await vi.waitFor(() => expect(runtime.state.phase).toBe('detecting'));
        handlers.invalidation({ type: 'OAI_PRESET_CHANGED_AFTER', args: [] });
        expect(runtime.state.error).toMatch(/已取消/);
        resolveRun({ directives: [], conflicts: [], batches: 1, calls: 2 });
        await vi.waitFor(() => expect(runtime.state.phase).toBe('idle'));
        await runtime.deactivate();
    });
});

describe('prompt conflict preset selection', () => {
    it('loads the feature preset, falls back to the active preset and persists a selection', async () => {
        const { runtime, host } = setup();
        await runtime.activate();
        expect(runtime.state.selectedModelPresetId).toBeNull();
        expect(runtime.state.presetOptions).toHaveLength(2);
        await runtime.selectPreset('p2');
        expect(host.globalSet).toHaveBeenCalledWith('prompt-conflict-settings-v1', { schemaVersion: 1, presetId: 'p2' });
        expect(runtime.state.selectedModelPresetId).toBe('p2');
        await runtime.deactivate();
    });

    it('drops stale persisted presets and rejects unknown ids', async () => {
        const { runtime } = setup();
        runtime.host.globalGet.mockImplementationOnce(async key => key === 'prompt-conflict-settings-v1' ? { schemaVersion: 1, presetId: 'missing' } : undefined);
        await runtime.activate();
        expect(runtime.state.selectedModelPresetId).toBeNull();
        await expect(runtime.selectPreset('missing')).rejects.toMatchObject({ code: 'LLM_PRESET_MISSING' });
        await runtime.deactivate();
    });
});
