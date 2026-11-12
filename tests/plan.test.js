import { describe, expect, it } from 'vitest';
import { buildOperationPlan } from '../src/features/chat-cleaner/plan.js';
import { createDefaultProgress, createDefaultSettings } from '../src/features/chat-cleaner/schema.js';
const identity = { stableId: 'chat-1', label: 'Test chat', ref: { kind: 'character' } };
function assistant(swipes, current = 0, reasoning = []) {
    return {
        is_user: false,
        is_system: false,
        mes: swipes[current],
        swipes,
        swipe_id: current,
        extra: reasoning[current] === undefined ? {} : { reasoning: reasoning[current], reasoning_duration: 4, reasoning_signature: 'keep' },
        swipe_info: swipes.map((_, index) => ({ extra: reasoning[index] === undefined ? {} : { reasoning: reasoning[index], reasoning_type: 'parsed', reasoning_signature: 'keep' } })),
    };
}
describe('operation plan', () => {
    it('cleans all swipes and the current projection while tolerating missing reasoning', () => {
        const settings = createDefaultSettings();
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const message = assistant(['a<x>1</x>b', 'c<x>2</x>d'], 1, ['thought', undefined]);
        const plan = buildOperationPlan({ identity, messages: [message] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]?.bodyPatches.map(patch => patch.after)).toEqual(['ab', 'cd']);
        expect(plan.changes[0]?.reasoningPatches).toHaveLength(1);
        expect(plan.stats.bodyRemovedChars).toBe(16);
    });
    it('separately cleans the stored swipe and expanded mes projection of a character greeting', () => {
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const message = {
            ...assistant(['Hello {{user}} <x>raw</x>']),
            is_system: true,
            mes: 'Hello Alice <x>expanded</x>',
        };
        const plan = buildOperationPlan({ identity, messages: [message] }, settings, {
            mode: 'manual',
            keep: 0,
            progress: createDefaultProgress(),
        });

        expect(plan.changes[0]?.bodyPatches).toEqual([
            expect.objectContaining({
                swipeIndex: 0,
                before: 'Hello {{user}} <x>raw</x>',
                after: 'Hello {{user}} ',
                updateTopProjection: false,
            }),
            expect.objectContaining({
                swipeIndex: null,
                before: 'Hello Alice <x>expanded</x>',
                after: 'Hello Alice ',
                updateTopProjection: true,
            }),
        ]);
    });
    it('preserves a divergent body outside the greeting without blocking other floors', () => {
        const settings = createDefaultSettings();
        const divergent = { ...assistant(['stored']), mes: 'projected' };
        const plan = buildOperationPlan({ identity, messages: [
            { is_user: true, mes: 'known user' }, divergent, assistant(['readable'], 0, ['remove']),
        ] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes.map(change => change.messageIndex)).toEqual([2]);
        expect(plan.issues).toContainEqual(expect.objectContaining({ messageIndex: 1, reason: 'projection-diverged' }));
        expect(plan.warnings.join()).toMatch(/mes 与当前 swipe 正文不一致/);
    });
    it('skips null/non-string swipes locally with safe diagnostics and retry watermarks', () => {
        const settings = createDefaultSettings();
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const plan = buildOperationPlan({ identity, messages: [assistant(['a<x>1</x>', null, 42, 'b<x>2</x>'])] }, settings,
            { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes[0].bodyPatches.map(patch => patch.swipeIndex)).toEqual([0, 3]);
        expect(plan.issues).toEqual([
            expect.objectContaining({ messageIndex: 0, swipeIndex: 1, actualType: 'null', expected: 'string', reason: 'swipe-body-type-invalid' }),
            expect.objectContaining({ messageIndex: 0, swipeIndex: 2, actualType: 'number', expected: 'string' }),
        ]);
        expect(plan.nextProgress.assistantThrough).toBe(-1);
        expect(plan.stats.degradedMessages).toBe(1);
    });
    it('plans candidate deletion alone for both roles while respecting keep/system exclusions', () => {
        const settings = createDefaultSettings();
        settings.clearSwipes = true;
        settings.deleteNativeReasoning = false;
        settings.assistant.enabled = false;
        const messages = [assistant(['old', 'selected'], 1),
            { ...assistant(['user-old', 'user-selected'], 1), is_user: true },
            assistant(['new-old', 'new-selected'], 1),
            { ...assistant(['system-old', 'system-selected'], 1), extra: { type: 'generic' } }];
        const plan = buildOperationPlan({ identity, messages }, settings, { mode: 'manual', keep: 1, progress: createDefaultProgress() });
        expect(plan.changes.map(change => change.messageIndex)).toEqual([0]);
        expect(plan.changes[0]).toMatchObject({ bodyPatches: [], reasoningPatches: [], clearSwipesPatch: { currentSwipe: 1, removedCount: 1 } });
        const all = buildOperationPlan({ identity, messages }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(all.changes.map(change => change.messageIndex)).toEqual([0, 1, 2]);
        expect(all.stats.removedSwipes).toBe(3);
    });
    it('does not shorten unhydrated cold arrays or guess invalid current indexes', () => {
        const settings = createDefaultSettings();
        settings.clearSwipes = true;
        settings.deleteNativeReasoning = false;
        const cold = { ...assistant(['current', null]), tt_swipe_cold: { sourceId: 1, record: 1 } };
        const bad = { ...assistant(['a', 'b']), swipe_id: null };
        const plan = buildOperationPlan({ identity, messages: [cold, bad] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes).toEqual([]);
        expect(plan.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: 'cold-swipes-not-hydrated' }), expect.objectContaining({ reason: 'current-swipe-invalid' }),
        ]));
    });
    it('keeps malformed floors and malformed candidate metadata local', () => {
        const settings = createDefaultSettings();
        settings.clearSwipes = true;
        const badInfo = { ...assistant(['a', 'b']), swipe_info: { unknown: true } };
        const plan = buildOperationPlan({ identity, messages: [null, badInfo, assistant(['safe'], 0, ['remove'])] }, settings,
            { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes.map(change => change.messageIndex)).toEqual([2]);
        expect(plan.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: 'message-type-invalid', messageIndex: 0 }),
            expect.objectContaining({ reason: 'swipe-info-invalid', messageIndex: 1 }),
        ]));
    });
    it('separately keeps recent assistant and user messages', () => {
        const settings = createDefaultSettings();
        settings.user.enabled = true;
        settings.user.rules.push({ id: 'u', enabled: true, start: '[', end: ']' });
        const messages = [
            { is_user: true, mes: '[u1]' }, assistant(['a1'], 0, ['r1']),
            { is_user: true, mes: '[u2]' }, assistant(['a2'], 0, ['r2']),
            { is_user: false, is_system: true, mes: '[system]', extra: { type: 'generic' } },
        ];
        const plan = buildOperationPlan({ identity, messages }, settings, { mode: 'manual', keep: 1, progress: createDefaultProgress() });
        expect(plan.targetIndexes).toEqual([0, 1]);
    });
    it('manually scans every non-system floor even when its role has no active rule', () => {
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.assistant.rules.push({ id: 'a', enabled: true, start: '<x>', end: '</x>' });
        const messages = [
            { is_user: true, mes: 'user without an active rule' },
            { is_user: false, mes: 'assistant <x>remove</x> without swipes' },
            { is_user: false, is_system: true, mes: 'system <x>keep</x>', extra: { type: 'generic' } },
        ];
        const plan = buildOperationPlan({ identity, messages }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.targetIndexes).toEqual([0, 1]);
        expect(plan.stats.scannedMessages).toBe(2);
        expect(plan.stats.totalMessages).toBe(3);
        expect(plan.stats.eligibleMessages).toBe(2);
        expect(plan.stats.excludedSystemMessages).toBe(1);
        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]?.bodyPatches).toEqual(expect.arrayContaining([
            expect.objectContaining({ swipeIndex: null, after: 'assistant  without swipes' }),
        ]));
    });
    it('includes hidden and compact ordinary messages while excluding explicit system and tool messages', () => {
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.user.enabled = true;
        settings.user.rules.push({ id: 'u', enabled: true, start: '<u>', end: '</u>' });
        settings.assistant.rules.push({ id: 'a', enabled: true, start: '<a>', end: '</a>' });
        const hiddenUser = { is_user: true, is_system: true, mes: 'user <u>remove</u>', extra: { isSmallSys: true } };
        const hiddenAssistant = { ...assistant(['assistant <a>remove</a>']), is_system: true };
        const compactAssistant = { is_user: false, is_system: false, mes: 'compact <a>remove</a>', extra: { isSmallSys: true } };
        const system = { is_user: false, is_system: true, mes: 'system <a>keep</a>', extra: { type: 'welcome_prompt', uses_system_ui: true } };
        const tool = { is_user: false, is_system: true, mes: 'tool <a>keep</a>', extra: { isSmallSys: true, tool_invocations: [{ name: 'test' }] } };
        const plan = buildOperationPlan({ identity, messages: [hiddenUser, hiddenAssistant, compactAssistant, system, tool] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.targetIndexes).toEqual([0, 1, 2]);
        expect(plan.changes.map(change => change.messageIndex)).toEqual([0, 1, 2]);
        expect(plan.stats).toMatchObject({
            totalMessages: 5,
            eligibleMessages: 3,
            excludedSystemMessages: 1,
            excludedToolMessages: 1,
            hiddenEligibleMessages: 2,
            compactEligibleMessages: 2,
            scannedMessages: 3,
        });
    });
    it('cleans a legacy character greeting marked as system at absolute floor zero', () => {
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.assistant.rules.push({ id: 'a', enabled: true, start: '<a>', end: '</a>' });
        const messages = [
            { is_user: false, is_system: true, name: 'Char', mes: 'greeting <a>remove</a>', extra: {} },
            { is_user: false, is_system: true, mes: 'system <a>keep</a>', extra: { type: 'generic' } },
        ];
        const plan = buildOperationPlan({ identity, messages }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.targetIndexes).toEqual([0]);
        expect(plan.changes).toEqual([
            expect.objectContaining({
                messageIndex: 0,
                role: 'assistant',
                bodyPatches: [expect.objectContaining({ swipeIndex: null, after: 'greeting ' })],
            }),
        ]);
        expect(plan.stats).toMatchObject({ eligibleMessages: 1, excludedSystemMessages: 1, hiddenEligibleMessages: 1 });
    });
    it('cleans hidden messages without assistant provenance in character and group chats', () => {
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.assistant.rules.push({ id: 'a', enabled: true, start: '<a>', end: '</a>' });
        const messages = [
            { is_user: true, mes: 'known user' },
            { is_user: false, is_system: true, mes: 'hidden <a>remove</a>' },
        ];
        for (const kind of ['character', 'group']) {
            const chatIdentity = { stableId: 'chat-1', ref: { kind } };
            const plan = buildOperationPlan({ identity: chatIdentity, messages }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
            expect(plan.targetIndexes).toEqual([0, 1]);
            expect(plan.stats).toMatchObject({ eligibleMessages: 2, hiddenEligibleMessages: 1, excludedSystemMessages: 0 });
            expect(plan.changes[0]).toMatchObject({ messageIndex: 1, role: 'assistant', bodyPatches: [{ after: 'hidden ', swipeIndex: null }] });
        }
    });
    it('records empty swipes for manual confirmation', () => {
        const settings = createDefaultSettings();
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const plan = buildOperationPlan({ identity, messages: [assistant(['<x>all</x>'])] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes[0]?.emptySwipeIndexes).toEqual([0]);
    });
    it('establishes a baseline on first auto run and ignores in-place content edits', () => {
        const settings = createDefaultSettings();
        const first = buildOperationPlan({ identity, messages: [assistant(['a'])] }, settings, { mode: 'auto', progress: createDefaultProgress() });
        expect(first.baselineOnly).toBe(true);
        expect(first.baselineReason).toBe('first-run');
        const edited = buildOperationPlan({ identity, messages: [assistant(['user manually edited content'])] }, settings, { mode: 'auto', progress: first.nextProgress });
        expect(edited.baselineOnly).toBe(false);
        expect(edited.baselineReason).toBe(null);
        expect(edited.rollback.assistant).toBe(false);
        expect(edited.rollback.user).toBe(false);
    });
    it('automatically cleans eligible assistant and user messages without swipes', () => {
        const settings = createDefaultSettings();
        settings.deleteNativeReasoning = false;
        settings.auto.keepAssistant = 1;
        settings.auto.keepUser = 1;
        settings.assistant.rules.push({ id: 'a', enabled: true, start: '<a>', end: '</a>' });
        settings.user.enabled = true;
        settings.user.rules.push({ id: 'u', enabled: true, start: '<u>', end: '</u>' });
        const initialMessages = [
            { is_user: true, mes: 'user <u>remove</u>' },
            { is_user: false, mes: 'assistant <a>remove</a>' },
        ];
        const baseline = buildOperationPlan({ identity, messages: initialMessages }, settings, { mode: 'auto', progress: createDefaultProgress() });
        const messages = [
            ...initialMessages,
            { is_user: true, mes: 'latest user' },
            { is_user: false, mes: 'latest assistant' },
        ];
        const plan = buildOperationPlan({ identity, messages }, settings, { mode: 'auto', progress: baseline.nextProgress });
        expect(plan.baselineOnly).toBe(false);
        expect(plan.targetIndexes).toEqual([0, 1]);
        expect(plan.stats.scannedMessages).toBe(2);
        expect(plan.changes.map(change => change.bodyPatches[0]?.swipeIndex)).toEqual([null, null]);
        expect(plan.changes.map(change => change.bodyPatches[0]?.after)).toEqual(['user ', 'assistant ']);
    });
    it('preserves malformed reasoning while cleaning readable bodies', () => {
        const settings = createDefaultSettings();
        settings.assistant.rules.push({ id: 'r', enabled: true, start: '<x>', end: '</x>' });
        const plan = buildOperationPlan({ identity, messages: [{ ...assistant(['a<x>b</x>']), extra: { reasoning: 4 } }] }, settings,
            { mode: 'manual', keep: 0, progress: createDefaultProgress() });
        expect(plan.changes[0].bodyPatches[0].after).toBe('a');
        expect(plan.changes[0].reasoningPatches).toEqual([]);
        expect(plan.issues[0]).toMatchObject({ field: 'extra.reasoning', actualType: 'number', expected: 'string' });
        expect(() => buildOperationPlan({ identity, messages: [assistant(['a'])] }, settings, { mode: 'manual', keep: 0, progress: createDefaultProgress() })).not.toThrow();
    });
    it('rolls back an assistant watermark when tail messages were deleted out of bounds', () => {
        const settings = createDefaultSettings();
        settings.auto.keepAssistant = 1;
        const messages = [0, 1, 2, 3, 4, 5, 6, 7].map(index => assistant([`m${index}`]));
        const baseline = buildOperationPlan({ identity, messages }, settings, { mode: 'auto', progress: createDefaultProgress() });
        expect(baseline.baselineOnly).toBe(true);
        expect(baseline.nextProgress.assistantThrough).toBe(6);
        const intact = buildOperationPlan({ identity, messages }, settings, { mode: 'auto', progress: baseline.nextProgress });
        expect(intact.rollback.assistant).toBe(false);
        const deleted = messages.slice(0, 4);
        const rolled = buildOperationPlan({ identity, messages: deleted }, settings, { mode: 'auto', progress: baseline.nextProgress });
        expect(rolled.rollback.assistant).toBe(true);
        expect(rolled.baselineOnly).toBe(false);
        expect(rolled.targetIndexes).toEqual([0, 1, 2]);
        expect(rolled.nextProgress.assistantThrough).toBe(2);
    });
    it('ignores deletions that keep the watermark inside bounds', () => {
        const settings = createDefaultSettings();
        settings.auto.keepAssistant = 1;
        const messages = [0, 1, 2, 3, 4, 5].map(index => assistant([`m${index}`]));
        const baseline = buildOperationPlan({ identity, messages }, settings, { mode: 'auto', progress: createDefaultProgress() });
        expect(baseline.nextProgress.assistantThrough).toBe(4);
        const shifted = [messages[0], messages[2], messages[3], messages[4], messages[5]];
        const plan = buildOperationPlan({ identity, messages: shifted }, settings, { mode: 'auto', progress: baseline.nextProgress });
        expect(plan.rollback.assistant).toBe(false);
        expect(plan.baselineOnly).toBe(false);
    });
    it('rolls back each role watermark independently', () => {
        const settings = createDefaultSettings();
        settings.auto.keepAssistant = 5;
        settings.auto.keepUser = 1;
        const messages = [
            assistant(['a0']), { is_user: true, mes: 'u1' }, assistant(['a2']),
            { is_user: true, mes: 'u3' }, assistant(['a4']), { is_user: true, mes: 'u5' },
            assistant(['a6']), { is_user: true, mes: 'u7' }, assistant(['a8']),
        ];
        const baseline = buildOperationPlan({ identity, messages }, settings, { mode: 'auto', progress: createDefaultProgress() });
        expect(baseline.nextProgress.assistantThrough).toBe(-1);
        expect(baseline.nextProgress.userThrough).toBe(5);
        const truncated = [messages[0], messages[1], messages[2], messages[3], messages[4]];
        const plan = buildOperationPlan({ identity, messages: truncated }, settings, { mode: 'auto', progress: baseline.nextProgress });
        expect(plan.rollback.assistant).toBe(false);
        expect(plan.rollback.user).toBe(true);
    });
});
