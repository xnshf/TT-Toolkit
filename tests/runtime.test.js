import { describe, expect, it, vi } from 'vitest';
import { ChatCleanerRuntime } from '../src/features/chat-cleaner/runtime.js';
import { createDefaultSettings } from '../src/features/chat-cleaner/schema.js';
import { ToolkitError } from '../src/kernel/errors.js';

function assistant(mes, reasoning = '') {
    const extra = reasoning ? { reasoning, reasoning_duration: 4, reasoning_signature: 'keep' } : {};
    return {
        is_user: false,
        is_system: false,
        name: 'Char',
        mes,
        swipes: [mes],
        swipe_id: 0,
        extra,
        swipe_info: [{ extra: structuredClone(extra) }],
    };
}

function user(mes) {
    return { is_user: true, is_system: false, name: 'User', mes };
}

function fakeHost(initialMessages, initialProgress = null) {
    const chat = structuredClone(initialMessages);
    let progress = initialProgress;
    const host = {
        identity: vi.fn(async () => ({ stableId: 'chat-1', label: 'Test chat', ref: { kind: 'character' } })),
        chatAlias: () => 'chat-1',
        globalGet: vi.fn(async () => null),
        globalSet: vi.fn(async () => undefined),
        globalDelete: vi.fn(async () => undefined),
        chatExtensionGet: vi.fn(async () => progress),
        chatExtensionSet: vi.fn(async (_stableId, _namespace, value) => { progress = value; }),
        snapshot: vi.fn(async () => ({ identity: await host.identity(), messages: structuredClone(chat) })),
        onGenerationEnded: vi.fn(handler => {
            host.emitGenerationEnded = handler;
            return () => { host.emitGenerationEnded = null; };
        }),
        context: { get chat() { return chat; } },
        assertIdentity: vi.fn(async () => undefined),
        saveCurrentChat: vi.fn(async () => undefined),
        reloadCurrentChat: vi.fn(async () => undefined),
    };
    return host;
}

function mockLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function makeRuntime(messages, overrides = {}) {
    const settings = createDefaultSettings();
    settings.auto.enabled = true;
    settings.auto.keepAssistant = 1;
    settings.auto.keepUser = 1;
    Object.assign(settings, overrides.settings ?? {});
    const host = fakeHost(messages);
    host.globalGet = vi.fn(async () => settings);
    const log = mockLogger();
    const runtime = new ChatCleanerRuntime(host, log);
    await runtime.initialize();
    await runtime.activate();
    return { host, log, runtime };
}

describe('auto clean runtime', () => {
    it('runs when GENERATION_ENDED passes the host chat.length payload (off-by-one)', async () => {
        const messages = [user('u1'), assistant('a1', 'thought 1'), user('u2'), assistant('a2', 'thought 2')];
        const { host, log, runtime } = await makeRuntime(messages);
        expect(host.onGenerationEnded).toHaveBeenCalled();

        // 宿主在消息入列后才发出 chat.length（比新消息索引大 1）：负载 4，新消息索引 3。
        await host.emitGenerationEnded(4);
        await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith('auto.baseline_created', expect.anything()));

        // 修复前会静默跳过（不产生任何日志）；现在门卫通过并建立首轮基线。
        expect(log.debug).not.toHaveBeenCalledWith('auto.skipped', expect.anything());
        expect(runtime.mutable.progress.rulesFingerprint).not.toBe('');
    });

    it('commits an incremental clean for the next generation', async () => {
        const messages = [user('u1'), assistant('a1', 'thought 1'), user('u2'), assistant('a2', 'thought 2')];
        const { host, log, runtime } = await makeRuntime(messages);

        await host.emitGenerationEnded(4); // 基线
        await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith('auto.baseline_created', expect.anything()));
        host.context.chat.push(user('u3'), assistant('a3', 'thought 3'));
        await host.emitGenerationEnded(6); // 增量清洗：负载 6，新消息索引 5
        await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith('auto.committed', expect.anything()));

        expect(host.saveCurrentChat).toHaveBeenCalled();
        // 超出保留边界的旧楼层 reasoning 已被清空
        expect(host.context.chat[3].extra.reasoning).toBe('');
        expect(host.context.chat[3].swipe_info[0].extra.reasoning).toBe('');
        expect(runtime.mutable.progress.assistantThrough).toBe(3);
    });

    it('skips when the event payload resolves to a user message', async () => {
        const { host, log, runtime } = await makeRuntime([user('u1')]);

        await host.emitGenerationEnded(1); // chat.length=1 → 目标为用户消息
        await vi.waitFor(() => expect(log.debug).toHaveBeenCalledWith('auto.skipped', expect.anything()));

        expect(log.info).not.toHaveBeenCalledWith('auto.baseline_created', expect.anything());
        expect(log.info).not.toHaveBeenCalledWith('auto.committed', expect.anything());
        expect(runtime.mutable.progress).toBeNull();
    });

    it('runs for a hidden AI message without provenance and skips explicit system messages', async () => {
        const { host, log, runtime } = await makeRuntime([user('u1'), assistant('a1'), { is_system: true, mes: 'hidden AI' }]);
        await host.emitGenerationEnded(3);
        await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith('auto.baseline_created', expect.anything()));
        expect(runtime.mutable.progress.assistantThrough).toBe(1);

        host.context.chat.push({ is_system: true, mes: 'system', extra: { type: 'generic' } });
        await host.emitGenerationEnded(4);
        await vi.waitFor(() => expect(log.debug).toHaveBeenCalledWith('auto.skipped', expect.anything()));
        expect(log.info).not.toHaveBeenCalledWith('auto.committed', expect.anything());
    });

    it('hydrates only targeted cold floors and keeps all-swipe cleaning functional', async () => {
        const messages = [assistant('a<x>1</x>'), assistant('latest')];
        messages[0].swipes.push(null);
        messages[0].swipe_info.push(null);
        messages[0].tt_swipe_cold = { sourceId: 1, record: 1 };
        messages[1].tt_swipe_cold = { sourceId: 1, record: 2 };
        const { host, log, runtime } = await makeRuntime(messages);
        runtime.mutable.settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        host.hydrateChatSwipes = vi.fn(async (_identity, index) => {
            host.context.chat[index].swipes[1] = 'b<x>2</x>';
            host.context.chat[index].swipe_info[1] = { extra: {} };
            delete host.context.chat[index].tt_swipe_cold;
        });
        const plan = await runtime.previewManual(1);
        expect(host.hydrateChatSwipes).toHaveBeenCalledOnce();
        expect(host.hydrateChatSwipes.mock.calls[0][1]).toBe(0);
        expect(plan.changes[0].bodyPatches.map(patch => patch.after)).toEqual(['a', 'b']);
        expect(plan.issues).toEqual([]);
        expect(log.warn).not.toHaveBeenCalledWith('message.degraded', expect.anything());
        await runtime.commitManual(false, plan);
        expect(host.context.chat[0].swipes).toEqual(['a', 'b']);
    });
    it('preserves failed cold candidates and logs actionable redacted warnings without blocking preview', async () => {
        const cold = { ...assistant('a<x>1</x>'), swipes: ['a<x>1</x>', null], swipe_info: [{ extra: {} }, null],
            tt_swipe_cold: { sourceId: 1, record: 1 } };
        const { host, log, runtime } = await makeRuntime([cold, assistant('safe', 'remove')], { settings: { clearSwipes: true } });
        runtime.mutable.settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        host.hydrateChatSwipes = vi.fn(async () => { throw new Error('private-source-details'); });
        const plan = await runtime.previewManual(0);
        expect(plan.stats.changedMessages).toBe(2);
        expect(plan.stats.removedSwipes).toBe(0);
        expect(plan.nextProgress.assistantThrough).toBe(-1);
        expect(log.warn).toHaveBeenCalledWith('message.degraded', expect.objectContaining({ data: expect.objectContaining({
            messageIndex: 0, swipeIndex: 1, actualType: 'null', expected: 'string', reason: 'swipe-body-type-invalid',
            sourceLocation: 'chat-cleaner/plan.js:buildOperationPlan', outcome: 'field-preserved',
        }) }));
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private-source-details|a<x>|sourceId/);
        expect(log.error).not.toHaveBeenCalled();
        await runtime.commitManual(false, plan);
        expect(host.context.chat[0].swipes).toEqual(['a', null]);
        expect(host.context.chat[0].tt_swipe_cold).toEqual({ sourceId: 1, record: 1 });
    });
    it('cancels a preview on identity change during hydration and clears old plans', async () => {
        const cold = { ...assistant('current'), tt_swipe_cold: { sourceId: 1, record: 1 } };
        const { host, log, runtime } = await makeRuntime([cold]);
        runtime.mutable.currentPlan = { old: true };
        host.hydrateChatSwipes = vi.fn(async () => { throw new ToolkitError('CHAT_CHANGED', 'chat changed'); });
        await expect(runtime.previewManual(0)).rejects.toThrow(/chat changed/);
        expect(runtime.state.currentPlan).toBeNull();
        expect(host.saveCurrentChat).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith('operation.failed', expect.objectContaining({ data: expect.objectContaining({ reason: 'chat-changed' }) }));
        expect(log.error).not.toHaveBeenCalled();
    });
    it('rejects confirmation for a replaced preview', async () => {
        const { runtime, host } = await makeRuntime([assistant('body', 'reasoning')]);
        const old = await runtime.previewManual(0);
        await runtime.previewManual(0);
        await expect(runtime.commitManual(false, old)).rejects.toThrow(/计划已改变/);
        expect(host.saveCurrentChat).not.toHaveBeenCalled();
    });
    it('automatically clears other candidates but retries anomalous floors without blocking healthy ones', async () => {
        const { runtime, host, log } = await makeRuntime([assistant('baseline')], { settings: { clearSwipes: true } });
        await runtime.runAutomatic(1);
        const bad = { ...assistant('broken'), swipes: ['broken', null], swipe_info: [{}, null], tt_swipe_cold: { sourceId: 1, record: 2 } };
        const good = { ...assistant('selected'), swipes: ['selected', 'old'], swipe_info: [{ extra: { keep: true } }, {}] };
        host.context.chat.push(bad, good, assistant('latest'));
        host.hydrateChatSwipes = vi.fn(async () => { throw new ToolkitError('SWIPE_LOAD_FAILED', 'load failed'); });
        await runtime.runAutomatic(4);
        expect(host.context.chat[2].swipes).toEqual(['selected']);
        expect(host.context.chat[1].swipes).toEqual(['broken', null]);
        expect(runtime.state.progress.assistantThrough).toBe(0);
        expect(runtime.state.status).toContain('局部警告');
        expect(log.error).not.toHaveBeenCalled();
        expect(host.saveCurrentChat).toHaveBeenCalledOnce();
    });
    it('rolls back a stale watermark after tail messages were deleted', async () => {
        const messages = [
            user('u1'), assistant('a1', 'thought 1'), user('u2'), assistant('a2', 'thought 2'),
            user('u3'), assistant('a3', 'thought 3'),
        ];
        const { host, log, runtime } = await makeRuntime(messages);

        await host.emitGenerationEnded(6); // 基线
        await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith('auto.baseline_created', expect.anything()));

        // 删除尾部楼层后仅剩 3 条：assistant 断点 3 越界（chat.length=3）
        host.context.chat.splice(2);
        host.context.chat.push(assistant('new a', 'new thought'));
        await host.emitGenerationEnded(3);
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith('auto.watermark_rolled_back', expect.anything()));

        expect(runtime.mutable.status).toContain('已回滚越界清洗断点');
        expect(runtime.mutable.progress.assistantThrough).toBeLessThan(3);
    });
});
