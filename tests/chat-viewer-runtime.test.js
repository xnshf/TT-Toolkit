import { describe, expect, it, vi } from 'vitest';
import { ChatViewerRuntime } from '../src/features/chat-viewer/runtime.js';

const identity = stableId => ({ stableId, label: '当前聊天', ref: { kind: 'character' } });
const user = mes => ({ is_user: true, is_system: false, name: 'User', mes });

function logger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function hostWith(messages) {
    let currentMessages = messages;
    let stableId = 'chat-1';
    let ref = { kind: 'character', characterId: 'example-character', fileName: 'example-chat' };
    let mutationHandler = null;
    const host = {
        snapshot: vi.fn(async () => ({ identity: { ...identity(stableId), ref: structuredClone(ref) }, messages: structuredClone(currentMessages) })),
        jumpToMessage: vi.fn(async () => undefined),
        onChatMutated: vi.fn(handler => { mutationHandler = handler; return vi.fn(); }),
        chatAlias: vi.fn(() => 'chat-1'),
        setMessages(value) { currentMessages = value; },
        setStableId(value) { stableId = value; },
        setRef(value) { ref = value; },
        mutate(type = 'message_updated') { mutationHandler?.({ type, args: [] }); },
    };
    return host;
}

describe('chat viewer runtime', () => {
    it('subscribes while active, marks snapshots stale, and releases state when disabled', async () => {
        const host = hostWith([user('one')]);
        const runtime = new ChatViewerRuntime(host, logger());
        await runtime.activate();
        await runtime.refresh();
        host.mutate();
        expect(runtime.state.stale).toBe(true);
        expect(runtime.state.status).toContain('下次操作');
        const dispose = host.onChatMutated.mock.results[0].value;
        await runtime.deactivate();
        expect(dispose).toHaveBeenCalledOnce();
        expect(runtime.state.model).toBeNull();
    });

    it('refreshes stale data before a range or full-chat search', async () => {
        const host = hostWith([user('one')]);
        const runtime = new ChatViewerRuntime(host, logger());
        await runtime.activate();
        await runtime.refresh();
        host.setMessages([user('one'), user('needle')]);
        host.mutate('message_sent');
        const result = await runtime.search('needle');
        expect(result.items[0].conversationIndex).toBe(2);
        expect(host.snapshot).toHaveBeenCalledTimes(2);
    });

    it('warns on local corruption but continues search and healthy jumps', async () => {
        const host = hostWith([null, user('needle')]);
        const log = logger();
        const runtime = new ChatViewerRuntime(host, log);
        const result = await runtime.search('needle');
        expect(result.items[0].absoluteIndex).toBe(1);
        await runtime.jump(result.items[0]);
        expect(host.jumpToMessage).toHaveBeenCalledWith('chat-1', 1);
        await expect(runtime.jump(runtime.state.model.items[0])).rejects.toMatchObject({ code: 'MESSAGE_UNREADABLE' });
        expect(log.error).not.toHaveBeenCalled();
        expect(log.warn.mock.calls[0][1].data).toMatchObject({ code: 'MESSAGE_NOT_OBJECT', actualType: 'null', absoluteIndex: 0 });
    });

    it('records recoverable validation as warn with a recovery action', async () => {
        const log = logger();
        const runtime = new ChatViewerRuntime(hostWith([user('one')]), log);
        await expect(runtime.search('')).rejects.toMatchObject({ code: 'EMPTY_QUERY' });
        expect(log.warn.mock.calls.find(([event]) => event === 'operation.failed')[1].data).toMatchObject({
            operation: 'chat.search', field: 'query', sourceLocation: 'chat-viewer/model.js', reason: 'query-empty', nextAction: 'enter-query',
        });
        expect(log.error).not.toHaveBeenCalled();
    });

    it('refuses jumps across different character branches sharing a stable ID', async () => {
        const host = hostWith([user('same')]);
        const runtime = new ChatViewerRuntime(host, logger());
        const model = await runtime.refresh();
        host.setRef({ kind: 'character', characterId: 'example-character', fileName: 'other-branch' });
        await expect(runtime.jump(model.items[0])).rejects.toMatchObject({ code: 'CHAT_CHANGED' });
        expect(host.jumpToMessage).not.toHaveBeenCalled();
    });

    it('allows append-only changes but rejects switched, edited, or shifted jump targets', async () => {
        const host = hostWith([user('target')]);
        const runtime = new ChatViewerRuntime(host, logger());
        await runtime.refresh();
        const target = runtime.state.model.items[0];

        host.setMessages([user('target'), user('appended')]);
        await runtime.jump(target);
        expect(host.jumpToMessage).toHaveBeenCalledWith('chat-1', 0);

        host.setMessages([user('edited')]);
        await expect(runtime.jump(target)).rejects.toThrow(/移动或修改/);

        host.setMessages([user('target')]);
        host.setStableId('chat-2');
        await expect(runtime.jump(target)).rejects.toThrow(/已切换/);
    });
});
