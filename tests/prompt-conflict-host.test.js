import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';

function context(overrides = {}) {
    return {
        chat: [],
        chatMetadata: { world_info: 'ChatBook' },
        powerUserSettings: { persona_description_lorebook: 'PersonaBook' },
        characterId: 0,
        characters: [{ avatar: 'alice.png', data: { extensions: { world: 'CharBook' } } }],
        ...overrides,
    };
}

function makeHost(options = {}) {
    const host = new TauriTavernHost();
    host.log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    host.contextModule = { getContext: () => context(options.context) };
    host.worldInfoModule = options.worldInfoModule ?? {
        selected_world_info: ['GlobalBook'],
        world_info: { charLore: [{ name: 'alice', extraBooks: ['ExtraBook'] }] },
        worldInfoCache: {
            get: name => options.cache?.[name] ?? { entries: { 1: { uid: 1, content: `content-${name}` } } },
        },
    };
    host.openAiModule = options.openAiModule ?? null;
    host.scriptModule = { substituteParams: text => String(text).replaceAll('{{user}}', '小明') };
    return host;
}

function promptManager() {
    const prompts = {
        main: { identifier: 'main', name: 'Main', role: 'system', injection_position: 0, injection_order: 100, content: '你是 {{char}}。' },
        disabled: { identifier: 'disabled', name: 'Disabled', role: 'system', content: '不应出现' },
        marker: { identifier: 'chatHistory', name: 'History', role: 'user', marker: true, content: 'marker body' },
        empty: { identifier: 'empty', name: 'Empty', content: '   ' },
        triggered: { identifier: 'triggered', name: 'Triggered', injection_trigger: ['continue'], content: '只在继续时' },
    };
    return {
        activeCharacter: { id: 100001 },
        getPromptOrderForCharacter: () => [
            { identifier: 'main', enabled: true },
            { identifier: 'disabled', enabled: false },
            { identifier: 'marker', enabled: true },
            { identifier: 'empty', enabled: true },
            { identifier: 'triggered', enabled: true },
            { identifier: 'missing', enabled: true },
        ],
        getPromptById: identifier => prompts[identifier],
        shouldTrigger: (prompt, generationType) => {
            if (!Array.isArray(prompt?.injection_trigger))
                return true;
            return prompt.injection_trigger.includes(generationType);
        },
        preparePrompt: prompt => ({ content: String(prompt.content ?? '').replaceAll('{{char}}', 'Alice') }),
    };
}

describe('prompt conflict preset source collection', () => {
    it('collects only enabled, non-marker, non-empty prompts that trigger for normal generation', async () => {
        const host = makeHost();
        host.openAiModule = { promptManager: promptManager() };
        const sources = await host.getPromptConflictPresetSources();
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({
            identifier: 'main',
            label: 'Main',
            role: 'system',
            position: 0,
            order: 100,
            content: '你是 Alice。',
        });
    });

    it('fails fast when the live prompt manager is unavailable or missing methods', async () => {
        const host = makeHost();
        host.openAiModule = { promptManager: null };
        await expect(host.getPromptConflictPresetSources()).rejects.toMatchObject({ code: 'PROMPT_MANAGER_UNAVAILABLE' });
        host.openAiModule = { promptManager: { getPromptById: null } };
        await expect(host.getPromptConflictPresetSources()).rejects.toMatchObject({ code: 'HOST_EXPORT_MISSING' });
    });

    it('lazily imports the openai module on first use and reuses it', async () => {
        const host = makeHost();
        const loaded = { promptManager: promptManager() };
        host.dynamicImport = vi.fn(() => loaded);
        expect(await host.openAiPromptManager()).toBe(loaded.promptManager);
        expect(await host.openAiPromptManager()).toBe(loaded.promptManager);
        expect(host.dynamicImport).toHaveBeenCalledOnce();
    });
});

describe('mounted world info entries', () => {
    it('reassembles the four lore groups from the cache and bindings with world stamps', async () => {
        const host = makeHost({
            cache: {
                GlobalBook: { entries: { 1: { uid: 1, content: 'g' } } },
                CharBook: { entries: { 2: { uid: 'x', content: 'c' } } },
                ExtraBook: { entries: { 3: { uid: 3, content: 'e' } } },
                ChatBook: { entries: { 4: { uid: 4, content: 't' } } },
                PersonaBook: { entries: { 5: { uid: 5, content: 'p' } } },
            },
        });
        const groups = await host.getMountedWorldInfoEntries();
        expect(groups.globalLore.map(entry => entry.world)).toEqual(['GlobalBook']);
        expect(groups.characterLore.map(entry => entry.world)).toEqual(['CharBook', 'ExtraBook']);
        expect(groups.chatLore.map(entry => entry.world)).toEqual(['ChatBook']);
        expect(groups.personaLore.map(entry => entry.world)).toEqual(['PersonaBook']);
        expect(groups.globalLore[0].uid).toBe(1);
        expect(groups.characterLore[0].uid).toBe('x');
    });

    it('fails fast without the world info cache access', async () => {
        const host = makeHost({ worldInfoModule: { selected_world_info: [], world_info: {} } });
        await expect(host.getMountedWorldInfoEntries()).rejects.toMatchObject({ code: 'HOST_EXPORT_MISSING' });
    });
});

describe('prompt conflict invalidation subscription', () => {
    it('subscribes the five source events and unsubscribes symmetrically', () => {
        const host = makeHost();
        const events = {};
        host.onHostEvent = vi.fn((name, handler) => {
            events[name] = handler;
            return () => { delete events[name]; };
        });
        const listener = vi.fn();
        const dispose = host.subscribePromptConflictSourceInvalidation(listener);
        expect(host.onHostEvent).toHaveBeenCalledTimes(5);
        for (const name of ['SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'CHAT_CHANGED'])
            expect(events[name]).toBeInstanceOf(Function);
        events.OAI_PRESET_CHANGED_AFTER('arg');
        expect(listener).toHaveBeenCalledWith({ type: 'OAI_PRESET_CHANGED_AFTER', args: ['arg'] });
        dispose();
        expect(Object.keys(events)).toHaveLength(0);
    });
});

describe('prompt conflict chat metadata adapter', () => {
    it('reads and writes only the prompt-conflict namespace', async () => {
        const host = makeHost();
        host.chatExtensionGet = vi.fn(async () => ({ schemaVersion: 1, disabledWorldEntries: [] }));
        host.chatExtensionSet = vi.fn(async () => undefined);
        await expect(host.getPromptConflictChatMetadata()).resolves.toEqual({ schemaVersion: 1, disabledWorldEntries: [] });
        expect(host.chatExtensionGet).toHaveBeenCalledWith('tt-toolkit.prompt-conflict');
        await host.setPromptConflictChatMetadata('chat-1', { schemaVersion: 1, disabledWorldEntries: [] });
        expect(host.chatExtensionSet).toHaveBeenCalledWith('chat-1', 'tt-toolkit.prompt-conflict', { schemaVersion: 1, disabledWorldEntries: [] });
    });
});
