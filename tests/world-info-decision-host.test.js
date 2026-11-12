import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { ToolkitError } from '../src/kernel/errors.js';

function setup(overrides = {}) {
    const host = new TauriTavernHost();
    const context = { chat: [], characterId: 0, characters: [{ avatar: 'actor.png' }], tagMap: { 'actor.png': ['tag-a'] }, ...overrides };
    host.contextModule = { getContext: () => context };
    return { host, context };
}
const regexModule = () => ({
    regex_placement: { USER_INPUT: 1, AI_OUTPUT: 2, WORLD_INFO: 5 },
    getRegexedString: vi.fn(text => `${text}:prompt`),
});

async function caught(call) {
    try { await call(); } catch (error) { return error; }
    throw new Error('Expected failure');
}
function sanitized(error, code) {
    expect(error).toBeInstanceOf(ToolkitError);
    expect(error.code).toBe(code);
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain('private');
}

describe('host decision prompt regex', () => {
    it('lazily imports only the regex module and forwards prompt scope, source placement and optional depth', async () => {
        const { host } = setup();
        const engine = regexModule();
        host.dynamicImport = vi.fn(async () => engine);
        expect(host.dynamicImport).not.toHaveBeenCalled();
        expect(await host.formatDecisionText('u', 'user_input', 2)).toBe('u:prompt');
        expect(await host.formatDecisionText('a', 'ai_output', -1)).toBe('a:prompt');
        expect(await host.formatDecisionText('facts', 'world_info')).toBe('facts:prompt');
        expect(host.dynamicImport).toHaveBeenCalledExactlyOnceWith('/scripts/extensions/regex/engine.js');
        expect(engine.getRegexedString.mock.calls).toEqual([
            ['u', 1, { isPrompt: true, depth: 2 }], ['a', 2, { isPrompt: true, depth: -1 }], ['facts', 5, { isPrompt: true }],
        ]);
    });

    it('allows an empty string result but never substitutes or reruns write-time regex itself', async () => {
        const { host } = setup();
        host.regexModule = regexModule();
        host.regexModule.getRegexedString.mockReturnValue('');
        host.scriptModule = { substituteParams: vi.fn() };
        expect(await host.formatDecisionText('canonical mes', 'user_input')).toBe('');
        expect(host.scriptModule.substituteParams).not.toHaveBeenCalled();
        expect(host.regexModule.getRegexedString).toHaveBeenCalledExactlyOnceWith('canonical mes', 1, { isPrompt: true });
    });

    it.each([
        [undefined, 'user_input', undefined], ['text', 'reasoning', undefined], ['text', null, undefined],
        ['text', 'ai_output', -2], ['text', 'ai_output', '2'], ['text', 'ai_output', NaN],
    ])('rejects bad input before importing or running regex', async (text, source, depth) => {
        const { host } = setup();
        host.dynamicImport = vi.fn();
        sanitized(await caught(() => host.formatDecisionText(text, source, depth)), 'DECISION_TEXT_INVALID');
        expect(host.dynamicImport).not.toHaveBeenCalled();
    });

    it('sanitizes import errors and missing function/placement exports', async () => {
        const { host } = setup();
        host.dynamicImport = vi.fn(async () => { throw new Error('private-module-path'); });
        sanitized(await caught(() => host.formatDecisionText('private-body', 'user_input')), 'HOST_DECISION_REGEX_MISSING');
        for (const engine of [{}, { getRegexedString: vi.fn(), regex_placement: {} }, { regex_placement: { USER_INPUT: 1 } }]) {
            host.regexModule = engine;
            sanitized(await caught(() => host.formatDecisionText('private-body', 'user_input')), 'HOST_DECISION_REGEX_MISSING');
        }
    });

    it('sanitizes thrown regex errors and strictly rejects all nonstring results', async () => {
        const { host } = setup();
        host.regexModule = regexModule();
        host.regexModule.getRegexedString.mockImplementation(() => { throw new Error('private-regex-detail'); });
        sanitized(await caught(() => host.formatDecisionText('private-body', 'user_input')), 'DECISION_TEXT_FORMAT_FAILED');
        for (const value of [undefined, null, 7, { private: 'private-body' }, Promise.resolve('unexpected-async')]) {
            host.regexModule.getRegexedString.mockReturnValue(value);
            sanitized(await caught(() => host.formatDecisionText('private-body', 'user_input')), 'DECISION_TEXT_FORMAT_INVALID');
        }
    });
});

describe('strict decision condition macros', () => {
    it('calls only retained substituteParams without executing EJS', () => {
        const { host } = setup();
        host.scriptModule = { substituteParams: vi.fn(text => text.replaceAll('{{char}}', 'Actor')) };
        const condition = '<%= unsafe() %> near {{char}}';
        expect(host.expandDecisionCondition(condition)).toBe('<%= unsafe() %> near Actor');
        expect(host.scriptModule.substituteParams).toHaveBeenCalledExactlyOnceWith(condition);
    });

    it('requires the export only when used and never falls back to the raw condition', async () => {
        const { host } = setup();
        sanitized(await caught(() => host.expandDecisionCondition(null)), 'DECISION_CONDITION_INVALID');
        sanitized(await caught(() => host.expandDecisionCondition('private-condition')), 'HOST_DECISION_MACRO_MISSING');
        host.scriptModule = { substituteParams: () => { throw new Error('private-macro-detail'); } };
        sanitized(await caught(() => host.expandDecisionCondition('private-condition')), 'DECISION_CONDITION_EXPANSION_FAILED');
        for (const value of [null, undefined, 7, { private: 'private-body' }]) {
            host.scriptModule.substituteParams = () => value;
            sanitized(await caught(() => host.expandDecisionCondition('private-condition')), 'DECISION_CONDITION_EXPANSION_INVALID');
        }
        host.scriptModule.substituteParams = () => '';
        expect(host.expandDecisionCondition('text')).toBe('');
    });
});

describe('native decision eligibility and generation character identity', () => {
    it('keeps all regular trigger bases eligible while respecting native disable and generation filters', () => {
        const { host } = setup();
        for (const entry of [{}, { constant: true }, { vectorized: true }, { key: ['keyword'] }])
            expect(host.decisionEligibility(entry, 'normal')).toBe(true);
        for (const disable of [true, 1, '1']) expect(host.decisionEligibility({ disable }, 'normal')).toBe(false);
        expect(host.decisionEligibility({ disable: false, triggers: ['swipe'] }, 'normal')).toBe(false);
        expect(host.decisionEligibility({ triggers: ['swipe'] }, 'swipe')).toBe(true);
        expect(host.decisionEligibility({ triggers: [] }, 'continue')).toBe(true);
        expect(host.decisionEligibility({ triggers: 'swipe' }, 'normal')).toBe(true);
    });

    it('compares names with avatar filename without its final extension, not display name', () => {
        const { host, context } = setup();
        context.characters[0].name = 'Display';
        const include = names => ({ characterFilter: { names } });
        expect(host.decisionEligibility(include(['actor']), 'normal')).toBe(true);
        expect(host.decisionEligibility(include(['Display']), 'normal')).toBe(false);
        expect(host.decisionEligibility(include(['actor.png']), 'normal')).toBe(false);
        expect(host.decisionEligibility({ characterFilter: { names: ['actor'], isExclude: true } }, 'normal')).toBe(false);
        expect(host.decisionEligibility({ characterFilter: { names: ['other'], isExclude: true } }, 'normal')).toBe(true);
        context.characters[0].avatar = 'actor.part.png';
        expect(host.decisionEligibility(include(['actor.part']), 'normal')).toBe(true);
    });

    it('uses strict tag IDs and intersects name and tag eligibility', () => {
        const { host, context } = setup();
        const include = tags => ({ characterFilter: { names: ['actor'], tags } });
        expect(host.decisionEligibility(include(['tag-a']), 'normal')).toBe(true);
        expect(host.decisionEligibility(include(['tag-b']), 'normal')).toBe(false);
        expect(host.decisionEligibility({ characterFilter: { names: ['other'], tags: ['tag-a'] } }, 'normal')).toBe(false);
        expect(host.decisionEligibility({ characterFilter: { tags: ['tag-a'], isExclude: true } }, 'normal')).toBe(false);
        context.tagMap['actor.png'] = [1];
        expect(host.decisionEligibility(include(['1']), 'normal')).toBe(false);
        expect(host.decisionEligibility(include([1]), 'normal')).toBe(true);
    });

    it('treats missing avatar maps as native empty maps without mutating them, and bypasses non-array map entries', () => {
        const { host, context } = setup({ tagMap: {} });
        const entry = { characterFilter: { tags: ['tag-a'] } };
        expect(host.decisionEligibility(entry, 'normal')).toBe(false);
        expect(host.decisionEligibility({ characterFilter: { tags: ['tag-a'], isExclude: true } }, 'normal')).toBe(true);
        expect(context.tagMap).toEqual({});
        context.tagMap['actor.png'] = null;
        expect(host.decisionEligibility(entry, 'normal')).toBe(true);
        context.tagMap = undefined;
        expect(() => host.decisionEligibility(entry, 'normal')).toThrow(expect.objectContaining({ code: 'DECISION_TAG_MAP_INVALID' }));
    });

    it('makes a stable validated character key that changes with member ID or avatar', () => {
        const { host, context } = setup();
        const base = host.decisionCharacterKey();
        expect(typeof base).toBe('string');
        expect(base.length).toBeGreaterThan(0);
        expect(host.decisionCharacterKey()).toBe(base);
        context.characterId = 1; context.characters[1] = { avatar: 'actor.png' };
        const moved = host.decisionCharacterKey();
        expect(moved).not.toBe(base);
        context.characters[1].avatar = 'other.png';
        expect(host.decisionCharacterKey()).not.toBe(moved);
        for (const avatar of [null, undefined, 3, '']) {
            context.characters[1].avatar = avatar;
            expect(() => host.decisionCharacterKey()).toThrow(expect.objectContaining({ code: 'DECISION_CHARACTER_INVALID' }));
        }
    });
});

describe('last world-info listener registration', () => {
    function emitterSetup() {
        const listeners = [];
        const emitter = {
            on: vi.fn((_event, fn) => listeners.push(fn)),
            makeLast: vi.fn((_event, fn) => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); listeners.push(fn); }),
            removeListener: vi.fn((_event, fn) => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); }),
            emit: async payload => { for (const listener of [...listeners]) await listener(payload); },
        };
        const { host } = setup({ eventSource: emitter, eventTypes: { WORLDINFO_ENTRIES_LOADED: 'loaded' } });
        return { host, emitter, listeners };
    }
    const payload = () => ({ globalLore: [], characterLore: [], chatLore: [], personaLore: [] });

    it('registers exactly once using makeLast, waits async processing, and removes the identical wrapped listener', async () => {
        const { host, emitter } = emitterSetup();
        const order = [];
        emitter.on('loaded', () => order.push('other'));
        let finish;
        const work = new Promise(resolve => { finish = resolve; });
        const consumer = vi.fn(async lore => { order.push('decision-start'); await work; lore.globalLore.push({ uid: 1 }); order.push('decision-end'); });
        const errorHandler = vi.fn();
        const dispose = host.subscribeWorldInfoEntriesLoaded(consumer, errorHandler, { last: true });
        expect(emitter.makeLast).toHaveBeenCalledExactlyOnceWith('loaded', expect.any(Function));
        expect(emitter.on).toHaveBeenCalledOnce();
        const lore = payload();
        const scanning = emitter.emit(lore).then(() => order.push('scan'));
        await Promise.resolve();
        expect(order).toEqual(['other', 'decision-start']);
        finish(); await scanning;
        expect(order).toEqual(['other', 'decision-start', 'decision-end', 'scan']);
        expect(consumer).toHaveBeenCalledExactlyOnceWith(lore);
        expect(errorHandler).not.toHaveBeenCalled();
        const wrapped = emitter.makeLast.mock.calls[0][1];
        dispose();
        expect(emitter.removeListener).toHaveBeenCalledExactlyOnceWith('loaded', wrapped);
        await emitter.emit(payload());
        expect(consumer).toHaveBeenCalledOnce();
    });

    it('validates required ordering and removal functions before any registration', () => {
        for (const field of ['makeLast', 'removeListener']) {
            const { host, emitter } = emitterSetup();
            emitter[field] = undefined;
            expect(() => host.subscribeWorldInfoEntriesLoaded(vi.fn(), vi.fn(), { last: true })).toThrow(expect.objectContaining({ code: 'HOST_EVENT_MISSING' }));
            expect(emitter.on).not.toHaveBeenCalled();
            if (field !== 'makeLast') expect(emitter.makeLast).not.toHaveBeenCalled();
        }
        const { host, emitter } = emitterSetup();
        expect(() => host.subscribeWorldInfoEntriesLoaded(null, vi.fn(), { last: true })).toThrow(TypeError);
        expect(emitter.makeLast).not.toHaveBeenCalled();
    });

    it('keeps ordinary consumers on on() and routes contract failures through the same boundary for last consumers', async () => {
        const { host, emitter } = emitterSetup();
        host.subscribeWorldInfoEntriesLoaded(vi.fn(), vi.fn());
        expect(emitter.on).toHaveBeenCalledOnce();
        expect(emitter.makeLast).not.toHaveBeenCalled();
        const consumer = vi.fn();
        const contractError = vi.fn();
        host.subscribeWorldInfoEntriesLoaded(consumer, contractError, { last: true });
        await emitter.emit({ globalLore: [] });
        expect(consumer).not.toHaveBeenCalled();
        expect(contractError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'HOST_EVENT_INVALID' }));
        await emitter.emit(payload());
        expect(consumer).toHaveBeenCalledOnce();
    });
});
