import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChatExportPlan } from '../src/features/chat-exporter/model.js';
import { mountChatExporterPage } from '../src/features/chat-exporter/ChatExporterPage.js';
import { createDefaultExportSettings } from '../src/features/chat-exporter/schema.js';

const identity = { stableId: 'chat-1', ref: { kind: 'character' } };
const messages = [
    { is_user: true, is_system: false, name: 'User', mes: 'question' },
    { is_user: false, is_system: false, name: 'AI', mes: 'answer' },
];

function button(target, text) {
    return [...target.querySelectorAll('button')].find(item => item.textContent === text);
}

function pageRuntime(settings = createDefaultExportSettings(), snapshotMessages = messages) {
    const snapshot = { identity, messages: snapshotMessages };
    const plan = buildChatExportPlan(snapshot, settings, { start: 1, end: snapshotMessages.length });
    const model = { identity: plan.identity, items: plan.entries, stats: plan.projectionStats };
    const state = { active: true, busy: false, stale: false, settings, model, currentPlan: null, status: '已读取', error: '' };
    return {
        state,
        subscribe: vi.fn(() => vi.fn()),
        refresh: vi.fn(async () => model),
        saveSettings: vi.fn(async value => { state.settings = value; state.currentPlan = null; }),
        preview: vi.fn(async () => { state.currentPlan = plan; return plan; }),
        prepareDownload: vi.fn(async (_title, confirmed) => {
            if (plan.requiresConfirmation && !confirmed)
                throw new Error('confirmation required');
            return { content: '# Doc\n', filename: 'Doc-20260824-120000.md', format: 'markdown', stats: plan.stats };
        }),
        downloaded: vi.fn(), fileFailed: vi.fn(),
        copyCleanerRules: vi.fn(async () => settings),
    };
}

function mount(runtime, exportFile = vi.fn(async () => ({ status: 'started', mode: 'browser', message: '已发起下载，请查看系统默认下载位置。' }))) {
    const target = document.createElement('div');
    document.body.append(target);
    const dispose = mountChatExporterPage(target, { enabled: true, runtime, exportFile, setEnabled: vi.fn() });
    return { target, exportFile, dispose };
}

async function preview(target) {
    button(target, '生成导出预览')?.click();
    await vi.waitFor(() => expect(button(target, '保存文档')).toBeDefined());
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('chat exporter page', () => {
    it('requires a preview, validates the payload, then calls the shared host export', async () => {
        const runtime = pageRuntime();
        const { target, exportFile, dispose } = mount(runtime);
        await vi.waitFor(() => expect(target.textContent).toContain('必须先生成预览'));
        expect(button(target, '保存文档')).toBeUndefined();
        await preview(target);
        const save = button(target, '保存文档');
        const firstPreview = target.querySelector('article');
        expect(save.compareDocumentPosition(firstPreview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        button(target, '保存文档').click();
        await vi.waitFor(() => expect(exportFile).toHaveBeenCalledOnce());
        expect(exportFile).toHaveBeenCalledWith('# Doc\n', 'Doc-20260824-120000.md', 'text/markdown;charset=utf-8');
        expect(runtime.prepareDownload).toHaveBeenCalledWith('聊天记录', false, runtime.state.currentPlan);
        await vi.waitFor(() => expect(runtime.downloaded).toHaveBeenCalledOnce());
        expect(target.textContent).toContain('已发起下载');
        expect(target.textContent).not.toContain('文档已保存');
        dispose();
    });

    it('shows a manual confirmation before saving a preview that skips messages', async () => {
        const settings = createDefaultExportSettings();
        settings.assistant.strategy = 'include';
        settings.assistant.includeRules = [{ id: 'story', enabled: true, start: '<story>', end: '</story>' }];
        const runtime = pageRuntime(settings, [messages[0], { ...messages[1], mes: 'missing' }]);
        const { target, exportFile, dispose } = mount(runtime);
        await preview(target);
        button(target, '保存文档').click();
        expect(runtime.prepareDownload).not.toHaveBeenCalled();
        expect(exportFile).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(document.body.textContent).toContain('确认跳过有风险的消息'));
        button(document.body, '确认并保存').click();
        await vi.waitFor(() => expect(runtime.prepareDownload).toHaveBeenCalledWith('聊天记录', true, runtime.state.currentPlan));
        await vi.waitFor(() => expect(exportFile).toHaveBeenCalledOnce());
        dispose();
    });

    it('discloses unreadable floors, lets users cancel, then allows a confirmed incomplete export', async () => {
        const runtime = pageRuntime(createDefaultExportSettings(), [messages[0], null]);
        const { target, exportFile, dispose } = mount(runtime);
        await preview(target);
        expect(target.textContent).toContain('正文不可读跳过');
        const skipped = [...target.querySelectorAll('article')].find(node => node.textContent.includes('原始索引 1'));
        expect(skipped).toBeTruthy();
        expect(skipped.textContent).toContain('原始索引 1');
        button(target, '保存文档').click();
        await vi.waitFor(() => expect(document.body.textContent).toContain('其中 1 条正文不可读'));
        expect(document.body.textContent).toContain('先自行通过宿主备份');
        button(document.body, '取消').click();
        expect(runtime.prepareDownload).not.toHaveBeenCalled();
        expect(exportFile).not.toHaveBeenCalled();
        button(target, '保存文档').click();
        await vi.waitFor(() => expect(button(document.body, '确认并保存')).toBeDefined());
        button(document.body, '确认并保存').click();
        await vi.waitFor(() => expect(runtime.prepareDownload).toHaveBeenCalledWith('聊天记录', true, runtime.state.currentPlan));
        dispose();
    });

    it('does not export if revalidation rejects the prepared payload', async () => {
        const runtime = pageRuntime();
        const error = new Error('聊天已变化');
        runtime.prepareDownload.mockRejectedValue(error);
        const { target, exportFile, dispose } = mount(runtime);
        await preview(target);
        button(target, '保存文档').click();
        await vi.waitFor(() => expect(target.textContent).toContain('聊天已变化'));
        expect(exportFile).not.toHaveBeenCalled();
        expect(runtime.fileFailed).toHaveBeenCalledWith(error);
        dispose();
    });

    it('displays explicit host cancellation without claiming a saved document', async () => {
        const runtime = pageRuntime();
        const result = { status: 'cancelled', mode: 'ios-native-share', message: '已取消导出。' };
        const { target, dispose } = mount(runtime, vi.fn(async () => result));
        await preview(target);
        button(target, '保存文档').click();
        await vi.waitFor(() => expect(target.textContent).toContain('已取消导出'));
        expect(runtime.downloaded).toHaveBeenCalledWith(expect.objectContaining({ content: '# Doc\n' }), result);
        expect(runtime.fileFailed).not.toHaveBeenCalled();
        dispose();
    });

    it('waits for native saving and prevents repeated clicks while pending', async () => {
        const runtime = pageRuntime();
        let finish;
        const exporter = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const { target, dispose } = mount(runtime, exporter);
        await preview(target);
        button(target, '保存文档').click();
        await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());
        expect(button(target, '保存文档').disabled).toBe(true);
        expect(runtime.downloaded).not.toHaveBeenCalled();
        finish({ status: 'saved', mode: 'mobile-native', message: '导出成功。' });
        await vi.waitFor(() => expect(target.textContent).toContain('导出成功'));
        dispose();
    });
});
