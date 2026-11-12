import { describe, expect, it, vi } from 'vitest';
import { ChatExporterRuntime } from '../src/features/chat-exporter/runtime.js';
import { ToolkitError } from '../src/kernel/errors.js';
import { createDefaultExportSettings } from '../src/features/chat-exporter/schema.js';

const identity = stableId => ({ stableId, ref: { kind: 'character' } });
const user = mes => ({ is_user: true, is_system: false, name: 'User', mes });
const assistant = mes => ({ is_user: false, is_system: false, name: 'AI', mes });
const rule = (id, start, end) => ({ id, enabled: true, start, end });

function logger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function hostWith(messages, settings = createDefaultExportSettings()) {
    let current = structuredClone(messages);
    let stableId = 'chat-1';
    let ref = { kind: 'character', characterId: 'example-character', fileName: 'example-chat' };
    let mutationHandler = null;
    const cleaner = {
        schemaVersion: 1,
        deleteNativeReasoning: true,
        assistant: { enabled: true, rules: [rule('clean-a', '<a>', '</a>')] },
        user: { enabled: true, rules: [rule('clean-u', '<u>', '</u>')] },
        auto: { enabled: false, keepAssistant: 5, keepUser: 5 },
    };
    const host = {
        globalGet: vi.fn(async key => key === 'chat-cleaner-settings-v1' ? cleaner : settings),
        globalSet: vi.fn(async () => undefined),
        snapshot: vi.fn(async () => ({ identity: { ...identity(stableId), ref: structuredClone(ref) }, messages: structuredClone(current) })),
        onChatMutated: vi.fn(handler => { mutationHandler = handler; return vi.fn(); }),
        chatAlias: vi.fn(() => 'alias'),
        setMessages(value) { current = structuredClone(value); },
        setStableId(value) { stableId = value; },
        setRef(value) { ref = value; },
        mutate(type = 'message_updated') { mutationHandler?.({ type }); },
    };
    return host;
}

describe('chat exporter runtime', () => {
    it('invalidates a preview on chat events and releases snapshots when disabled', async () => {
        const host = hostWith([user('one'), assistant('two')]);
        const runtime = new ChatExporterRuntime(host, logger());
        await runtime.initialize();
        await runtime.activate();
        await runtime.preview(1, 2);
        host.mutate();
        expect(runtime.state.stale).toBe(true);
        await expect(runtime.prepareDownload('Title')).rejects.toThrow(/重新生成预览/);
        const dispose = host.onChatMutated.mock.results[0].value;
        await runtime.deactivate();
        expect(dispose).toHaveBeenCalledOnce();
        expect(runtime.state.model).toBeNull();
        expect(runtime.state.currentPlan).toBeNull();
    });

    it('requires confirmation for skipped positive-selection messages and exports the previewed result', async () => {
        const settings = createDefaultExportSettings();
        settings.assistant.strategy = 'include';
        settings.assistant.includeRules = [rule('story', '<story>', '</story>')];
        const runtime = new ChatExporterRuntime(hostWith([user('question'), assistant('missing'), assistant('<story>answer</story>')], settings), logger());
        await runtime.initialize();
        const plan = await runtime.preview(1, 3);
        expect(plan.stats.skippedMessages).toBe(1);
        await expect(runtime.prepareDownload('Doc')).rejects.toThrow(/手动确认/);
        const payload = await runtime.prepareDownload('Doc', true);
        expect(payload.content).toContain('question');
        expect(payload.content).toContain('answer');
        expect(payload.content).not.toContain('missing');
    });

    it('rejects an edited or switched chat even when no mutation event was observed', async () => {
        const host = hostWith([user('one')]);
        const runtime = new ChatExporterRuntime(host, logger());
        await runtime.initialize();
        await runtime.preview(1, 1);
        host.setMessages([user('edited')]);
        await expect(runtime.prepareDownload('Doc')).rejects.toThrow(/已变化/);

        host.setMessages([user('one')]);
        await runtime.preview(1, 1);
        host.setStableId('chat-2');
        await expect(runtime.prepareDownload('Doc')).rejects.toThrow(/已切换/);
    });

    it('logs exact safe issue locations and permits confirmed omissions without mutating chat', async () => {
        const host = hostWith([user('healthy-secret'), null, { is_user: false, mes: { secret: 'bad-body-secret' } }]);
        const log = logger();
        const runtime = new ChatExporterRuntime(host, log);
        const plan = await runtime.preview(1, 3);
        await expect(runtime.prepareDownload('Doc')).rejects.toMatchObject({ code: 'EXPORT_CONFIRM_REQUIRED' });
        const payload = await runtime.prepareDownload('Doc', true, plan);
        expect(payload.stats.unreadableSkippedMessages).toBe(2);
        expect(payload.content).toContain('healthy-secret');
        expect(host.globalSet).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
        expect(log.warn.mock.calls.find(([event]) => event === 'message.degraded')[1].data).toMatchObject({
            code: 'MESSAGE_NOT_OBJECT', field: 'message', actualType: 'null', absoluteIndex: 1, conversationIndex: 2,
            sourceLocation: 'kernel/chat-projection.js:projectConversationSnapshot', outcome: 'unreadable-placeholder',
        });
        expect(log.warn.mock.calls.find(([event]) => event === 'operation.failed')[1].data).toMatchObject({
            operation: 'export.prepare', reason: 'risk-confirmation-required', nextAction: 'review-and-confirm', skippedMessages: 2,
        });
        expect(JSON.stringify(log.warn.mock.calls.map(([, payload]) => payload.data))).not.toMatch(/healthy-secret|bad-body-secret/);
        expect(log.info.mock.calls.some(([event]) => event === 'export.risk_confirmed')).toBe(true);
    });

    it('allows anomalous swipe metadata without confirmation, including object pointers', async () => {
        const log = logger();
        const runtime = new ChatExporterRuntime(hostWith([{ ...assistant('current'), swipes: ['other'], swipe_id: { secret: 'not-logged' } }]), log);
        await runtime.preview(1, 1);
        expect((await runtime.prepareDownload('Doc')).content).toContain('current');
        expect(log.error).not.toHaveBeenCalled();
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('not-logged');
    });

    it('keeps a healthy subrange available despite corruption elsewhere', async () => {
        const runtime = new ChatExporterRuntime(hostWith([null, user('healthy')]), logger());
        await runtime.preview(2, 2);
        expect((await runtime.prepareDownload('Doc')).content).toContain('healthy');
    });

    it('logs malformed floors before an empty result blocks output and clears an earlier plan', async () => {
        const host = hostWith([user('healthy')]);
        const log = logger();
        const runtime = new ChatExporterRuntime(host, log);
        await runtime.preview(1, 1);
        host.setMessages([null]);
        await expect(runtime.preview(1, 1)).rejects.toMatchObject({ code: 'EXPORT_RESULT_EMPTY' });
        expect(runtime.state.currentPlan).toBeNull();
        expect(log.warn.mock.calls.some(([event, payload]) => event === 'message.degraded' && payload.data.absoluteIndex === 0)).toBe(true);
        expect(log.warn.mock.calls.find(([event]) => event === 'operation.failed')[1].data).toMatchObject({ reason: 'all-output-skipped', skippedMessages: 1 });
        expect(log.error).not.toHaveBeenCalled();
    });

    it('binds risk confirmation to its exact plan and refuses a repaired or changed source', async () => {
        const host = hostWith([user('healthy'), null]);
        const runtime = new ChatExporterRuntime(host, logger());
        const original = await runtime.preview(1, 2);
        await runtime.preview(1, 2);
        await expect(runtime.prepareDownload('Doc', true, original)).rejects.toMatchObject({ code: 'STALE_PLAN' });
        host.setMessages([user('healthy'), user('repaired')]);
        await expect(runtime.prepareDownload('Doc', true)).rejects.toMatchObject({ code: 'MESSAGE_CHANGED' });
    });

    it('refuses a different character branch even if its stable ID and content are identical', async () => {
        const host = hostWith([user('healthy')]);
        const runtime = new ChatExporterRuntime(host, logger());
        await runtime.preview(1, 1);
        host.setRef({ kind: 'character', characterId: 'example-character', fileName: 'other-branch' });
        await expect(runtime.prepareDownload('Doc', true)).rejects.toMatchObject({ code: 'CHAT_CHANGED' });
    });

    it('rechecks staleness after async snapshot reads', async () => {
        const host = hostWith([user('healthy')]);
        const runtime = new ChatExporterRuntime(host, logger());
        await runtime.activate();
        await runtime.preview(1, 1);
        const read = host.snapshot.getMockImplementation();
        host.snapshot.mockImplementation(async () => {
            const snapshot = await read();
            host.mutate();
            return snapshot;
        });
        await expect(runtime.prepareDownload('Doc')).rejects.toMatchObject({ code: 'STALE_PLAN' });
    });

    it('logs schema paths and types rather than rule text or unknown fields', async () => {
        const host = hostWith([user('healthy')]);
        const log = logger();
        const runtime = new ChatExporterRuntime(host, log);
        const settings = createDefaultExportSettings();
        settings.assistant.includeRules = [{ id: 'private-id', enabled: true, start: 'private-rule', end: 9 }];
        await expect(runtime.saveSettings(settings)).rejects.toThrow(/字段类型/);
        expect(log.warn.mock.calls[0][1].data).toMatchObject({
            field: 'settings.assistant.includeRules[0].end', ruleIndex: 0, expected: 'string', actualType: 'number', sourceLocation: 'chat-exporter/schema.js',
        });
        expect(JSON.stringify(log.warn.mock.calls.map(([, payload]) => payload.data))).not.toMatch(/private-id|private-rule/);
        expect(host.globalSet).not.toHaveBeenCalled();
    });

    it('logs recoverable native file failures once without duplicating a runBusy failure', async () => {
        const host = hostWith([user('healthy')]);
        const log = logger();
        const runtime = new ChatExporterRuntime(host, log);
        const error = new Error('unknown-private-detail');
        host.snapshot.mockRejectedValue(error);
        await expect(runtime.refresh()).rejects.toBe(error);
        runtime.fileFailed(error);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn.mock.calls[0][1].data).toMatchObject({ operation: 'chat.snapshot', sourceLocation: 'chat-exporter/runtime.js', reason: 'unexpected-readonly-failure' });
        expect(JSON.stringify(log.warn.mock.calls[0][1].data)).not.toContain('unknown-private-detail');
        expect(log.error).not.toHaveBeenCalled();
    });

    it('distinguishes started, saved and cancelled exports without logging document content', () => {
        for (const [status, event] of [['started', 'document.download_started'], ['saved', 'document.saved'], ['cancelled', 'document.export_cancelled']]) {
            const log = logger();
            const runtime = new ChatExporterRuntime(hostWith([]), log);
            runtime.downloaded({ content: 'private body', filename: 'private title.md', format: 'markdown', stats: { exportedMessages: 1 } }, { status, mode: 'browser', message: 'fixed feedback' });
            expect(log.info).toHaveBeenCalledWith(event, { data: expect.objectContaining({ outcome: status }) });
            expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/private body|private title/);
        }
    });

    it('logs host export failures once at warn with the independent reason code', () => {
        const log = logger();
        const runtime = new ChatExporterRuntime(hostWith([]), log);
        const error = new ToolkitError('FILE_EXPORT_ABORTED', 'private detail');
        runtime.fileFailed(error);
        runtime.fileFailed(error);
        expect(log.warn).toHaveBeenCalledOnce();
        expect(log.warn).toHaveBeenCalledWith('document.save_failed', { data: expect.objectContaining({ reason: 'host-export-aborted', sourceLocation: 'chat-exporter/runtime.js' }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private detail');
        expect(log.error).not.toHaveBeenCalled();
    });

    it('locates the first skipped floor when all rule output is empty', async () => {
        const settings = createDefaultExportSettings();
        settings.assistant.strategy = 'include';
        settings.assistant.includeRules = [rule('story', '<story>', '</story>')];
        const log = logger();
        const runtime = new ChatExporterRuntime(hostWith([assistant('missing')], settings), log);
        await runtime.initialize();
        await expect(runtime.preview(1, 1)).rejects.toMatchObject({ code: 'EXPORT_RESULT_EMPTY' });
        expect(log.warn.mock.calls[0][1].data).toMatchObject({
            operation: 'export.preview', stage: 'export.transform', skipReason: 'include-no-match', absoluteIndex: 0, conversationIndex: 1, skippedMessages: 1,
        });
    });

    it('copies cleaner rules into independent exclusion banks without changing strategies', async () => {
        const host = hostWith([user('one')]);
        const log = logger();
        const runtime = new ChatExporterRuntime(host, log);
        await runtime.initialize();
        const settings = await runtime.copyCleanerRules();
        expect(settings.assistant.strategy).toBe('none');
        expect(settings.assistant.excludeRules[0].id).toBe('clean-a');
        expect(settings.user.excludeRules[0].id).toBe('clean-u');
        const logged = log.info.mock.calls.find(([event]) => event === 'rules.copied_from_cleaner')[1];
        expect(JSON.stringify(logged)).not.toContain('<a>');
        expect(host.globalSet).toHaveBeenCalledWith('chat-exporter-settings-v1', settings);
    });
});
