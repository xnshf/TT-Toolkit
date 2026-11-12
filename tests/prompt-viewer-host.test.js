import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';

function context(overrides = {}) {
    return {
        chat: [],
        mainApi: 'openai',
        groupId: null,
        name2: 'Alice',
        chatCompletionSettings: {
            openai_max_context: 8000,
            openai_max_tokens: 500,
            chat_completion_source: 'custom',
        },
        getChatCompletionModel: () => 'gpt-x',
        ...overrides,
    };
}

function message(identifier, overrides = {}) {
    return {
        identifier,
        role: 'system',
        content: `content-${identifier}`,
        tokens: 2,
        name: null,
        tool_calls: null,
        signature: null,
        reasoning: null,
        reasoningContent: null,
        native: null,
        ...overrides,
    };
}

function promptManager(messages, overrides = {}) {
    return {
        messages: { flatten: () => messages },
        getPromptById: identifier => (identifier === 'main' ? { name: 'Main Prompt' } : null),
        serviceSettings: { squash_system_messages: false },
        tokenHandler: { counts: { main: 2, chatHistory: 4 } },
        tryGenerate: vi.fn(async () => undefined),
        ...overrides,
    };
}

function makeHost({ promptManagerValue = promptManager([message('main')]), contextValue = context() } = {}) {
    const host = new TauriTavernHost();
    host.log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    host.contextModule = { getContext: () => contextValue };
    host.openAiModule = promptManagerValue === null ? null : { promptManager: promptManagerValue };
    if (promptManagerValue === null)
        host.dynamicImport = () => ({ promptManager: null });
    return host;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('prompt viewer host status', () => {
    it('reports chat-completion info and prompt manager readiness', async () => {
        const host = makeHost();
        const status = await host.promptViewerStatus();
        expect(status).toMatchObject({
            mainApi: 'openai',
            model: 'gpt-x',
            source: 'custom',
            tokenBudget: { maxContext: 8000, maxTokens: 500 },
            isGroup: false,
            characterName: 'Alice',
            promptManagerReady: true,
        });
    });

    it('fails soft when the prompt manager is unavailable', async () => {
        const host = makeHost({ promptManagerValue: null });
        const status = await host.promptViewerStatus();
        expect(status.promptManagerReady).toBe(false);
        expect(status.reason).toBe('PROMPT_MANAGER_UNAVAILABLE');
    });
});

describe('prompt viewer snapshot projection', () => {
    it('projects messages, filters agent-only identifiers and reports counts', async () => {
        const host = makeHost({
            promptManagerValue: promptManager([
                message('main'),
                message('agentSystemPrompt', { content: 'agent' }),
                message('chatHistory-1', { role: 'user' }),
                message('agentTask'),
            ], { serviceSettings: { squash_system_messages: true } }),
        });
        const snapshot = await host.readPromptViewerSnapshot();
        expect(snapshot.messages.map(item => item.identifier)).toEqual(['main', 'chatHistory-1']);
        expect(snapshot.removedAgentItemCount).toBe(2);
        expect(snapshot.squashSystemMessages).toBe(true);
        expect(snapshot.messages[0]).toMatchObject({ identifier: 'main', promptName: 'Main Prompt', tokens: 2 });
    });

    it('merges injected world-info image messages at their recorded index', async () => {
        const host = makeHost({
            promptManagerValue: promptManager([message('main'), message('chatHistory-1', { role: 'user' })]),
        });
        host.recordWorldInfoInjectedPromptMessages([
            { identifier: 'worldInfoImage_1', role: 'user', content: [{ type: 'text', text: '[世界书图片: 圣殿]' }], tokens: 90, insertIndex: 2, promptName: '世界书图片（圣殿）' },
        ], { dryRun: false });
        const snapshot = await host.readPromptViewerSnapshot({ dryRun: false });
        expect(snapshot.messages.map(item => item.identifier)).toEqual(['main', 'chatHistory-1', 'worldInfoImage_1']);
        expect(snapshot.messages[2]).toMatchObject({ role: 'user', promptName: '世界书图片（圣殿）', tokens: 90 });
        // 发送轮的清单不会串到预测轮。
        const prediction = await host.readPromptViewerSnapshot({ dryRun: true });
        expect(prediction.messages.map(item => item.identifier)).toEqual(['main', 'chatHistory-1']);
    });

    it('counts only removed agent messages in the removedAgentItemCount', async () => {
        const host = makeHost({
            promptManagerValue: promptManager([message('main'), message('agentTask')]),
        });
        host.recordWorldInfoInjectedPromptMessages([{ identifier: 'worldInfoImage_1', insertIndex: 1 }], { dryRun: false });
        const snapshot = await host.readPromptViewerSnapshot({ dryRun: false });
        expect(snapshot.removedAgentItemCount).toBe(1);
        expect(snapshot.messages).toHaveLength(2);
    });

    it('fails fast when the prompt manager has no assembled messages', async () => {
        const host = makeHost({ promptManagerValue: promptManager([]) });
        host.openAiModule.promptManager.messages = null;
        await expect(host.readPromptViewerSnapshot()).rejects.toMatchObject({ code: 'PROMPT_MANAGER_UNAVAILABLE' });
    });
});

describe('prompt viewer dry run', () => {
    it('restores textarea value, selection and token counts on success', async () => {
        document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
        const textarea = document.querySelector('#send_textarea');
        textarea.value = 'original';
        textarea.setSelectionRange(1, 3);
        const manager = promptManager([message('main')]);
        manager.tryGenerate = vi.fn(async () => {
            expect(textarea.value).toBe('hypothetical');
            manager.tokenHandler.counts.main = 999;
        });
        const host = makeHost({ promptManagerValue: manager });
        await host.runPromptViewerDryRun('hypothetical');
        expect(manager.tryGenerate).toHaveBeenCalledOnce();
        expect(textarea.value).toBe('original');
        expect(textarea.selectionStart).toBe(1);
        expect(textarea.selectionEnd).toBe(3);
        expect(manager.tokenHandler.counts).toEqual({ main: 2, chatHistory: 4 });
    });

    it('restores textarea and counts when the dry run throws', async () => {
        document.body.innerHTML = '<textarea id="send_textarea">original</textarea>';
        const manager = promptManager([]);
        manager.tryGenerate = vi.fn(async () => {
            manager.tokenHandler.counts.main = 42;
            throw new Error('dry run failed');
        });
        const host = makeHost({ promptManagerValue: manager });
        await expect(host.runPromptViewerDryRun('next')).rejects.toThrow('dry run failed');
        expect(document.querySelector('#send_textarea').value).toBe('original');
        expect(manager.tokenHandler.counts).toEqual({ main: 2, chatHistory: 4 });
    });

    it('fails fast when the host textarea is missing', async () => {
        const host = makeHost();
        await expect(host.runPromptViewerDryRun('x')).rejects.toMatchObject({ code: 'PROMPT_VIEWER_INPUT_UNAVAILABLE' });
    });
});

describe('prompt viewer event subscription', () => {
    function setup() {
        const host = makeHost();
        const events = {};
        const disposers = [];
        host.onHostEvent = vi.fn((name, handler) => {
            events[name] = handler;
            const dispose = vi.fn(() => { delete events[name]; });
            disposers.push(dispose);
            return dispose;
        });
        return { host, events, disposers };
    }

    it('validates and forwards prompt, world info and lifecycle events', () => {
        const { host, events } = setup();
        const handlers = {
            onGenerationStart: vi.fn(),
            onPromptReady: vi.fn(() => Promise.resolve()),
            onWorldInfoActivated: vi.fn(),
            onWorldInfoScan: vi.fn(),
            onGenerationStopped: vi.fn(),
            onGenerationEnded: vi.fn(),
            onChatChanged: vi.fn(),
            onContractError: vi.fn(),
        };
        host.subscribePromptViewerEvents(handlers);

        events.GENERATION_AFTER_COMMANDS('normal', {}, false);
        expect(handlers.onGenerationStart).toHaveBeenCalledWith({ type: 'normal', dryRun: false });

        const readyResult = events.CHAT_COMPLETION_PROMPT_READY({ chat: [{ role: 'system' }], dryRun: false });
        expect(handlers.onPromptReady).toHaveBeenCalledWith({ chat: [{ role: 'system' }], dryRun: false });
        expect(readyResult).toBeInstanceOf(Promise);

        events.WORLD_INFO_ACTIVATED([{ uid: 1 }]);
        expect(handlers.onWorldInfoActivated).toHaveBeenCalledWith([{ uid: 1 }]);

        events.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: true, activated: { entries: new Map([[1, { uid: 1 }]]) } });
        expect(handlers.onWorldInfoScan).toHaveBeenCalledWith({ isFinal: true, isDryRun: true, entries: [{ uid: 1 }] });

        events.GENERATION_STOPPED();
        events.GENERATION_ENDED(3);
        events.CHAT_CHANGED();
        expect(handlers.onGenerationStopped).toHaveBeenCalledOnce();
        expect(handlers.onGenerationEnded).toHaveBeenCalledOnce();
        expect(handlers.onChatChanged).toHaveBeenCalledOnce();
    });

    it('routes invalid payloads to the contract error handler instead of throwing', () => {
        const { host, events } = setup();
        const handlers = { onPromptReady: vi.fn(), onWorldInfoActivated: vi.fn(), onWorldInfoScan: vi.fn(), onContractError: vi.fn() };
        host.subscribePromptViewerEvents(handlers);
        expect(() => events.CHAT_COMPLETION_PROMPT_READY({ chat: null, dryRun: false })).not.toThrow();
        expect(() => events.WORLD_INFO_ACTIVATED('nope')).not.toThrow();
        expect(() => events.WORLDINFO_SCAN_DONE({ isFinal: true })).not.toThrow();
        expect(handlers.onPromptReady).not.toHaveBeenCalled();
        expect(handlers.onContractError).toHaveBeenCalledTimes(3);
    });

    it('disposes every subscription', () => {
        const { host, disposers } = setup();
        const dispose = host.subscribePromptViewerEvents({});
        dispose();
        for (const item of disposers)
            expect(item).toHaveBeenCalledOnce();
    });
});
