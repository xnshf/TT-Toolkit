import { describe, expect, it, vi } from 'vitest';
import { buildDecisionContext } from '../src/features/world-info-ai/context.js';
import { ToolkitError } from '../src/kernel/errors.js';

const user = (mes, extra = {}) => ({ is_user: true, mes, name: 'User', ...extra });
const assistant = (mes, extra = {}) => ({ is_user: false, mes, name: 'Actor', ...extra });
const settings = { historyRounds: 1 };
function host() {
    return { formatDecisionText: vi.fn(async (text, source) => `[${source}]${text}`) };
}
async function state(messages, backgrounds = [], overrides = settings, type = 'normal', adapter = host()) {
    return { value: JSON.parse(await buildDecisionContext(adapter, messages, backgrounds, overrides, type)), adapter };
}

describe('decision context snapshot', () => {
    it('uses recent user rounds, not message count, and copies only explicit text and safe names', async () => {
        const messages = [assistant('greeting'), user('u1'), assistant('a1'), assistant('a2'), user('u2', {
            name: { secret: 'private-name' }, extra: { reasoning: 'private-reasoning', display_text: 'not-body' },
            attachments: ['private-file'], swipes: ['not-current'],
        }), assistant('a3')];
        const { value, adapter } = await state(messages);
        expect(value).toEqual({
            background: [], dialogue: [
                { index: 4, role: 'user', name: '', content: '[user_input]u2' },
                { index: 5, role: 'assistant', name: 'Actor', content: '[ai_output]a3' },
            ], current_input: '[user_input]u2',
        });
        expect(adapter.formatDecisionText.mock.calls).toEqual([['u2', 'user_input', 1], ['a3', 'ai_output', 0]]);
        const { value: larger } = await state(messages, [], { historyRounds: 2 });
        expect(larger.dialogue.map(item => item.index)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('retains greetings only when the entire conversation fits, or the latest assistant without any user', async () => {
        expect((await state([assistant('g1'), assistant('g2'), user('u')])).value.dialogue.map(item => item.index)).toEqual([0, 1, 2]);
        const { value } = await state([assistant('g1'), assistant('g2')]);
        expect(value.dialogue.map(item => item.index)).toEqual([1]);
        expect(value.current_input).toBeNull();
        expect((await state([])).value).toEqual({ background: [], dialogue: [], current_input: null });
    });

    it('excludes hidden is_system, explicit system and tool turns before computing branch depth', async () => {
        const messages = [
            user('u'), assistant('hidden', { is_system: true }),
            assistant('sys', { extra: { type: 'narrator' } }),
            { role: 'system', mes: 'system' }, { role: 'tool', mes: null },
            assistant('legacy-tool', { extra: { tool_invocations: [] } }), assistant('a'),
        ];
        const { value, adapter } = await state(messages);
        expect(value.dialogue.map(item => item.index)).toEqual([0, 6]);
        expect(adapter.formatDecisionText.mock.calls).toEqual([['u', 'user_input', 1], ['a', 'ai_output', 0]]);
    });

    it('uses full filtered branch depth before applying the user-round window', async () => {
        const adapter = host();
        await state([assistant('g'), user('u1'), assistant('a1'), user('u2'), assistant('a2'), assistant('a3')], [], settings, 'normal', adapter);
        expect(adapter.formatDecisionText.mock.calls).toEqual([['u2', 'user_input', 2], ['a2', 'ai_output', 1], ['a3', 'ai_output', 0]]);
    });

    it('removes only the final assistant for swipe and never pops regenerate twice', async () => {
        const messages = [assistant('g'), user('u'), assistant('a1'), assistant('old-reply')];
        const { value: swiped, adapter } = await state(messages, [], settings, 'swipe');
        expect(swiped.dialogue.map(item => item.index)).toEqual([0, 1, 2]);
        expect(adapter.formatDecisionText.mock.calls.at(-1)).toEqual(['a1', 'ai_output', 0]);
        const alreadyRemoved = messages.slice(0, -1);
        expect((await state(alreadyRemoved, [], settings, 'regenerate')).value.dialogue.map(item => item.index)).toEqual([0, 1, 2]);
        expect((await state([assistant('g'), user('u')], [], settings, 'swipe')).value.dialogue.map(item => item.index)).toEqual([0, 1]);
        expect(messages.at(-1).mes).toBe('old-reply');
    });

    it('continues the final assistant with native -1 depth rather than replacing it', async () => {
        const { value, adapter } = await state([user('u'), assistant('prefix')], [], settings, 'continue');
        expect(adapter.formatDecisionText.mock.calls).toEqual([['u', 'user_input', 0], ['prefix', 'ai_output', -1]]);
        expect(value.dialogue.at(-1).content).toBe('[ai_output]prefix');
    });

    it('includes only native constant, non-template background text and uses no dialogue depth for it', async () => {
        const backgrounds = [
            { constant: true, content: 'facts', uid: 1, world: 'Lore', comment: 'not-exported' },
            { constant: false, content: 'keyword-body' }, { constant: true, disable: true, content: 'disabled' },
            { constant: true, content: '<%= unsafe() %>' }, { constant: true, content: '@@dont_activate\nnot-background' },
        ];
        const { value, adapter } = await state([user('u')], backgrounds);
        expect(value.background).toEqual([{ content: '[world_info]facts' }]);
        expect(adapter.formatDecisionText.mock.calls).toEqual([['facts', 'world_info', undefined], ['u', 'user_input', 0]]);
    });

    it('freezes all selected inputs and settings before formatting starts', async () => {
        const messages = [user('u'), assistant('a')];
        const backgrounds = [{ constant: true, content: 'facts' }];
        const config = { historyRounds: 1 };
        const adapter = { formatDecisionText: vi.fn(async (text, source) => {
            messages[0].mes = 'changed-u'; messages[1].mes = 'changed-a'; messages.push(user('new'));
            backgrounds[0].content = 'changed-background'; config.historyRounds = 99;
            return `${source}:${text}`;
        }) };
        const { value } = await state(messages, backgrounds, config, 'normal', adapter);
        expect(value.background).toEqual([{ content: 'world_info:facts' }]);
        expect(value.dialogue.map(item => item.content)).toEqual(['user_input:u', 'ai_output:a']);
        expect(value.current_input).toBe('user_input:u');
    });

    it('rejects malformed chosen text before any await while ignoring malformed text outside the window', async () => {
        const adapter = host();
        await expect(buildDecisionContext(adapter, [user('u'), assistant({ private: 'private-body' })], [], settings)).rejects.toMatchObject({
            code: 'DECISION_CONTEXT_INVALID', context: { field: 'mes', expected: 'string', actualType: 'object', messageIndex: 1 },
        });
        expect(adapter.formatDecisionText).not.toHaveBeenCalled();
        expect((await state([user(null), user('u2')])).value.dialogue.map(item => item.index)).toEqual([1]);
    });

    it.each([undefined, null, 0, 1.5, 101, '3'])('requires valid user-round settings (%j)', async historyRounds => {
        await expect(buildDecisionContext(host(), [], [], { historyRounds })).rejects.toMatchObject({ code: 'DECISION_CONTEXT_INVALID' });
    });

    it('never falls back to raw text on missing, throwing or nonstring formatters; errors omit private data', async () => {
        await expect(buildDecisionContext({}, [user('private-body')], [], settings)).rejects.toMatchObject({ code: 'HOST_DECISION_REGEX_MISSING' });
        for (const formatDecisionText of [() => { throw new Error('private-error'); }, () => ({ secret: 'private-body' })]) {
            let error;
            try { await buildDecisionContext({ formatDecisionText }, [user('private-body')], [], settings); } catch (caught) { error = caught; }
            expect(error).toBeInstanceOf(ToolkitError);
            expect(`${error.message}${JSON.stringify(error)}`).not.toContain('private');
        }
    });
});
