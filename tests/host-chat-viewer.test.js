import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { ToolkitError } from '../src/kernel/errors.js';

function createHost() {
    const execute = vi.fn(async () => ({ isError: false }));
    const eventSource = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
    const eventTypes = Object.fromEntries([
        'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED',
        'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED',
    ].map(name => [name, name.toLocaleLowerCase()]));
    const context = { chat: [{ mes: 'one' }], chatMetadata: {}, executeSlashCommandsWithOptions: execute, eventSource, eventTypes };
    const host = new TauriTavernHost();
    const current = {
        ref: () => ({ kind: 'character', characterId: 'character-1', fileName: 'chat' }),
        handle: () => ({ ref: current.ref(), stableId: async () => 'stable-1' }),
    };
    host.contextModule = { getContext: () => context };
    host.abi = {
        api: {
            chat: {
                current,
            },
        },
    };
    return { host, context, execute, eventSource };
}

function cleanerEvents() {
    const fixture = createHost();
    const { host, context, eventSource } = fixture;
    for (const name of ['GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'GROUP_WRAPPER_FINISHED'])
        context.eventTypes[name] = name;
    const active = new Map();
    const register = (name, handler) => active.set(name, handler);
    eventSource.on.mockImplementation(register);
    eventSource.makeFirst = vi.fn(register);
    eventSource.off.mockImplementation((name, handler) => {
        if (active.get(name) === handler)
            active.delete(name);
    });
    const idle = Promise.withResolvers();
    host.scriptModule = { waitForGenerationIdle: () => idle.promise };
    host.groupModule = { is_group_generating: false };
    const emit = (name, ...args) => active.get(context.eventTypes[name])?.(...args);
    return { ...fixture, active, idle, emit };
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

    it.each([false, true])('requires removal before registering a host event (first: %s)', first => {
        const { host, eventSource } = createHost();
        eventSource.makeFirst = vi.fn();
        delete eventSource.off;
        delete eventSource.removeListener;
        expect(() => host.onHostEvent('CHAT_CHANGED', vi.fn(), { first })).toThrow(ToolkitError);
        expect(eventSource.on).not.toHaveBeenCalled();
        expect(eventSource.makeFirst).not.toHaveBeenCalled();
    });

    it('removes all generation listeners if wrapper registration fails after adding its callback', () => {
        const { host, active, eventSource } = cleanerEvents();
        eventSource.on.mockImplementation((event, handler) => {
            active.set(event, handler);
            if (event === 'GROUP_WRAPPER_FINISHED')
                throw new Error('registration failed');
        });
        expect(() => host.onGenerationEnded(vi.fn())).toThrow('registration failed');
        expect([...active.keys()]).toEqual([]);
    });

    it.each([false, true])('delivers once only after the host idle gate and any group wrapper (group: %s)', async group => {
        const { host, context, active, emit, idle } = cleanerEvents();
        host.groupModule.is_group_generating = group;
        const handleEnd = vi.fn();
        const dispose = host.onGenerationEnded(handleEnd);
        emit('GENERATION_STARTED', 'normal', {}, false);
        context.chat.push({ mes: 'new reply' });
        expect(emit('GENERATION_ENDED', context.chat.length)).toBeUndefined();
        emit('GENERATION_ENDED', context.chat.length);
        await Promise.resolve();
        expect(handleEnd).not.toHaveBeenCalled();
        if (group) {
            host.groupModule.is_group_generating = false;
            expect(emit('GROUP_WRAPPER_FINISHED')).toBeUndefined();
            expect(handleEnd).not.toHaveBeenCalled();
        }
        idle.resolve();
        await idle.promise;
        expect(handleEnd).toHaveBeenCalledExactlyOnceWith(context.chat.length, expect.any(Function));
        dispose();
        expect([...active.keys()]).toEqual([]);
    });

    it.each(['stop before end', 'end before stop', 'stopped group', 'missing end', 'bad payload', 'unchanged tail', 'dry run', 'chat change', 'branch', 'disposed', 'later member failed'])('does not authorize an auto write: %s', async cause => {
        const { host, context, emit, idle } = cleanerEvents();
        const onReady = vi.fn();
        const onSkipped = vi.fn();
        const dispose = host.onGenerationEnded(onReady, onSkipped);
        const group = ['later member failed', 'stopped group'].includes(cause);
        host.groupModule.is_group_generating = group;
        emit('GENERATION_STARTED', 'normal', {}, cause === 'dry run');
        if (cause !== 'unchanged tail')
            context.chat.push({ mes: 'reply' });
        emit('MESSAGE_SENT', 0);
        emit('MESSAGE_RECEIVED', 1, 'normal');
        if (cause === 'stop before end')
            emit('GENERATION_STOPPED');
        if (cause !== 'missing end')
            emit('GENERATION_ENDED', cause === 'bad payload' ? '2' : context.chat.length);
        if (cause === 'end before stop' || cause === 'stopped group')
            emit('GENERATION_STOPPED');
        if (group) {
            emit('GENERATION_STARTED', 'normal', {}, false);
            if (cause === 'stopped group')
                emit('GENERATION_ENDED', 2);
            host.groupModule.is_group_generating = false;
            emit('GROUP_WRAPPER_FINISHED');
        }
        if (cause === 'chat change')
            emit('CHAT_CHANGED');
        if (cause === 'branch') {
            const current = host.abi.api.chat.current;
            const ref = current.ref();
            current.ref = () => ({ ...ref, fileName: 'other-branch' });
        }
        if (cause === 'disposed')
            dispose();
        idle.resolve();
        await idle.promise;
        expect(onReady).not.toHaveBeenCalled();
        if (['missing end', 'bad payload', 'later member failed', 'unchanged tail'].includes(cause))
            expect(onSkipped).toHaveBeenCalledWith('CLEANER_GENERATION_END_UNCONFIRMED');
    });

    it('does not authorize auto cleaning when the host settlement capability is unavailable', async () => {
        const { host, context, emit } = cleanerEvents();
        delete host.scriptModule.waitForGenerationIdle;
        const onReady = vi.fn();
        const onSkipped = vi.fn();
        host.onGenerationEnded(onReady, onSkipped);
        emit('GENERATION_STARTED', 'normal', {}, false);
        context.chat.push({ mes: 'reply' });
        emit('GENERATION_ENDED', 2);
        await vi.waitFor(() => expect(onSkipped).toHaveBeenCalledWith('HOST_GENERATION_IDLE_UNAVAILABLE'));
        expect(onReady).not.toHaveBeenCalled();
    });

    it('checks the generation guard before dispatching metadata and does not write when it rejects', async () => {
        const { host, context } = createHost();
        context.chatMetadata = {};
        const setExtension = vi.fn();
        const current = host.abi.api.chat.current;
        const handle = current.handle();
        current.handle = () => ({ ...handle, metadata: { setExtension } });
        const beforeWrite = () => { throw new ToolkitError('CLEANER_GENERATION_ACTIVE', 'busy'); };
        await expect(host.chatExtensionSet('stable-1', 'fixture', { done: true }, { beforeWrite })).rejects.toMatchObject({ code: 'CLEANER_GENERATION_ACTIVE' });
        expect(setExtension).not.toHaveBeenCalled();
        expect(context.chatMetadata).toEqual({});
    });

    it.each(['branch', 'closed', 'reloaded', 'unchanged'])('reports the persisted result independently of the live mirror: %s', async change => {
        const { host, context } = createHost();
        const current = host.abi.api.chat.current;
        const expectedRef = current.ref();
        const handle = current.handle;
        const original = { extensions: { fixture: { old: true }, other: 42 } };
        context.chatMetadata = original;
        const dispatched = Promise.withResolvers();
        const finish = Promise.withResolvers();
        const writes = [];
        current.handle = () => {
            const target = handle();
            return { ...target, metadata: { async setExtension(payload) {
                writes.push({ ref: target.ref, payload });
                dispatched.resolve();
                await finish.promise;
            } } };
        };
        const write = host.chatExtensionSet('stable-1', 'fixture', null, { expectedRef });
        await dispatched.promise;
        const replacement = { extensions: { fixture: { independent: true } } };
        if (change === 'branch') {
            current.ref = () => ({ ...expectedRef, fileName: 'sibling' });
            context.chatMetadata = replacement;
        }
        else if (change === 'closed') {
            current.ref = () => { throw new Error('No active chat'); };
            context.chat = undefined;
        }
        else if (change === 'reloaded') {
            context.chatMetadata = replacement;
        }
        finish.resolve();
        const localMirror = change === 'unchanged';
        await expect(write).resolves.toMatchObject({ persisted: true, localMirror });
        expect(writes).toEqual([{ ref: expectedRef, payload: { namespace: 'fixture', value: null } }]);
        expect(original.extensions).toEqual(localMirror ? { other: 42 } : { fixture: { old: true }, other: 42 });
        expect(replacement.extensions.fixture).toEqual({ independent: true });
    });

    it('rejects dispatch if the current ref changes while the original handle resolves its stable ID', async () => {
        const { host } = createHost();
        const current = host.abi.api.chat.current;
        const expectedRef = current.ref();
        const handle = current.handle;
        const setExtension = vi.fn();
        const pending = Promise.withResolvers();
        current.handle = () => ({ ...handle(), stableId: () => pending.promise, metadata: { setExtension } });
        const write = host.chatExtensionSet('stable-1', 'fixture', {}, { expectedRef });
        current.ref = () => ({ ...expectedRef, fileName: 'sibling' });
        pending.resolve('stable-1');
        await expect(write).rejects.toMatchObject({ code: 'CHAT_CHANGED' });
        expect(setExtension).not.toHaveBeenCalled();
    });

    it.each(['handle', 'stableId'])('normalizes unavailable identity at %s without exposing the original error', async stage => {
        const { host } = createHost();
        const current = host.abi.api.chat.current;
        const handle = current.handle();
        current.handle = () => {
            if (stage === 'handle') throw new Error('private path');
            return { ...handle, stableId: async () => { throw new Error('private path'); } };
        };
        await expect(host.identity()).rejects.toMatchObject({ code: 'NO_CHAT' });
        await expect(host.identity()).rejects.not.toThrow(/private path/);
    });

    it('supports the host EventEmitter removeListener cleanup API', () => {
        const { host, context, eventSource } = createHost();
        eventSource.off = undefined;
        const dispose = host.onChatMutated(vi.fn());
        dispose();
        expect(eventSource.removeListener).toHaveBeenCalledTimes(Object.values(context.eventTypes).length);
    });

});
