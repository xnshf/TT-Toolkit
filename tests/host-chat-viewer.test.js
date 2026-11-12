import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';

function createHost() {
    const execute = vi.fn(async () => ({ isError: false }));
    const eventSource = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
    const eventTypes = Object.fromEntries([
        'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED',
        'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED',
    ].map(name => [name, name.toLocaleLowerCase()]));
    const context = { chat: [{ mes: 'one' }], executeSlashCommandsWithOptions: execute, eventSource, eventTypes };
    const host = new TauriTavernHost();
    host.contextModule = { getContext: () => context };
    host.abi = {
        api: {
            chat: {
                current: {
                    ref: () => ({ kind: 'character', characterId: 1, fileName: 'chat' }),
                    handle: () => ({ stableId: async () => 'stable-1' }),
                },
            },
        },
    };
    return { host, context, execute, eventSource };
}

describe('chat viewer host bridge', () => {
    it('executes the verified host jump command with an absolute index', async () => {
        const { host, execute } = createHost();
        await host.jumpToMessage('stable-1', 0);
        expect(execute).toHaveBeenCalledWith('/chat-jump 0', {
            handleParserErrors: false,
            handleExecutionErrors: false,
        });
        await expect(host.jumpToMessage('stable-1', 2)).rejects.toThrow(/跳转楼层/);
        await expect(host.jumpToMessage('other', 0)).rejects.toThrow(/已切换/);
    });

    it('loads cold candidates through the retained host export and rejects same-stable-ID branch changes', async () => {
        const { host, context } = createHost();
        context.chat[0].tt_swipe_cold = { sourceId: 1, record: 1 };
        host.scriptModule = { hydrateChatMessageSwipes: vi.fn(async () => {
            context.chat[0].swipes = ['one', 'other'];
            delete context.chat[0].tt_swipe_cold;
            return true;
        }) };
        const identity = await host.identity();
        await host.hydrateChatSwipes(identity, 0);
        expect(host.scriptModule.hydrateChatMessageSwipes).toHaveBeenCalledWith(0);
        expect(context.chat[0].swipes).toEqual(['one', 'other']);
        host.abi.api.chat.current.ref = () => ({ ...identity.ref, fileName: 'another-branch' });
        await expect(host.assertIdentity(identity.stableId, identity.ref)).rejects.toThrow(/已切换/);
    });
    it('rejects navigation or floor replacement during a candidate read', async () => {
        for (const navigation of [true, false]) {
            const { host, context } = createHost();
            context.chat[0].tt_swipe_cold = { sourceId: 1, record: 1 };
            const identity = await host.identity();
            host.scriptModule = { hydrateChatMessageSwipes: async () => {
                if (navigation)
                    host.abi.api.chat.current.ref = () => ({ ...identity.ref, fileName: 'different' });
                else
                    context.chat[0] = { mes: 'replacement' };
                return false;
            } };
            await expect(host.hydrateChatSwipes(identity, 0)).rejects.toThrow(navigation ? /已切换/ : /楼层已改变/);
        }
    });
    it('reports missing hydration ABI locally and wraps unknown read errors without leaking details', async () => {
        const { host, context } = createHost();
        context.chat[0].tt_swipe_cold = { sourceId: 1, record: 1 };
        host.scriptModule = {};
        const identity = await host.identity();
        await expect(host.hydrateChatSwipes(identity, 0)).rejects.toMatchObject({ code: 'HOST_SWIPE_EXPORT_MISSING' });
        host.scriptModule.hydrateChatMessageSwipes = async () => { throw new Error('secret-path'); };
        await expect(host.hydrateChatSwipes(identity, 0)).rejects.toMatchObject({ code: 'SWIPE_LOAD_FAILED', context: { messageIndex: 0 } });
        await expect(host.hydrateChatSwipes(identity, 0)).rejects.not.toThrow(/secret-path/);
        delete context.chat[0].tt_swipe_cold;
        await expect(host.hydrateChatSwipes(identity, 0)).resolves.toBeUndefined();
    });
    it('subscribes and disposes all chat mutation events', () => {
        const { host, context, eventSource } = createHost();
        const handler = vi.fn();
        const dispose = host.onChatMutated(handler);
        const eventNames = Object.values(context.eventTypes);
        expect(eventSource.on.mock.calls.map(([name]) => name)).toEqual(eventNames);
        const [event, wrapped] = eventSource.on.mock.calls[0];
        wrapped(3);
        expect(handler).toHaveBeenCalledWith({ type: event, args: [3] });
        dispose();
        expect(eventSource.off.mock.calls.map(([name]) => name)).toEqual(eventNames);
    });

    it('supports the host EventEmitter removeListener cleanup API', () => {
        const { host, context, eventSource } = createHost();
        eventSource.off = undefined;
        const dispose = host.onChatMutated(vi.fn());
        dispose();
        expect(eventSource.removeListener).toHaveBeenCalledTimes(Object.values(context.eventTypes).length);
    });

});
