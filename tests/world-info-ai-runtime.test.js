import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldInfoAiRuntime } from '../src/features/world-info-ai/runtime.js';
import { TauriTavernHost } from '../src/kernel/host.js';
import { ToolkitError } from '../src/kernel/errors.js';

const id = (uid = 2, world = 'Lore') => JSON.stringify([world, uid]);
const condition = 'Rain near {{user}}';
function config(threshold = null) {
    return { schemaVersion: 2, enabled: true, entries: {
        2: { mode: 'ai', aiDescription: condition, threshold },
    } };
}
function entry(uid, fields = {}) {
    return { uid, world: 'Lore', content: `body-${uid}`, comment: `Entry ${uid}`, key: [`key-${uid}`], ...fields };
}
function payload(entries = [entry(1), entry(2)]) {
    return { globalLore: entries, characterLore: [], chatLore: [], personaLore: [] };
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup(options = {}) {
    const handlers = {};
    const session = {
        identity: { stableId: 'chat-1', ref: { kind: 'character', characterId: 0, fileName: 'main' } },
        character: JSON.stringify([0, 'actor.png']),
        messages: [{ is_user: true, mes: 'Tell me about rain.' }],
        mounted: options.payload ?? payload(),
        config: options.config ?? config(),
        settings: options.settings,
        preset: { id: 'p1', name: 'Decision', protocol: 'systemone', apiUrl: 'https://decision.invalid', model: 'jev', apiKey: 'secret-key' },
    };
    const host = {
        context: { characterId: 0, characters: [{ avatar: 'actor.png' }], tagMap: { 'actor.png': ['tag-a'] } },
        onHostEvent: vi.fn((name, handler) => {
            handlers[name] = handler;
            return () => { delete handlers[name]; };
        }),
        validateWorldInfoEntriesPayload: TauriTavernHost.prototype.validateWorldInfoEntriesPayload,
        subscribeWorldInfoEntriesLoaded: vi.fn((listener, onError) => host.onHostEvent('WORLDINFO_ENTRIES_LOADED', value => {
            try { host.validateWorldInfoEntriesPayload(value); }
            catch (error) { return onError(error); }
            return listener(value);
        })),
        emitHostEvent: vi.fn(),
        generationWillRequestModel: vi.fn(() => true),
        isGenerationInProgress: vi.fn(() => false),
        identity: vi.fn(async () => structuredClone(session.identity)),
        snapshot: vi.fn(async () => ({ identity: structuredClone(session.identity), messages: structuredClone(session.messages) })),
        decisionCharacterKey: vi.fn(() => session.character),
        decisionEligibility: vi.fn(TauriTavernHost.prototype.decisionEligibility),
        expandDecisionCondition: vi.fn(text => text.replaceAll('{{user}}', 'User')),
        formatDecisionText: vi.fn(async text => text),
        getMountedWorldInfoEntries: vi.fn(async () => session.mounted),
        activeWorldInfoBindings: vi.fn(() => [{ name: 'Lore', source: 'global' }]),
        listWorldInfoNames: vi.fn(() => ['Lore']),
        globalGet: vi.fn(async () => session.settings),
        globalSet: vi.fn(async (_key, value) => { session.settings = structuredClone(value); }),
        exportFile: vi.fn(),
    };
    const store = {
        load: vi.fn(async () => ({ data: { entries: Object.fromEntries(session.mounted.globalLore.map(item => [item.uid, item])) },
            config: structuredClone(session.config), backend: 'world-extension' })),
        save: vi.fn(), reset: vi.fn(),
    };
    const presets = {
        load: vi.fn(async () => ({ activePresetId: 'p1', presets: [session.preset,
            { id: 'chat', name: 'Chat', protocol: 'chat-completions', model: 'chat-model' }] })),
        active: vi.fn(async () => structuredClone(session.preset)),
        byId: vi.fn(async selected => {
            if (selected === 'chat') return { id: 'chat', protocol: 'chat-completions' };
            if (selected !== session.preset.id) throw new ToolkitError('LLM_PRESET_MISSING', 'Missing preset');
            return structuredClone(session.preset);
        }),
    };
    const decisions = { evaluate: vi.fn(async ({ questions }) => ({
        probabilities: new Map(Object.keys(questions).map(key => [key, options.probability ?? 0.7])),
        usage: { input_tokens: 10, output_tokens: 2 },
    })) };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new WorldInfoAiRuntime(host, log, { store, presets, decisions });
    const arm = async (type = 'normal', params = {}, dryRun = false) => {
        handlers.GENERATION_STARTED();
        await handlers.GENERATION_AFTER_COMMANDS(type, params, dryRun);
    };
    const scan = value => handlers.WORLDINFO_ENTRIES_LOADED(value ?? payload());
    return { runtime, host, handlers, session, decisions, store, presets, log, arm, scan };
}

afterEach(() => vi.restoreAllMocks());

describe('decision activation at the awaited world-info boundary', () => {
    it('only arms after commands, then evaluates the actual current user text before scanning', async () => {
        const { runtime, host, session, decisions, arm, scan } = setup();
        session.messages = [{ is_user: true, mes: 'Previous input' }];
        await runtime.activate();
        expect(host.subscribeWorldInfoEntriesLoaded).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { last: true });
        await arm();
        expect(decisions.evaluate).not.toHaveBeenCalled();
        expect(host.getMountedWorldInfoEntries).not.toHaveBeenCalled();
        session.messages.push({ is_user: true, mes: 'Actual submitted input' });
        const work = deferred();
        decisions.evaluate.mockReturnValue(work.promise);
        const lore = payload();
        const original = lore.globalLore[1];
        let completed = false;
        const scanning = scan(lore).then(() => { completed = true; });
        await vi.waitFor(() => expect(decisions.evaluate).toHaveBeenCalledOnce());
        expect(completed).toBe(false);
        expect(lore.globalLore[1]).toBe(original);
        const input = decisions.evaluate.mock.calls[0][0];
        expect(JSON.parse(input.state).current_input).toBe('Actual submitted input');
        expect(Object.keys(input.questions)).toEqual([id()]);
        expect(input.questions[id()]).toMatchObject({ type: 'noul', instructions: expect.stringContaining('Rain near User') });
        expect(input.presetId).toBe('p1');
        expect(input.signal).toBeInstanceOf(AbortSignal);
        expect(host.expandDecisionCondition).toHaveBeenCalledWith(condition);
        expect(JSON.stringify(input)).not.toContain('body-2');
        work.resolve({ probabilities: new Map([[id(), 0.7]]) });
        await scanning;
        expect(completed).toBe(true);
        expect(lore.globalLore[1].constant).toBe(true);
        expect(host.emitHostEvent).not.toHaveBeenCalled();
    });

    it('uses inclusive thresholds, replacing only scan-local clones and preserving native groups and restrictions', async () => {
        const managed = entry(2, { keysecondary: ['secondary'], constant: false, vectorized: true,
            group: 'weather', groupWeight: 42, groupOverride: true, useGroupScoring: true,
            characterFilter: { names: ['actor'], tags: ['tag-a'] }, triggers: ['normal'],
            order: 15, position: 1, depth: 4, role: 0, ignoreBudget: false,
            useProbability: true, probability: 12, sticky: 3, cooldown: 2, delay: 1,
            delayUntilRecursion: true, excludeRecursion: true, extensions: { custom: { keep: true } } });
        const before = structuredClone(managed);
        const native = entry(1);
        const lore = payload([native, managed]);
        const array = lore.globalLore;
        const { runtime, host, arm, scan } = setup({ config: config(0.7) });
        await runtime.activate();
        await arm();
        await scan(lore);
        expect(lore.globalLore).toBe(array);
        expect(lore.globalLore[0]).toBe(native);
        expect(lore.globalLore[1]).not.toBe(managed);
        expect(managed).toEqual(before);
        expect(lore.globalLore[1]).toEqual({ ...before, constant: true, useProbability: false, probability: 100,
            sticky: null, cooldown: null, delay: null, delayUntilRecursion: false, excludeRecursion: false });
        expect(runtime.state.rounds[0]).toMatchObject({ selectedCount: 1, results: [{ probability: 0.7, threshold: 0.7, passed: true, injected: null }] });
        expect(host.emitHostEvent).not.toHaveBeenCalled();
    });

    it('suppresses below-threshold entries without removing them or altering their cached originals', async () => {
        const managed = entry(2, { constant: true, group: 'weather' });
        const lore = payload([managed]);
        const { runtime, arm, scan } = setup({ probability: 0.69 });
        await runtime.activate();
        await arm();
        await scan(lore);
        expect(lore.globalLore).toEqual([{ ...managed, disable: true }]);
        expect(lore.globalLore[0]).not.toBe(managed);
        expect(managed.disable).toBeUndefined();
        expect(runtime.state.rounds[0]).toMatchObject({ selectedCount: 0, results: [{ passed: false }] });
    });

    it.each([{ constant: true }, { vectorized: true }, { extensions: { vectorized: true } }])('accepts regular native trigger configurations %j', async fields => {
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate();
        await arm();
        const lore = payload([entry(2, fields)]);
        await scan(lore);
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(lore.globalLore[0].constant).toBe(true);
    });

    it('handles all mounted sources and collision-free world/uid tuple IDs', async () => {
        const worlds = ['Lore.2', 'Lore', 'Lore["x"]', 'Other'];
        const lists = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
        const lore = payload([]);
        lists.forEach((list, index) => { lore[list] = [entry(2, { world: worlds[index] })]; });
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate();
        await arm();
        await scan(lore);
        expect(Object.keys(decisions.evaluate.mock.calls[0][0].questions)).toEqual(worlds.map(world => id(2, world)));
        for (const list of lists) expect(lore[list][0].constant).toBe(true);
    });

    it('keeps templates, dont_activate, disabled and native character/generation exclusions entirely native', async () => {
        const excluded = [
            entry(3, { content: '<%- variables.rain %>' }),
            entry(4, { content: '@@if variables.rain\nbody' }),
            entry(5, { comment: '[GENERATE:BEFORE]' }),
            entry(6, { content: '@@dont_activate\nbody' }),
            entry(7, { disable: true }),
            entry(8, { triggers: ['swipe'] }),
            entry(9, { characterFilter: { names: ['other'] } }),
        ];
        const settings = config();
        for (const item of excluded) settings.entries[item.uid] = { mode: 'ai', aiDescription: `private-condition-${item.uid}`, threshold: null };
        const { runtime, decisions, arm, scan } = setup({ config: settings });
        await runtime.activate();
        await arm();
        const lore = payload([entry(2), ...excluded]);
        await scan(lore);
        expect(lore.globalLore.slice(1)).toEqual(excluded);
        excluded.forEach((item, index) => expect(lore.globalLore[index + 1]).toBe(item));
        const input = decisions.evaluate.mock.calls[0][0];
        expect(Object.keys(input.questions)).toEqual([id()]);
        expect(JSON.stringify(input)).not.toMatch(/private-condition|variables.rain|body-[3-9]/);
    });

    it('includes eligible native constants as background, not managed or excluded world-info bodies', async () => {
        const lore = payload([entry(1, { constant: true }), entry(2, { constant: true }),
            entry(3, { constant: true, disable: true }), entry(4)]);
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate();
        await arm();
        await scan(lore);
        const input = decisions.evaluate.mock.calls[0][0];
        expect(JSON.parse(input.state).background).toEqual([{ content: 'body-1' }]);
        expect(JSON.stringify(input)).not.toMatch(/body-[234]/);
    });

    it.each(['normal', 'regenerate', 'swipe', 'continue'])('supports %s generation', async type => {
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate();
        await arm(type);
        await scan();
        expect(decisions.evaluate).toHaveBeenCalledOnce();
    });

    it.each([
        ['dry-run', 'normal', {}, true], ['quiet', 'quiet', {}, false],
        ['skipWIAN', 'normal', { skipWIAN: true }, false],
        ['aborted', 'normal', { signal: AbortSignal.abort() }, false],
    ])('does not pay for skipped %s requests', async (_label, type, params, dryRun) => {
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate();
        await arm(type, params, dryRun);
        const lore = payload();
        const before = structuredClone(lore);
        await scan(lore);
        expect(decisions.evaluate).not.toHaveBeenCalled();
        expect(lore).toEqual(before);
    });

    it('skips group wrappers that will not request a model and disabled world configurations', async () => {
        const { runtime, host, session, decisions, arm, scan } = setup();
        await runtime.activate();
        host.generationWillRequestModel.mockReturnValue(false);
        await arm(); await scan();
        host.generationWillRequestModel.mockReturnValue(true);
        session.config.enabled = false;
        await arm(); await scan();
        expect(decisions.evaluate).not.toHaveBeenCalled();
    });

    it('shares one awaited evaluation for duplicate scans and never reapplies the same payload', async () => {
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate(); await arm();
        const work = deferred();
        decisions.evaluate.mockReturnValue(work.promise);
        const first = payload(), second = payload();
        const scans = [scan(first), scan(second)];
        await vi.waitFor(() => expect(decisions.evaluate).toHaveBeenCalledOnce());
        work.resolve({ probabilities: new Map([[id(), 0.8]]) });
        await Promise.all(scans);
        expect(first.globalLore[1].constant).toBe(true);
        expect(second.globalLore[1].constant).toBe(true);
        expect(runtime.state.rounds).toHaveLength(1);
        const applied = first.globalLore[1];
        await scan(first);
        expect(first.globalLore[1]).toBe(applied);
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(runtime.state.warning).toBe('');
    });

    it('records real injection only from the final non-dry-run Map activation DTO', async () => {
        const settings = config();
        settings.entries[3] = { mode: 'ai', aiDescription: 'Wind', threshold: null };
        const { runtime, handlers, arm, scan } = setup({ config: settings });
        await runtime.activate(); await arm();
        await scan(payload([entry(2), entry(3)]));
        const activated = { entries: new Map([['host-key', entry(2)]]) };
        handlers.WORLDINFO_SCAN_DONE({ isFinal: false, activated });
        handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: true, activated });
        expect(runtime.state.rounds[0].results.map(result => result.injected)).toEqual([null, null]);
        handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: false, activated });
        expect(runtime.state.rounds[0].results.map(result => result.injected)).toEqual([true, false]);
        expect(runtime.state.rounds[0].outcome).toMatch(/扫描已完成/);
    });
});

describe('native fallback, stale targets and cancellation', () => {
    it.each([undefined, NaN, Infinity, -0.1, 1.1, '0.8'])('keeps every native entry on invalid probability %s', async probability => {
        const { runtime, decisions, log, arm, scan } = setup();
        decisions.evaluate.mockResolvedValue({ probabilities: new Map([[id(), probability]]) });
        await runtime.activate(); await arm();
        const lore = payload(); const before = structuredClone(lore); const managed = lore.globalLore[1];
        await scan(lore);
        expect(lore).toEqual(before);
        expect(lore.globalLore[1]).toBe(managed);
        expect(runtime.state.warning).toMatch(/回退原生/);
        expect(log.warn).toHaveBeenCalledWith('decision.round_fallback', { data: expect.objectContaining({ reason: 'DECISION_RESPONSE_INVALID', outcome: 'native-fallback' }) });
        expect(log.error).not.toHaveBeenCalled();
    });

    it('falls back once on model failure, does not retry recursive scans, and recovers next generation', async () => {
        const { runtime, decisions, log, arm, scan } = setup();
        decisions.evaluate.mockRejectedValueOnce(new Error('private-network-secret'));
        await runtime.activate(); await arm();
        const lore = payload(); const before = structuredClone(lore);
        await scan(lore); await scan(payload());
        expect(lore).toEqual(before);
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(log.warn).toHaveBeenCalledOnce();
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private-network-secret');
        expect(runtime.state.warning).not.toContain('private-network-secret');
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledTimes(2);
        expect(runtime.state.warning).toBe('');
    });

    it('rejects malformed event payloads without evaluating or replaying into a later recursive scan', async () => {
        const { runtime, log, decisions, arm, scan } = setup();
        await runtime.activate(); await arm();
        const lore = { ...payload([entry(2, { world: 'private-world' })]), personaLore: 'private-body' };
        const before = structuredClone(lore);
        await scan(lore);
        expect(lore).toEqual(before);
        expect(decisions.evaluate).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith('host.event_contract_failed', { data: expect.objectContaining({ field: 'personaLore', expected: 'array', actualType: 'string' }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private-world|private-body/);
        await scan(payload());
        expect(decisions.evaluate).not.toHaveBeenCalled();
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(runtime.state.warning).toBe('');
    });

    it('does not apply a partially valid probability response to any managed entry', async () => {
        const settings = config();
        settings.entries[3] = { mode: 'ai', aiDescription: 'Wind', threshold: null };
        const { runtime, decisions, arm, scan } = setup({ config: settings });
        decisions.evaluate.mockResolvedValue({ probabilities: new Map([[id(), 0.9], [id(999), 0.9]]) });
        await runtime.activate(); await arm();
        const lore = payload([entry(2), entry(3)]); const before = structuredClone(lore);
        await scan(lore);
        expect(lore).toEqual(before);
        expect(runtime.state.warning).toMatch(/回退原生/);
    });

    it.each(['messages', 'target', 'fileName', 'characterId', 'character', 'groupChatId'])('rejects changed %s after an in-flight evaluation', async change => {
        const { runtime, session, decisions, arm, scan } = setup();
        if (change === 'groupChatId') session.identity.ref = { kind: 'group', chatId: 'group-main' };
        await runtime.activate(); await arm();
        const work = deferred(); decisions.evaluate.mockReturnValue(work.promise);
        const lore = payload();
        const scanning = scan(lore);
        await vi.waitFor(() => expect(decisions.evaluate).toHaveBeenCalledOnce());
        if (change === 'messages') session.messages[0].mes = 'Changed branch text';
        if (change === 'target') lore.globalLore[1].content = 'Changed world-info body';
        if (change === 'fileName') session.identity.ref.fileName = 'fork-with-same-stable-id';
        if (change === 'characterId') session.identity.ref.characterId = 1;
        if (change === 'character') session.character = JSON.stringify([1, 'other.png']);
        if (change === 'groupChatId') session.identity.ref.chatId = 'group-fork';
        const beforeResolution = structuredClone(lore);
        work.resolve({ probabilities: new Map([[id(), 0.9]]) }); await scanning;
        expect(lore).toEqual(beforeResolution);
        expect(runtime.state.warning).toMatch(/回退原生/);
    });

    it.each(['GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'deactivate', 'abort'])('never publishes late results after %s', async event => {
        const { runtime, handlers, decisions, log, arm, scan } = setup();
        const signal = new AbortController();
        await runtime.activate(); await arm('normal', { signal: signal.signal });
        const work = deferred(); decisions.evaluate.mockReturnValue(work.promise);
        const lore = payload(); const before = structuredClone(lore);
        const scanning = scan(lore);
        await vi.waitFor(() => expect(decisions.evaluate).toHaveBeenCalledOnce());
        if (event === 'deactivate') await runtime.deactivate();
        else if (event === 'abort') signal.abort();
        else handlers[event]();
        expect(decisions.evaluate.mock.calls[0][0].signal.aborted).toBe(true);
        work.resolve({ probabilities: new Map([[id(), 0.9]]) }); await scanning;
        expect(lore).toEqual(before);
        expect(runtime.state.rounds).toEqual([]);
        expect(log.warn).not.toHaveBeenCalled();
        expect(runtime.state.warning).toBe('');
        if (event === 'deactivate') expect(Object.keys(handlers)).toEqual([]);
    });

    it.each(['branch', 'group', 'character'])('does not leak a stale %s round rejection into a new generation', async change => {
        const { runtime, session, decisions, log, arm, scan } = setup();
        await runtime.activate(); await arm();
        const work = deferred(); decisions.evaluate.mockReturnValueOnce(work.promise);
        const oldLore = payload(); const before = structuredClone(oldLore);
        const oldScan = scan(oldLore);
        await vi.waitFor(() => expect(decisions.evaluate).toHaveBeenCalledOnce());
        if (change === 'branch') session.identity.ref.fileName = 'same-integrity-fork';
        if (change === 'group') session.identity = { stableId: 'chat-1', ref: { kind: 'group', chatId: 'group-2' } };
        if (change === 'character') session.character = JSON.stringify([1, 'other.png']);
        await arm();
        const newLore = payload(); await scan(newLore);
        work.reject(new Error('late-private-error')); await oldScan;
        expect(oldLore).toEqual(before);
        expect(newLore.globalLore[1].constant).toBe(true);
        expect(runtime.state.rounds).toHaveLength(1);
        expect(runtime.state.warning).toBe('');
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('logs only whitelisted failure diagnostics, never conditions, credentials, identity or raw host errors', async () => {
        const { runtime, session, decisions, log, arm, scan } = setup();
        decisions.evaluate.mockRejectedValue(new ToolkitError('DECISION_RESPONSE_INVALID', 'Invalid probability', {
            field: 'probability', expected: 'finite-number-0-1', actualType: 'string', messageIndex: 3,
            source: 'user_input', body: 'private-body', condition, apiKey: 'secret-key',
            identity: session.identity, detail: new Error('private-host-error'),
        }));
        await runtime.activate(); await arm(); await scan();
        const data = log.warn.mock.calls[0][1].data;
        expect(data).toMatchObject({ operation: expect.any(String), stage: expect.any(String), reason: 'DECISION_RESPONSE_INVALID',
            field: 'probability', expected: 'finite-number-0-1', actualType: 'string', messageIndex: 3,
            source: 'user_input', sourceLocation: expect.any(String), outcome: 'native-fallback', nextAction: expect.any(String) });
        expect(Object.keys(data).sort()).toEqual(['operation', 'stage', 'reason', 'field', 'expected', 'actualType',
            'messageIndex', 'source', 'sourceLocation', 'outcome', 'nextAction'].sort());
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private-body|Rain near|secret-key|chat-1|private-host-error/);
        expect(log.error).not.toHaveBeenCalled();
    });

    it('does not guess identities without a character/group ref', async () => {
        const { runtime, session, decisions, arm, scan } = setup();
        session.identity = { stableId: 'chat-1' };
        await runtime.activate(); await arm();
        const lore = payload(); const before = structuredClone(lore);
        await scan(lore);
        expect(decisions.evaluate).not.toHaveBeenCalled();
        expect(lore).toEqual(before);
        expect(runtime.state.warning).toMatch(/回退原生/);
    });
});

describe('decision cache, manual tests and visible settings', () => {
    it('reuses exact state/condition/preset probabilities but reapplies changed thresholds', async () => {
        const { runtime, session, decisions, arm, scan } = setup({ probability: 0.75 });
        await runtime.activate(); await arm(); await scan();
        session.config.entries[2].threshold = 0.8;
        await arm(); const second = payload(); await scan(second);
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(second.globalLore[1].disable).toBe(true);
        expect(runtime.state.rounds.at(-1)).toMatchObject({ cached: true, selectedCount: 0, results: [{ threshold: 0.8, probability: 0.75 }] });
        session.config.entries[2].threshold = null;
        await runtime.saveSettings({ ...runtime.state.settings, threshold: 0.9 });
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(runtime.state.rounds.at(-1).results[0].threshold).toBe(0.9);
    });

    it.each(['state', 'condition', 'preset'])('does not reuse cached probabilities after %s changes', async change => {
        const { runtime, session, decisions, arm, scan } = setup();
        await runtime.activate(); await arm(); await scan();
        if (change === 'state') session.messages[0].mes += ' New input.';
        if (change === 'condition') session.config.entries[2].aiDescription = 'Snow';
        if (change === 'preset') session.preset.apiUrl = 'https://different.invalid';
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledTimes(2);
        expect(runtime.state.rounds.at(-1).cached).toBe(false);
    });

    it('expires cached probabilities and supports explicit cache clearing', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(100000);
        const { runtime, decisions, arm, scan } = setup();
        await runtime.activate(); await arm(); await scan();
        now.mockReturnValue(160001);
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledTimes(2);
        runtime.clearCache();
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledTimes(3);
    });

    it('bounds visible rounds to the last 50 and clears them on request', async () => {
        const { runtime, session, arm, scan } = setup();
        await runtime.activate();
        for (let round = 0; round < 55; round++) {
            session.config.entries[2].threshold = round / 100;
            await arm(); await scan();
        }
        expect(runtime.state.rounds).toHaveLength(50);
        expect(runtime.state.rounds[0].results[0].threshold).toBe(0.05);
        expect(runtime.state.rounds.at(-1).results[0].threshold).toBe(0.54);
        runtime.clearRounds();
        expect(runtime.state.rounds).toEqual([]);
    });

    it('runs manual tests while paused without overlay, config writes or forced activation', async () => {
        const { runtime, host, session, decisions, store } = setup();
        const before = structuredClone(session.mounted);
        await runtime.refreshFeatureSettings();
        await runtime.testConditions();
        expect(decisions.evaluate).toHaveBeenCalledOnce();
        expect(host.getMountedWorldInfoEntries).toHaveBeenCalledOnce();
        expect(session.mounted).toEqual(before);
        expect(store.save).not.toHaveBeenCalled();
        expect(host.emitHostEvent).not.toHaveBeenCalled();
        expect(runtime.state.rounds[0]).toMatchObject({ type: 'test', results: [{ injected: null, passed: true }], outcome: expect.stringContaining('未注入') });
        expect(runtime.state.testBusy).toBe(false);
    });

    it('tests a draft without saving it and refuses tests during armed generation', async () => {
        const { runtime, session, store, decisions, arm } = setup();
        await runtime.selectWorld('Lore');
        const draft = config(0.99);
        await runtime.testConditions(draft);
        expect(runtime.state.rounds[0].results[0]).toMatchObject({ threshold: 0.99, passed: false });
        expect(session.config).toEqual(config());
        expect(store.save).not.toHaveBeenCalled();
        await runtime.activate(); await arm();
        await expect(runtime.testConditions()).rejects.toMatchObject({ code: 'DECISION_TEST_BUSY' });
        expect(decisions.evaluate).toHaveBeenCalledOnce();
    });

    it('refuses a manual test immediately after generation starts, even before commands finish', async () => {
        const { runtime, handlers, decisions, host } = setup();
        await runtime.activate();
        host.isGenerationInProgress.mockReturnValue(true);
        handlers.GENERATION_STARTED();
        await expect(runtime.testConditions()).rejects.toMatchObject({ code: 'DECISION_TEST_BUSY' });
        expect(decisions.evaluate).not.toHaveBeenCalled();
    });

    it('cancels manual tests without mutating mounted entries or leaving the UI busy', async () => {
        const { runtime, session, decisions, log } = setup();
        const before = structuredClone(session.mounted);
        const work = deferred(); decisions.evaluate.mockReturnValue(work.promise);
        const testing = runtime.testConditions();
        const rejected = expect(testing).rejects.toMatchObject({ code: 'DECISION_CANCELLED' });
        await vi.waitFor(() => expect(decisions.evaluate).toHaveBeenCalledOnce());
        runtime.cancelTest();
        work.resolve({ probabilities: new Map([[id(), 0.9]]) });
        await rejected;
        expect(session.mounted).toEqual(before);
        expect(runtime.state.testBusy).toBe(false);
        expect(runtime.state.rounds).toEqual([]);
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith('decision.test_cancelled', expect.any(Object));
    });

    it('offers only System One presets, saves v2 settings and rejects chat-completion selections', async () => {
        const { runtime, host, decisions, arm, scan } = setup();
        await runtime.activate();
        expect(runtime.state.presetOptions).toEqual([{ id: 'p1', name: 'Decision', model: 'jev' }]);
        expect(runtime.state.activePresetId).toBe('p1');
        expect(runtime.state.settings.presetId).toBeNull();
        await runtime.saveSettings({ ...runtime.state.settings, presetId: 'p1', threshold: 0.6 });
        expect(host.globalSet).toHaveBeenCalledWith('world-info-ai-settings-v1', expect.objectContaining({ schemaVersion: 2, presetId: 'p1', threshold: 0.6 }));
        await arm(); await scan();
        expect(decisions.evaluate.mock.calls[0][0].presetId).toBe('p1');
        await expect(runtime.saveSettings({ ...runtime.state.settings, presetId: 'chat' })).rejects.toMatchObject({ code: 'DECISION_PROTOCOL_MISMATCH' });
        await expect(runtime.saveSettings({ ...runtime.state.settings, presetId: 'missing' })).rejects.toMatchObject({ code: 'LLM_PRESET_MISSING' });
    });

    it('does not silently switch a missing selected preset to another model', async () => {
        const { runtime, decisions, arm, scan } = setup({ settings: { schemaVersion: 2, presetId: 'missing', threshold: 0.7, historyRounds: 3, timeoutMs: 10000 } });
        await runtime.activate();
        expect(runtime.state.settings.presetId).toBe('missing');
        expect(runtime.state.presetError).not.toBe('');
        await arm(); const lore = payload(); const before = structuredClone(lore); await scan(lore);
        expect(decisions.evaluate).not.toHaveBeenCalled();
        expect(lore).toEqual(before);
        expect(runtime.state.warning).toMatch(/回退原生/);
    });

    it('keeps invalid settings explicit until the user resets only feature settings', async () => {
        const { runtime, decisions, host, arm, scan } = setup({ settings: null });
        await runtime.activate();
        expect(runtime.state.settingsError).not.toBe('');
        await arm(); await scan();
        expect(decisions.evaluate).not.toHaveBeenCalled();
        await runtime.resetSettings();
        expect(runtime.state.settingsError).toBe('');
        expect(host.globalSet).toHaveBeenCalledExactlyOnceWith('world-info-ai-settings-v1', {
            schemaVersion: 2, presetId: null, threshold: 0.7, historyRounds: 3, timeoutMs: 10000,
        });
        await arm(); await scan();
        expect(decisions.evaluate).toHaveBeenCalledOnce();
    });

    it('counts regular constant/vector entries in the active-world overview', async () => {
        const { runtime } = setup({ payload: payload([entry(1), entry(2, { vectorized: true, constant: true })]) });
        await runtime.refreshWorlds();
        expect(runtime.state.activeWorlds).toEqual([expect.objectContaining({ name: 'Lore', source: 'global',
            routerEnabled: true, configuredAiEntries: 1, eligibleAiEntries: 1 })]);
    });

    it('reports config load failures as recoverable warnings without raw world names or errors', async () => {
        const { runtime, store, log } = setup();
        store.load.mockRejectedValueOnce(new Error('private-request-detail'));
        await expect(runtime.selectWorld('private-world')).rejects.toThrow('private-request-detail');
        expect(log.warn).toHaveBeenCalledWith('config.load_failed', { data: expect.objectContaining({ operation: 'selectWorld', reason: 'DECISION_OPERATION_FAILED', nextAction: expect.any(String) }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private-world|private-request-detail/);
        expect(runtime.state.error).not.toContain('private-request-detail');
        expect(log.error).not.toHaveBeenCalled();
    });
});
