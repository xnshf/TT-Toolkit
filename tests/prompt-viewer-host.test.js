import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { PromptViewerRuntime } from '../src/features/prompt-viewer/runtime.js';
import { WorldInfoImageRuntime } from '../src/features/world-info-images/images.js';

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
    host.scriptModule = { isGenerating: () => false, waitForGenerationIdle: () => Promise.resolve() };
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

    it('positions this assembly’s image relative to sent entries, not empty placeholders', async () => {
        const empty = message('empty', { content: '' });
        const user = message('chatHistory-1', { role: 'user' });
        const assistant = message('chatHistory-2', { role: 'assistant' });
        const agent = message('agentTask');
        const host = makeHost({ promptManagerValue: promptManager([empty, user, assistant, agent]) });
        const image = { role: 'user', content: [{ type: 'text', text: '[世界书图片: 圣殿]' }] };
        const chat = [user, image, assistant, agent];
        host.recordWorldInfoInjectedPromptMessages(chat, [
            { chatMessage: image, identifier: 'worldInfoImage_1', tokens: 90, promptName: '世界书图片（圣殿）' },
        ]);
        const snapshot = await host.readPromptViewerSnapshot({ chat });
        expect(snapshot.messages.map(item => item.identifier)).toEqual(['empty', 'chatHistory-1', 'worldInfoImage_1', 'chatHistory-2']);
        expect(snapshot.messages[2]).toMatchObject({ role: 'user', promptName: '世界书图片（圣殿）', tokens: 90 });
        expect(snapshot.removedAgentItemCount).toBe(1);
        const next = await host.readPromptViewerSnapshot({ chat: [user, assistant, agent] });
        expect(next.messages.map(item => item.identifier)).toEqual(['empty', 'chatHistory-1', 'chatHistory-2']);
    });

    it('fails fast when the prompt manager has no assembled messages', async () => {
        const host = makeHost({ promptManagerValue: promptManager([]) });
        host.openAiModule.promptManager.messages = null;
        await expect(host.readPromptViewerSnapshot()).rejects.toMatchObject({ code: 'PROMPT_MANAGER_UNAVAILABLE' });
    });
});

describe('prompt viewer with world info images', () => {
    it.each([true, false])('captures only this assembly’s images, with viewer enabled first: %s', async viewerFirst => {
        const listeners = new Map();
        const list = name => {
            if (!listeners.has(name))
                listeners.set(name, []);
            return listeners.get(name);
        };
        // Match the host's first/normal registration and serial, awaited dispatch.
        const eventSource = {
            on: (name, listener) => list(name).push(listener),
            makeFirst: (name, listener) => list(name).unshift(listener),
            removeListener: (name, listener) => listeners.set(name, list(name).filter(item => item !== listener)),
            async emit(name, ...args) {
                for (const listener of [...list(name)])
                    await listener(...args);
            },
        };
        const eventTypes = Object.fromEntries([
            'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'CHAT_COMPLETION_PROMPT_READY', 'WORLDINFO_SCAN_DONE',
            'WORLD_INFO_ACTIVATED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED',
        ].map(name => [name, name]));
        const manager = promptManager([]);
        const host = makeHost({ promptManagerValue: manager, contextValue: context({ eventTypes, eventSource }) });
        host.storeGetBlob = async () => new Blob(['fixture'], { type: 'image/png' });
        host.buildWorldInfoImageMessage = async ({ text, images }) => ({
            chatMessage: { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: images[0] } }] },
            tokens: 10,
        });
        const viewer = new PromptViewerRuntime(host, host.log);
        const images = new WorldInfoImageRuntime(host, host.log);
        for (const runtime of viewerFirst ? [viewer, images] : [images, viewer])
            await runtime.activate();

        const assemble = async ({ title, dryRun = false, continued = false } = {}) => {
            const idle = Promise.withResolvers();
            host.scriptModule.waitForGenerationIdle = () => idle.promise;
            const type = continued ? 'continue' : 'normal';
            await eventSource.emit('GENERATION_STARTED', type, {}, dryRun);
            await eventSource.emit('GENERATION_AFTER_COMMANDS', type, {}, dryRun);
            const entry = { world: 'Book', uid: 1, comment: title, extensions: { 'tt-toolkit': { image: {
                schemaVersion: 1, blobKey: `img-${'a'.repeat(64)}.png`, mimeType: 'image/png', sizeBytes: 7,
            } } } };
            await eventSource.emit('WORLDINFO_SCAN_DONE', {
                isFinal: true, isDryRun: dryRun, activated: { entries: new Map(title ? [[1, entry]] : []) },
            });
            const messages = [message('main'), message('chatHistory-1', { role: 'user' })];
            if (continued)
                messages.push(message('chatHistory-2', { role: 'assistant' }));
            manager.messages = { flatten: () => messages };
            const chat = messages.map(({ role, content }) => ({ role, content }));
            await eventSource.emit('CHAT_COMPLETION_PROMPT_READY', { chat, dryRun });
            await eventSource.emit('GENERATION_ENDED');
            idle.resolve();
            return chat;
        };
        const chat = await assemble({ title: '首轮', continued: true });
        expect(chat[2].content[0].text).toBe('[世界书图片: 首轮]');
        expect(viewer.state.snapshot.items.map(item => item.identifier)).toEqual(['main', 'chatHistory-1', 'worldInfoImage_1', 'chatHistory-2']);
        expect(viewer.exportText('sent')).toContain('[世界书图片: 首轮]');
        expect(viewer.exportText('sent')).toContain('[图片附件: image/png]');
        expect(viewer.exportText('sent')).not.toContain('base64');

        // An unrelated dry run is ignored by the viewer and must not feed a later prediction.
        await assemble({ title: '其它预测', dryRun: true });
        document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
        manager.tryGenerate = () => assemble({ title: '当前预测', dryRun: true });
        await viewer.predict('假设输入');
        expect(viewer.exportText('prediction')).toContain('[世界书图片: 当前预测]');
        expect(viewer.exportText('prediction')).not.toContain('其它预测');
        expect(viewer.exportText('sent')).toContain('[世界书图片: 首轮]');

        await assemble();
        expect(viewer.state.snapshot.items.map(item => item.identifier)).toEqual(['main', 'chatHistory-1']);
        await assemble({ title: '图片功能关闭前' });
        images.deactivate();
        const afterDisabled = await assemble({ title: '图片功能关闭后' });
        expect(afterDisabled).toHaveLength(2);
        expect(viewer.state.snapshot.items.map(item => item.identifier)).toEqual(['main', 'chatHistory-1']);
        await viewer.deactivate();
        expect(list('CHAT_COMPLETION_PROMPT_READY')).toHaveLength(0);
    });
});

describe('prompt viewer dry run', () => {
    it('recovers after an early exit without an end event and does not touch input during host cleanup', async () => {
        const idle = Promise.withResolvers();
        const manager = promptManager([]);
        const host = makeHost({ promptManagerValue: manager });
        host.scriptModule.waitForGenerationIdle = () => idle.promise;
        const events = {};
        host.onHostEvent = (name, callback) => { events[name] = callback; return () => { delete events[name]; }; };
        const viewer = new PromptViewerRuntime(host, host.log);
        await viewer.activate();
        document.body.innerHTML = '<textarea id="send_textarea">original</textarea>';
        const input = document.querySelector('textarea');
        manager.tryGenerate = vi.fn(async () => {
            expect(input.value).toBe('hypothetical');
            await events.CHAT_COMPLETION_PROMPT_READY({ chat: [], dryRun: true });
        });
        expect(events.GENERATION_AFTER_COMMANDS('normal', {}, false)).toBeUndefined();
        await expect(viewer.predict('hypothetical')).rejects.toMatchObject({ code: 'PROMPT_VIEWER_BUSY' });
        events.GENERATION_STOPPED();
        await expect(viewer.predict('hypothetical')).rejects.toMatchObject({ code: 'PROMPT_VIEWER_BUSY' });
        expect(input.value).toBe('original');
        expect(manager.tryGenerate).not.toHaveBeenCalled();
        // Another early attempt after commands produces neither END nor STOP.
        events.GENERATION_AFTER_COMMANDS('normal', {}, false);
        idle.resolve();
        await idle.promise;
        await expect(viewer.predict('hypothetical')).resolves.toMatchObject({ kind: 'prediction' });
        expect(input.value).toBe('original');
        expect(viewer.state.snapshot).toBeNull();
    });

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
