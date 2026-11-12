import { describe, expect, it, vi } from 'vitest';
import { buildPromptItemView, projectWorldEntries } from '../src/features/prompt-viewer/model.js';
import { mountPromptViewerPage } from '../src/features/prompt-viewer/PromptViewerPage.js';

function buildSnapshot(kind) {
    const items = buildPromptItemView([
        { identifier: 'main', role: 'system', content: 'System rules Alpha', tokens: 5, promptName: 'Main Prompt' },
        { identifier: 'worldInfoBefore', role: 'system', content: 'World lore', tokens: 3 },
        { identifier: 'chatHistory-1', role: 'user', content: 'User question', tokens: 2 },
    ]);
    const worldEntries = projectWorldEntries([{ world: 'Book', uid: 7, comment: '常驻条目', position: 0, constant: true }]);
    items[1].worldEntryRefs = [0];
    return {
        schemaVersion: 1,
        kind,
        capturedAtMs: kind === 'sent' ? 1 : 2,
        generationType: 'normal',
        groupMemberLabel: null,
        assemblyRoundCount: 1,
        removedAgentItemCount: 0,
        model: { name: 'gpt-x', source: 'custom' },
        tokenBudget: { maxContext: 8000, maxTokens: 500 },
        squashSystemMessages: false,
        items,
        worldEntries,
        messages: [],
        tokenTotal: 10,
    };
}

function runtime(overrides = {}) {
    const state = {
        active: true,
        busy: false,
        info: {
            mainApi: 'openai',
            model: 'gpt-x',
            source: 'custom',
            tokenBudget: { maxContext: 8000, maxTokens: 500 },
            isGroup: false,
            characterName: 'Alice',
            promptManagerReady: true,
        },
        snapshot: buildSnapshot('sent'),
        prediction: null,
        pendingUpdate: false,
        settings: { schemaVersion: 1, defaultCollapsed: true },
        status: '已捕获最近一轮（3 条条目）。',
        error: '',
    };
    const listeners = new Set();
    return {
        state,
        subscribe: vi.fn(listener => { listeners.add(listener); return () => listeners.delete(listener); }),
        refreshInfo: vi.fn(async () => undefined),
        predict: vi.fn(async () => { state.prediction = buildSnapshot('prediction'); return state.prediction; }),
        acknowledgeUpdate: vi.fn(() => { state.pendingUpdate = false; }),
        exportText: vi.fn(kind => `[system]\nexport-${kind}`),
        exportSamples: vi.fn(() => '{"messages":[]}'),
        clearSamples: vi.fn(),
        logExport: vi.fn(),
        fileFailed: vi.fn(),
        updateSettings: vi.fn(async () => undefined),
        notify() { for (const listener of listeners) listener(state); },
        ...overrides,
    };
}

function mount(viewRuntime, exportFile = vi.fn(async () => ({ status: 'started', mode: 'browser', message: '已发起下载，请查看系统默认下载位置。' }))) {
    const target = document.createElement('div');
    const dispose = mountPromptViewerPage(target, {
        enabled: true,
        runtime: viewRuntime,
        exportFile,
        setEnabled: vi.fn(async () => undefined),
        closeWorkbench: vi.fn(),
    });
    return { target, dispose, exportFile };
}

describe('prompt viewer page rendering', () => {
    it('renders the model bar, tabs, items and world entries collapsed by default', () => {
        const { target, dispose } = mount(runtime());
        expect(target.querySelector('h2')?.textContent).toBe('提示词查看');
        expect(target.textContent).toContain('模型：gpt-x');
        expect(target.querySelectorAll('[data-source]')).toHaveLength(3);
        expect([...target.querySelectorAll('button')].filter(button => button.textContent === '展开')).toHaveLength(3);
        expect(target.querySelector('.prompt-world-panel summary')?.textContent).toContain('本次激活的世界书条目（1）');
        dispose();
    });

    it('expands and collapses every item on demand', () => {
        const { target, dispose } = mount(runtime());
        const click = label => [...target.querySelectorAll('button')].find(button => button.textContent === label)?.click();
        const firstItem = () => target.querySelector('[data-source]');
        click('全部展开');
        expect(firstItem()?.textContent).toContain('System rules Alpha');
        click('全部折叠');
        expect(firstItem()?.textContent).not.toContain('System rules Alpha');
        dispose();
    });

    it('persists the default-expand preference', async () => {
        const viewRuntime = runtime();
        const { target, dispose } = mount(viewRuntime);
        const checkbox = target.querySelector('.prompt-default-expand input');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(viewRuntime.updateSettings).toHaveBeenCalledWith({ defaultCollapsed: false }));
        dispose();
    });

    it('filters by source and highlights search matches', () => {
        const { target, dispose } = mount(runtime());
        const select = target.querySelector('.prompt-source-filter');
        select.value = 'chat-history';
        select.dispatchEvent(new Event('change'));
        expect(target.querySelectorAll('.prompt-item')).toHaveLength(1);

        select.value = 'all';
        select.dispatchEvent(new Event('change'));
        const search = target.querySelector('.prompt-search-input');
        search.value = 'alpha';
        search.dispatchEvent(new Event('input'));
        // Typing must not replace the control: a detached input loses focus and cancels IME composition.
        expect(target.querySelector('.prompt-search-input')).toBe(search);
        expect(target.querySelectorAll('.prompt-item')).toHaveLength(1);
        [...target.querySelectorAll('.prompt-toolbar button')].find(button => button.textContent === '全部展开')?.click();
        expect(target.querySelector('mark')?.textContent).toBe('Alpha');
        dispose();
    });

    it('shows the pending update banner and acknowledges it', () => {
        const viewRuntime = runtime();
        viewRuntime.state.pendingUpdate = true;
        const { target, dispose } = mount(viewRuntime);
        const button = [...target.querySelectorAll('.prompt-update-banner button')].find(item => item.textContent === '查看新的一轮');
        expect(button).toBeDefined();
        button.click();
        expect(viewRuntime.acknowledgeUpdate).toHaveBeenCalledOnce();
        dispose();
    });

    it('copies the actual sent messages from the current tab', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const viewRuntime = runtime();
        const { target, dispose } = mount(viewRuntime);
        [...target.querySelectorAll('.prompt-toolbar button')].find(button => button.textContent === '复制提示词')?.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('[system]\nexport-sent'));
        expect(viewRuntime.logExport).toHaveBeenCalledWith('sent', 'copy', 3);
        dispose();
    });
});

describe('prompt viewer host downloads', () => {
    const clickDownload = target => [...target.querySelectorAll('.prompt-toolbar button')].find(button => button.textContent === '下载 .txt').click();

    it('uses the shared host export with the actual current prompt document', async () => {
        const viewRuntime = runtime();
        const { target, dispose, exportFile } = mount(viewRuntime);
        clickDownload(target);
        await vi.waitFor(() => expect(exportFile).toHaveBeenCalledWith('[system]\nexport-sent', expect.stringMatching(/^prompt-sent-.*\.txt$/), 'text/plain;charset=utf-8'));
        await vi.waitFor(() => expect(target.textContent).toContain('已发起下载'));
        expect(viewRuntime.logExport).toHaveBeenCalledWith('sent', 'download', 3, 'started');
        dispose();
    });

    it('records host failures instead of claiming a successful download', async () => {
        const viewRuntime = runtime();
        const error = new Error('宿主导出中止');
        const { target, dispose } = mount(viewRuntime, vi.fn(async () => { throw error; }));
        clickDownload(target);
        await vi.waitFor(() => expect(target.textContent).toContain('宿主导出中止'));
        expect(viewRuntime.fileFailed).toHaveBeenCalledWith(error);
        expect(viewRuntime.logExport).not.toHaveBeenCalled();
        dispose();
    });

    it('keeps the original tab identity while a native export is pending', async () => {
        let finish;
        const viewRuntime = runtime();
        const exporter = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const { target, dispose } = mount(viewRuntime, exporter);
        clickDownload(target);
        await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());
        expect([...target.querySelectorAll('.prompt-toolbar button')].find(button => button.textContent === '下载 .txt').disabled).toBe(true);
        [...target.querySelectorAll('.feature-tabs button')].find(button => button.textContent === '预测').click();
        finish({ status: 'saved', mode: 'mobile-native', message: '导出成功。' });
        await vi.waitFor(() => expect(viewRuntime.logExport).toHaveBeenCalledWith('sent', 'download', 3, 'saved'));
        dispose();
    });
});

describe('prompt viewer page prediction', () => {
    it('submits the hypothetical input to the runtime', async () => {
        const viewRuntime = runtime();
        const { target, dispose } = mount(viewRuntime);
        [...target.querySelectorAll('.feature-tabs button')].find(button => button.textContent === '预测')?.click();
        const textarea = target.querySelector('.prompt-prediction-input');
        textarea.value = 'hello world';
        textarea.dispatchEvent(new Event('input'));
        [...target.querySelectorAll('.prompt-prediction-actions button')].find(button => button.textContent === '预测')?.click();
        await vi.waitFor(() => expect(viewRuntime.predict).toHaveBeenCalledWith('hello world'));
        await vi.waitFor(() => expect(target.querySelectorAll('.prompt-item')).toHaveLength(3));
        dispose();
    });

    it('shows an explicit banner when the interface is not chat completion', () => {
        const viewRuntime = runtime();
        viewRuntime.state.info = { ...viewRuntime.state.info, mainApi: 'textgenerationwebui' };
        const { target, dispose } = mount(viewRuntime);
        expect(target.textContent).toContain('当前不是聊天补全（Chat Completion）接口');
        dispose();
    });

    it('renders the disabled state before enabling the feature', () => {
        const target = document.createElement('div');
        const viewRuntime = runtime();
        const dispose = mountPromptViewerPage(target, {
            enabled: false,
            runtime: viewRuntime,
            setEnabled: vi.fn(async () => undefined),
        });
        expect(target.textContent).toContain('功能尚未启用');
        expect(target.querySelector('.prompt-toolbar')).toBeNull();
        dispose();
    });
});
