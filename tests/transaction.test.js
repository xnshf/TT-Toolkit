import { describe, expect, it, vi } from 'vitest';
import { buildOperationPlan } from '../src/features/chat-cleaner/plan.js';
import { createDefaultProgress, createDefaultSettings } from '../src/features/chat-cleaner/schema.js';
import { commitOperation } from '../src/features/chat-cleaner/transaction.js';
const identity = { stableId: 'chat-1', label: 'Test chat', ref: {} };
function fixture() {
    const message = {
        is_user: false,
        mes: 'b<x>2</x>',
        swipes: ['a<x>1</x>', 'b<x>2</x>'],
        swipe_id: 1,
        extra: { reasoning: 'r2', reasoning_type: 'parsed', reasoning_signature: 'keep', native: { opaque: true } },
        swipe_info: [
            { extra: { reasoning: 'r1', reasoning_duration: 3, reasoning_signature: 'keep' } },
            { extra: { reasoning: 'r2', reasoning_type: 'parsed', reasoning_signature: 'keep', native: { opaque: true } } },
        ],
    };
    const settings = createDefaultSettings();
    settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
    const plan = buildOperationPlan({ identity, messages: [structuredClone(message)] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
    return { message, plan };
}
describe('commit transaction', () => {
    it('applies minimal all-swipe changes and preserves unknown metadata', async () => {
        const { message, plan } = fixture();
        const host = {
            assertIdentity: vi.fn(async () => undefined),
            context: { chat: [message] },
            saveCurrentChat: vi.fn(async () => undefined),
            reloadCurrentChat: vi.fn(async () => undefined),
        };
        await commitOperation(host, plan);
        expect(message.swipes).toEqual(['a', 'b']);
        expect(message.mes).toBe('b');
        expect(message.extra).toMatchObject({ reasoning: '', reasoning_signature: 'keep', native: { opaque: true } });
        expect(message.extra).not.toHaveProperty('reasoning_type');
        expect(host.saveCurrentChat).toHaveBeenCalledOnce();
    });
    it('rejects edits made after preview before mutating anything', async () => {
        const { message, plan } = fixture();
        message.swipes[0] = 'edited';
        const before = structuredClone(message);
        const host = {
            assertIdentity: vi.fn(async () => undefined), context: { chat: [message] },
            saveCurrentChat: vi.fn(), reloadCurrentChat: vi.fn(),
        };
        await expect(commitOperation(host, plan)).rejects.toThrow(/已改变/);
        expect(message).toEqual(before);
        expect(host.saveCurrentChat).not.toHaveBeenCalled();
    });
    it('rejects a target whose semantic role changes after preview', async () => {
        const { message, plan } = fixture();
        message.is_user = true;
        const before = structuredClone(message);
        const host = {
            assertIdentity: vi.fn(async () => undefined), context: { chat: [message] },
            saveCurrentChat: vi.fn(), reloadCurrentChat: vi.fn(),
        };
        await expect(commitOperation(host, plan)).rejects.toThrow(/消息类型已改变/);
        expect(message).toEqual(before);
        expect(host.saveCurrentChat).not.toHaveBeenCalled();
    });
    it('rejects a newly explicit system marker on a hidden AI target before commit', async () => {
        const { message, plan } = fixture();
        message.is_system = true;
        message.extra.type = 'generic';
        const before = structuredClone(message);
        const host = {
            assertIdentity: vi.fn(async () => undefined), context: { chat: [message] },
            saveCurrentChat: vi.fn(), reloadCurrentChat: vi.fn(),
        };
        await expect(commitOperation(host, plan)).rejects.toThrow(/消息类型已改变/);
        expect(message).toEqual(before);
        expect(host.saveCurrentChat).not.toHaveBeenCalled();
    });
    it('commits a legacy character greeting marked as system at absolute floor zero', async () => {
        const greeting = { is_user: false, is_system: true, name: 'Char', mes: 'hello <x>remove</x>', extra: {} };
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const characterIdentity = { stableId: 'chat-legacy', label: 'Legacy chat', ref: { kind: 'character' } };
        const plan = buildOperationPlan({ identity: characterIdentity, messages: [structuredClone(greeting)] }, settings, {
            mode: 'manual',
            keep: 0,
            progress: createDefaultProgress(),
        });
        const host = {
            assertIdentity: vi.fn(async () => undefined),
            context: { chat: [greeting] },
            saveCurrentChat: vi.fn(async () => undefined),
            reloadCurrentChat: vi.fn(async () => undefined),
        };

        await commitOperation(host, plan);

        expect(greeting.mes).toBe('hello ');
        expect(host.saveCurrentChat).toHaveBeenCalledOnce();
    });
    it('commits both stored swipe and expanded mes patches for a character greeting', async () => {
        const greeting = {
            is_user: false,
            is_system: true,
            name: 'Char',
            mes: 'Hello Alice <x>expanded</x>',
            swipes: ['Hello {{user}} <x>raw</x>'],
            swipe_id: 0,
            extra: {},
            swipe_info: [{ extra: {} }],
        };
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const characterIdentity = { stableId: 'chat-greeting', label: 'Greeting chat', ref: { kind: 'character' } };
        const plan = buildOperationPlan({ identity: characterIdentity, messages: [structuredClone(greeting)] }, settings, {
            mode: 'manual',
            keep: 0,
            progress: createDefaultProgress(),
        });
        const host = {
            assertIdentity: vi.fn(async () => undefined),
            context: { chat: [greeting] },
            saveCurrentChat: vi.fn(async () => undefined),
            reloadCurrentChat: vi.fn(async () => undefined),
        };

        await commitOperation(host, plan);

        expect(greeting.swipes).toEqual(['Hello {{user}} ']);
        expect(greeting.mes).toBe('Hello Alice ');
        expect(host.saveCurrentChat).toHaveBeenCalledOnce();
    });
    it('clears other candidates after body/reasoning patches, preserving selected metadata', async () => {
        const { message } = fixture();
        const settings = createDefaultSettings();
        settings.clearSwipes = true;
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        message.swipe_info[1].unknown = { keep: true };
        const plan = buildOperationPlan({ identity, messages: [structuredClone(message)] }, settings,
            { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        const host = { assertIdentity: vi.fn(async () => undefined), context: { chat: [message] },
            saveCurrentChat: vi.fn(async () => undefined), reloadCurrentChat: vi.fn(async () => undefined) };
        await commitOperation(host, plan);
        expect(message.swipes).toEqual(['b']);
        expect(message.swipe_id).toBe(0);
        expect(message.mes).toBe('b');
        expect(message.swipe_info).toHaveLength(1);
        expect(message.swipe_info[0]).toMatchObject({ unknown: { keep: true }, extra: { reasoning: '', reasoning_signature: 'keep' } });
        expect(message.extra.native).toEqual({ opaque: true });
        expect(host.assertIdentity).toHaveBeenCalledWith(identity.stableId, identity.ref);
        expect(host.saveCurrentChat).toHaveBeenCalledOnce();
    });
    it('rejects changes to selected index, candidate count, and metadata before deletion', async () => {
        for (const mutate of [message => { message.swipe_id = 0; }, message => message.swipes.push('new'),
            message => { message.swipe_info[0].unknown = 'changed'; }]) {
            const { message } = fixture();
            const settings = createDefaultSettings();
            settings.clearSwipes = true;
            const plan = buildOperationPlan({ identity, messages: [structuredClone(message)] }, settings,
                { mode: 'manual', keep: 0, progress: createDefaultProgress() });
            mutate(message);
            const before = structuredClone(message);
            const host = { assertIdentity: vi.fn(async () => undefined), context: { chat: [message] },
                saveCurrentChat: vi.fn(), reloadCurrentChat: vi.fn() };
            await expect(commitOperation(host, plan)).rejects.toThrow(/已改变/);
            expect(message).toEqual(before);
            expect(host.saveCurrentChat).not.toHaveBeenCalled();
        }
    });
    it('preserves the stored greeting macro when clearing alternate greetings', async () => {
        const message = { is_user: false, mes: 'Hello Reader', swipes: ['other', 'Hello {{user}}'], swipe_id: 1, swipe_info: [{}, {}], extra: {} };
        const settings = createDefaultSettings();
        settings.clearSwipes = true;
        const identity = { stableId: 'greeting', ref: { kind: 'character' } };
        const plan = buildOperationPlan({ identity, messages: [structuredClone(message)] }, settings,
            { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        await commitOperation({ assertIdentity: async () => undefined, context: { chat: [message] },
            saveCurrentChat: async () => undefined, reloadCurrentChat: async () => undefined }, plan);
        expect(message.swipes).toEqual(['Hello {{user}}']);
        expect(message.mes).toBe('Hello Reader');
    });
    it('reloads authoritative data when persistence fails', async () => {
        const { message, plan } = fixture();
        const host = {
            assertIdentity: vi.fn(async () => undefined), context: { chat: [message] },
            saveCurrentChat: vi.fn(async () => { throw new Error('disk'); }),
            reloadCurrentChat: vi.fn(async () => undefined),
        };
        await expect(commitOperation(host, plan)).rejects.toThrow(/保存失败/);
        expect(host.reloadCurrentChat).toHaveBeenCalledOnce();
    });
});
