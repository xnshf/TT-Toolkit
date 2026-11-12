import { describe, expect, it, vi } from 'vitest';
import { PromptViewerRuntime } from '../src/features/prompt-viewer/runtime.js';
import { ToolkitError } from '../src/kernel/errors.js';

function logger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const info = {
    mainApi: 'openai',
    model: 'gpt-x',
    source: 'custom',
    tokenBudget: { maxContext: 8000, maxTokens: 500 },
    isGroup: false,
    characterName: 'Alice',
    promptManagerReady: true,
};

function snapshotData(content = 'rules') {
    return {
        messages: [{ identifier: 'main', role: 'system', content, tokens: 5, promptName: 'Main Prompt' }],
        removedAgentItemCount: 0,
        squashSystemMessages: false,
    };
}

function setup(overrides = {}) {
    const handlers = {};
    const host = {
        globalGet: vi.fn(async () => undefined),
        globalSet: vi.fn(async () => undefined),
        promptViewerStatus: vi.fn(async () => ({ ...info })),
        readPromptViewerSnapshot: vi.fn(async () => snapshotData()),
        runPromptViewerDryRun: vi.fn(async () => undefined),
        subscribePromptViewerEvents: vi.fn(value => {
            Object.assign(handlers, value);
            return vi.fn();
        }),
        ...overrides,
    };
    const runtime = new PromptViewerRuntime(host, logger());
    return { host, handlers, runtime };
}

async function captureSent(handlers, type = 'normal') {
    handlers.onGenerationStart({ type, dryRun: false });
    handlers.onWorldInfoActivated([{ world: 'Book', uid: 1, comment: '常驻', position: 0, constant: true }]);
    await handlers.onPromptReady({ chat: [{ role: 'system', content: 'x' }], dryRun: false });
}

describe('prompt viewer runtime capture', () => {
    it('subscribes and loads live info on activation', async () => {
        const { host, runtime } = setup();
        await runtime.initialize();
        await runtime.activate();
        expect(host.subscribePromptViewerEvents).toHaveBeenCalledOnce();
        expect(runtime.state.active).toBe(true);
        expect(runtime.state.info.model).toBe('gpt-x');
    });

    it('captures the last sent round with world entries and token totals', async () => {
        const { handlers, runtime } = setup();
        await runtime.activate();
        await captureSent(handlers);
        const snapshot = runtime.state.snapshot;
        expect(snapshot).toMatchObject({ kind: 'sent', generationType: 'normal', tokenTotal: 5, removedAgentItemCount: 0 });
        expect(snapshot.items[0]).toMatchObject({ identifier: 'main', source: 'preset', label: 'Main Prompt' });
        expect(snapshot.worldEntries).toHaveLength(1);
        expect(snapshot.worldEntries[0]).toMatchObject({ world: 'Book', comment: '常驻', trigger: 'constant' });
    });

    it('ignores unsupported generation types and dry-run-only prompt events', async () => {
        const { handlers, runtime } = setup();
        await runtime.activate();
        handlers.onGenerationStart({ type: 'quiet', dryRun: false });
        await handlers.onPromptReady({ chat: [], dryRun: false });
        expect(runtime.state.snapshot).toBeNull();
        handlers.onGenerationStart({ type: 'normal', dryRun: true });
        await handlers.onPromptReady({ chat: [], dryRun: true });
        expect(runtime.state.snapshot).toBeNull();
    });

    it('flags a pending update when a new round replaces an existing snapshot', async () => {
        const { host, handlers, runtime } = setup();
        await runtime.activate();
        await captureSent(handlers);
        expect(runtime.state.pendingUpdate).toBe(false);
        host.readPromptViewerSnapshot.mockResolvedValue(snapshotData('second'));
        await captureSent(handlers, 'continue');
        expect(runtime.state.pendingUpdate).toBe(true);
        expect(runtime.state.snapshot.generationType).toBe('continue');
        runtime.acknowledgeUpdate();
        expect(runtime.state.pendingUpdate).toBe(false);
    });

    it('clears in-memory snapshots when the chat changes', async () => {
        const { handlers, runtime } = setup();
        await runtime.activate();
        await captureSent(handlers);
        handlers.onChatChanged();
        expect(runtime.state.snapshot).toBeNull();
        expect(runtime.state.prediction).toBeNull();
    });

    it('clears generation state when generation ends', async () => {
        const { host, handlers, runtime } = setup();
        await runtime.activate();
        handlers.onGenerationStart({ type: 'normal', dryRun: false });
        handlers.onGenerationEnded();
        await handlers.onPromptReady({ chat: [], dryRun: false });
        expect(runtime.state.snapshot).toBeNull();
        expect(host.readPromptViewerSnapshot).not.toHaveBeenCalled();
    });
});

describe('prompt viewer runtime prediction', () => {
    it('runs the host dry run, captures the prediction and clears busy state', async () => {
        const dryRun = vi.fn(async () => {
            await handlers.onWorldInfoScan({ isFinal: true, isDryRun: true, entries: [{ world: 'Book', uid: 9, comment: 'k', position: 4, depth: 2 }] });
            await handlers.onPromptReady({ chat: [], dryRun: true });
        });
        const setupResult = setup({ runPromptViewerDryRun: dryRun });
        const { handlers, runtime } = setupResult;
        await runtime.activate();
        const snapshot = await runtime.predict('hello');
        expect(dryRun).toHaveBeenCalledWith('hello');
        expect(snapshot).toMatchObject({ kind: 'prediction', generationType: 'normal' });
        expect(snapshot.worldEntries[0]).toMatchObject({ world: 'Book', position: 'depth', depth: 2 });
        expect(runtime.state.prediction).toBe(snapshot);
        expect(runtime.state.busy).toBe(false);
    });

    it('rejects prediction on non-chat-completion interfaces and while generating', async () => {
        const { handlers, runtime, host } = setup();
        await runtime.activate();
        handlers.onGenerationStart({ type: 'normal', dryRun: false });
        await expect(runtime.predict('x')).rejects.toMatchObject({ code: 'PROMPT_VIEWER_BUSY' });
        handlers.onGenerationEnded();
        host.promptViewerStatus.mockResolvedValue({ ...info, mainApi: 'textgenerationwebui' });
        await runtime.refreshInfo();
        await expect(runtime.predict('x')).rejects.toMatchObject({ code: 'PROMPT_VIEWER_UNSUPPORTED_API' });
    });

    it('surfaces a prediction failure and keeps the runtime usable', async () => {
        const { runtime } = setup({ runPromptViewerDryRun: vi.fn(async () => { throw new Error('dry run failed'); }) });
        await runtime.activate();
        await expect(runtime.predict('x')).rejects.toThrow('dry run failed');
        expect(runtime.state.error).toContain('dry run failed');
        expect(runtime.state.busy).toBe(false);
    });

    it('fails when the dry run produces no assembled result', async () => {
        const { runtime } = setup({ runPromptViewerDryRun: vi.fn(async () => undefined) });
        await runtime.activate();
        await expect(runtime.predict('x')).rejects.toMatchObject({ code: 'PROMPT_VIEWER_PREDICTION_FAILED' });
    });
});

describe('prompt viewer runtime settings and export', () => {
    it('persists display settings and exports the current snapshot', async () => {
        const { host, handlers, runtime } = setup();
        await runtime.initialize();
        await runtime.activate();
        await runtime.updateSettings({ defaultCollapsed: false });
        expect(host.globalSet).toHaveBeenCalledWith('prompt-viewer-settings-v1', { schemaVersion: 1, defaultCollapsed: false });
        await captureSent(handlers);
        expect(runtime.exportText('sent')).toBe('[system]\nrules');
        expect(() => runtime.exportText('prediction')).toThrow(/尚未完成预测/);
    });

    it('logs download outcomes and normal cancellation without confusing them with copying', () => {
        const { runtime } = setup();
        runtime.logExport('sent', 'download', 3, 'started');
        runtime.logExport('prediction', 'download', 2, 'cancelled');
        runtime.logExport('sent', 'copy', 3);
        expect(runtime.log.info).toHaveBeenCalledWith('export.cancelled', { data: expect.objectContaining({ kind: 'prediction', outcome: 'cancelled' }) });
        expect(runtime.log.info).toHaveBeenCalledWith('exported', { data: expect.objectContaining({ source: 'download', outcome: 'started' }) });
        expect(runtime.log.info).toHaveBeenCalledWith('exported', { data: expect.objectContaining({ source: 'copy', outcome: 'copied' }) });
    });

    it('logs recoverable file export failures without private details', () => {
        const { runtime } = setup();
        runtime.fileFailed(new ToolkitError('FILE_EXPORT_FAILED', 'private body or path'));
        expect(runtime.log.warn).toHaveBeenCalledWith('export.file_failed', { data: expect.objectContaining({ reason: 'host-export-rejected', sourceLocation: 'prompt-viewer/runtime.js' }) });
        expect(JSON.stringify(runtime.log.warn.mock.calls)).not.toContain('private body or path');
        expect(runtime.log.error).not.toHaveBeenCalled();
    });

    it('releases subscriptions on deactivate', async () => {
        const dispose = vi.fn();
        const { runtime } = setup({ subscribePromptViewerEvents: vi.fn(() => dispose) });
        await runtime.activate();
        await runtime.deactivate();
        expect(dispose).toHaveBeenCalledOnce();
        expect(runtime.state.active).toBe(false);
        expect(runtime.state.snapshot).toBeNull();
    });
});
