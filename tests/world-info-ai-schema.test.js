import { describe, expect, it, vi } from 'vitest';
import {
    createDefaultWorldInfoAiConfig,
    createDefaultWorldInfoAiFeatureSettings,
    detectPromptTemplateEntry,
    embedWorldInfoAiConfig,
    isAiModeEligible,
    parseConfigExchange,
    parseWorldInfoAiConfig,
    parseWorldInfoAiFeatureSettings,
    readEmbeddedWorldInfoAiConfig,
    serializeConfigExchange,
    worldEntryKey,
} from '../src/features/world-info-ai/schema.js';
import { WorldInfoAiConfigStore, worldInfoFallbackKey } from '../src/features/world-info-ai/storage.js';

function config() {
    return {
        schemaVersion: 2,
        enabled: true,
        entries: { 1: { mode: 'ai', aiDescription: 'Activate for weather questions.', threshold: null } },
    };
}
function book() {
    return { entries: { 1: { uid: 1, content: 'Original body', key: ['weather'], constant: true } },
        extensions: { other: { keep: true }, 'tt-toolkit': { unrelated: 1 } }, otherField: ['keep'] };
}
function storageHost(data = book()) {
    let persisted = structuredClone(data);
    const values = new Map();
    const host = {
        loadWorldInfo: vi.fn(async () => structuredClone(data)),
        loadWorldInfoFresh: vi.fn(async () => structuredClone(persisted)),
        saveWorldInfo: vi.fn(async (_name, value) => { persisted = structuredClone(value); }),
        storeTryGetJson: vi.fn(async (table, key) => values.get(`${table}/${key}`)),
        storeSetJson: vi.fn(async (table, key, value) => { values.set(`${table}/${key}`, structuredClone(value)); }),
        storeDeleteJson: vi.fn(async (table, key) => { values.delete(`${table}/${key}`); }),
    };
    return { host, values, read: () => persisted, replace: value => { persisted = structuredClone(value); } };
}

describe('decision activation schema and regular-entry boundary', () => {
    it('detects EJS and Prompt Template-only entries while recognizing native decorators', () => {
        expect(detectPromptTemplateEntry({ content: '<%- variables.x %>', comment: '' }).detected).toBe(true);
        expect(detectPromptTemplateEntry({ content: '@@if variables.x\nBody', comment: '' }).detected).toBe(true);
        expect(detectPromptTemplateEntry({ content: 'Body', comment: '[GENERATE:BEFORE]' }).detected).toBe(true);
        expect(detectPromptTemplateEntry({ content: 'Body', comment: '@INJECT pos=0' }).detected).toBe(true);
        expect(detectPromptTemplateEntry({ content: '@@activate\nBody', comment: '' }).detected).toBe(false);
        expect(detectPromptTemplateEntry({ content: '@@dont_activate\nBody', comment: '' }).detected).toBe(false);
    });

    it.each([{ constant: true }, { vectorized: true }, { extensions: { vectorized: true } }, { key: ['weather'] }])('allows all regular native trigger types %j', fields => {
        expect(isAiModeEligible({ uid: 1, content: 'Body', ...fields })).toBe(true);
    });

    it.each([
        null, [], { uid: 1, content: null }, { uid: {}, content: 'Body' },
        { uid: 1, content: '<%= unsafe() %>' }, { uid: 1, content: '@@dont_activate\nBody' },
        { uid: 1, content: 'Body', comment: '[RENDER:AFTER]' },
    ])('refuses non-regular or ambiguous entries %j', entry => {
        expect(isAiModeEligible(entry)).toBe(false);
    });

    it('round-trips v2 config without changing world-info bodies, triggers or unrelated extensions', () => {
        const data = book();
        const before = structuredClone(data);
        const embedded = embedWorldInfoAiConfig(data, config());
        expect(embedded.entries).toEqual(data.entries);
        expect(embedded.extensions.other).toEqual({ keep: true });
        expect(embedded.extensions['tt-toolkit'].unrelated).toBe(1);
        expect(parseWorldInfoAiConfig(readEmbeddedWorldInfoAiConfig(embedded))).toEqual(config());
        expect(data).toEqual(before);
        expect(createDefaultWorldInfoAiConfig()).toEqual({ schemaVersion: 2, enabled: false, entries: {} });
    });

    it('explicitly migrates known v1 descriptions into conditions inheriting the global threshold', () => {
        const old = { schemaVersion: 1, enabled: true, entries: {
            1: { mode: 'ai', aiDescription: '  Weather around {{char}}  ' },
            2: { mode: 'native', aiDescription: '' },
        } };
        const before = structuredClone(old);
        expect(parseWorldInfoAiConfig(old)).toEqual({ schemaVersion: 2, enabled: true, entries: {
            1: { mode: 'ai', aiDescription: 'Weather around {{char}}', threshold: null },
            2: { mode: 'native', aiDescription: '', threshold: null },
        } });
        expect(old).toEqual(before);
        expect(parseWorldInfoAiConfig(undefined)).toEqual(createDefaultWorldInfoAiConfig());
    });

    it.each([0, 0.7, 1, null])('accepts an explicit entry threshold %s', threshold => {
        const value = config(); value.entries[1].threshold = threshold;
        expect(parseWorldInfoAiConfig(value).entries[1].threshold).toBe(threshold);
    });

    it.each([undefined, NaN, Infinity, -0.1, 1.1, '0.7', false])('rejects invalid or missing v2 entry threshold %s', threshold => {
        const value = config(); value.entries[1].threshold = threshold;
        expect(() => parseWorldInfoAiConfig(value)).toThrow(expect.objectContaining({ code: 'INVALID_SCHEMA' }));
    });

    it.each([
        null, [], { ...config(), unknown: true }, { ...config(), enabled: 'true' }, { ...config(), entries: null },
        { ...config(), entries: { 1: { mode: 'ai', aiDescription: ' ', threshold: null } } },
        { ...config(), entries: { 1: { mode: 'ai', aiDescription: 'Weather', threshold: null, apiKey: 'secret' } } },
    ])('rejects damaged configurations without interpreting them as missing: %j', value => {
        expect(() => parseWorldInfoAiConfig(value)).toThrow(expect.objectContaining({ code: 'INVALID_SCHEMA' }));
    });

    it.each([0, 3, '2', undefined])('rejects unknown config versions %s with an explicit reset requirement', schemaVersion => {
        expect(() => parseWorldInfoAiConfig({ ...config(), schemaVersion })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA' }));
    });

    it('distinguishes absent embedded config from a persisted null value', () => {
        expect(readEmbeddedWorldInfoAiConfig(book())).toBeUndefined();
        const data = book(); data.extensions['tt-toolkit'].worldInfoAiRouter = null;
        expect(readEmbeddedWorldInfoAiConfig(data)).toBeNull();
        expect(() => parseWorldInfoAiConfig(readEmbeddedWorldInfoAiConfig(data))).toThrow();
        expect(() => readEmbeddedWorldInfoAiConfig({ extensions: null })).toThrow();
    });

    it('uses JSON tuple identities that cannot collide on dots, punctuation or uid types', () => {
        expect(worldEntryKey('Lore.1', 2)).toBe(JSON.stringify(['Lore.1', 2]));
        expect(worldEntryKey('Lore.1', 2)).not.toBe(worldEntryKey('Lore', '1.2'));
        expect(worldEntryKey('Lore', 2)).not.toBe(worldEntryKey('Lore', '2'));
    });
});

describe('decision feature settings and keyless config exchange', () => {
    it('uses v2 defaults only for missing settings and explicitly migrates v1 preset selection', () => {
        const defaults = { schemaVersion: 2, presetId: null, threshold: 0.7, historyRounds: 3, timeoutMs: 10000 };
        expect(createDefaultWorldInfoAiFeatureSettings()).toEqual(defaults);
        expect(parseWorldInfoAiFeatureSettings(undefined)).toEqual(defaults);
        expect(parseWorldInfoAiFeatureSettings({ schemaVersion: 1, presetId: 'jev-preset' })).toEqual({ ...defaults, presetId: 'jev-preset' });
    });

    it.each([
        null, [], { ...createDefaultWorldInfoAiFeatureSettings(), extra: true },
        { ...createDefaultWorldInfoAiFeatureSettings(), presetId: '' },
        { ...createDefaultWorldInfoAiFeatureSettings(), threshold: null },
        { ...createDefaultWorldInfoAiFeatureSettings(), threshold: 1.1 },
        { ...createDefaultWorldInfoAiFeatureSettings(), historyRounds: 0 },
        { ...createDefaultWorldInfoAiFeatureSettings(), historyRounds: 101 },
        { ...createDefaultWorldInfoAiFeatureSettings(), historyRounds: 1.5 },
        { ...createDefaultWorldInfoAiFeatureSettings(), timeoutMs: 999 },
        { ...createDefaultWorldInfoAiFeatureSettings(), timeoutMs: 120001 },
    ])('rejects damaged feature settings %j', value => {
        expect(() => parseWorldInfoAiFeatureSettings(value)).toThrow(expect.objectContaining({ code: 'INVALID_SCHEMA' }));
    });

    it('rejects unknown feature settings versions', () => {
        expect(() => parseWorldInfoAiFeatureSettings({ ...createDefaultWorldInfoAiFeatureSettings(), schemaVersion: 3 }))
            .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA' }));
    });

    it('round-trips only the decision config, never credentials or model connection details', () => {
        const text = serializeConfigExchange(config());
        expect(parseConfigExchange(text)).toEqual(config());
        expect(Object.keys(JSON.parse(text))).toEqual(['format', 'config']);
        expect(text).not.toMatch(/apiKey|apiUrl|presetId|secret/);
        expect(() => serializeConfigExchange({ ...config(), apiKey: 'secret' })).toThrow();
        expect(() => parseConfigExchange(JSON.stringify({ format: 'tt-toolkit.world-info-decision.v1', config: config(), apiKey: 'secret' }))).toThrow();
        expect(() => parseConfigExchange('not-json')).toThrow();
        expect(() => parseConfigExchange(JSON.stringify({ format: 'unknown', config: config() }))).toThrow();
    });
});

describe('world info config storage fallback and safe whole-book writes', () => {
    it('uses the world extension after a verified fresh round trip', async () => {
        const data = book(); const { host, read } = storageHost(data);
        const result = await new WorldInfoAiConfigStore(host).save('Lore', config(), data);
        expect(result.backend).toBe('world-extension');
        expect(host.loadWorldInfoFresh).toHaveBeenCalledTimes(2);
        expect(host.loadWorldInfoFresh.mock.invocationCallOrder[0]).toBeLessThan(host.saveWorldInfo.mock.invocationCallOrder[0]);
        expect(host.loadWorldInfoFresh.mock.invocationCallOrder[1]).toBeGreaterThan(host.saveWorldInfo.mock.invocationCallOrder[0]);
        expect(host.storeSetJson).not.toHaveBeenCalled();
        expect(readEmbeddedWorldInfoAiConfig(read())).toEqual(config());
        expect(read().entries).toEqual(data.entries);
    });

    it('does not try deleting nonexistent fallback records after a successful embedded save', async () => {
        const data = book(); const { host } = storageHost(data);
        host.storeDeleteJson.mockRejectedValue(new Error('Not found: stale entry'));
        const result = await new WorldInfoAiConfigStore(host).save('Lore', config(), data);
        expect(result.backend).toBe('world-extension');
        expect(host.storeSetJson).not.toHaveBeenCalled();
        expect(host.storeDeleteJson).not.toHaveBeenCalled();
    });

    it('removes hashed and legacy fallback records only after verifying the embedded save', async () => {
        const data = book(); const { host, values } = storageHost(data);
        const fallbackKey = await worldInfoFallbackKey('Lore');
        values.set(`world-info-ai/${fallbackKey}`, config());
        values.set('world-info-ai/Lore', config());
        values.set('world-info-ai/unrelated', { keep: true });
        const result = await new WorldInfoAiConfigStore(host).save('Lore', config(), data);
        expect(result.backend).toBe('world-extension');
        expect(host.storeDeleteJson.mock.calls).toEqual([['world-info-ai', fallbackKey], ['world-info-ai', 'Lore']]);
        expect(host.storeDeleteJson.mock.invocationCallOrder[0]).toBeGreaterThan(host.loadWorldInfoFresh.mock.invocationCallOrder[1]);
        expect(values.get('world-info-ai/unrelated')).toEqual({ keep: true });
    });

    it('automatically saves only config on the plugin side when the host drops unknown fields', async () => {
        const data = book(); const { host } = storageHost(data);
        host.saveWorldInfo.mockResolvedValue(undefined);
        const log = { warn: vi.fn() };
        const result = await new WorldInfoAiConfigStore(host, log).save('示例世界书 v1.5.1', config(), data);
        expect(result.backend).toBe('extension-store');
        const key = await worldInfoFallbackKey('示例世界书 v1.5.1');
        expect(key).toMatch(/^world-[a-f0-9]{64}$/);
        expect(host.storeSetJson).toHaveBeenCalledExactlyOnceWith('world-info-ai', key, config());
        expect(host.storeSetJson.mock.calls[0][1]).not.toContain('示例');
        expect(host.storeDeleteJson).not.toHaveBeenCalled();
        expect(JSON.stringify(host.storeSetJson.mock.calls)).not.toContain('Original body');
        expect(log.warn).toHaveBeenCalledWith('config.fallback_saved', { data: expect.objectContaining({ reason: 'WORLD_INFO_EXTENSION_DROPPED', outcome: 'extension-store' }) });
    });

    it('loads hashed arbitrary-name records and legacy legal keys', async () => {
        const data = book(); const { host, values } = storageHost(data);
        const key = await worldInfoFallbackKey('示例世界书 v1.5.1');
        values.set(`world-info-ai/${key}`, config());
        const store = new WorldInfoAiConfigStore(host);
        await expect(store.load('示例世界书 v1.5.1', data)).resolves.toMatchObject({ backend: 'extension-store', config: config() });
        expect(host.storeTryGetJson).toHaveBeenCalledTimes(1);
        values.set('world-info-ai/Lore', config());
        await expect(store.load('Lore', data)).resolves.toMatchObject({ backend: 'extension-store', config: config() });
        expect(host.storeTryGetJson.mock.calls.at(-1)[1]).toBe('Lore');
    });

    it('treats fallback as authoritative until a verified embedded save removes it', async () => {
        const embedded = config(); embedded.entries[1].aiDescription = 'Older embedded condition';
        const data = embedWorldInfoAiConfig(book(), embedded);
        const { host, values } = storageHost(data);
        values.set(`world-info-ai/${await worldInfoFallbackKey('Lore')}`, config());
        const store = new WorldInfoAiConfigStore(host);
        await expect(store.load('Lore')).resolves.toMatchObject({ backend: 'extension-store', config: config() });
        await store.save('Lore', config(), data);
        await expect(store.load('Lore')).resolves.toMatchObject({ backend: 'world-extension', config: config() });
        expect(host.loadWorldInfo).not.toHaveBeenCalled();
    });

    it('refuses damaged authoritative fallback instead of silently using a valid embedded config', async () => {
        const data = embedWorldInfoAiConfig(book(), config()); const { host, values } = storageHost(data);
        values.set(`world-info-ai/${await worldInfoFallbackKey('Lore')}`, null);
        await expect(new WorldInfoAiConfigStore(host).load('Lore')).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(host.storeSetJson).not.toHaveBeenCalled();
    });

    it.each(['body', 'unrelated-extension'])('does not write or fall back if the fresh book has changed %s', async field => {
        const data = book(); const { host, replace } = storageHost(data);
        const changed = structuredClone(data);
        if (field === 'body') changed.entries[1].content = 'New content from another editor';
        else changed.extensions.other.keep = false;
        replace(changed);
        await expect(new WorldInfoAiConfigStore(host).save('Lore', config(), data)).rejects.toMatchObject({ code: 'WORLD_INFO_STALE' });
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(host.storeSetJson).not.toHaveBeenCalled();
        expect(host.storeDeleteJson).not.toHaveBeenCalled();
        expect(data).toEqual(book());
    });

    it('stops before any write if fresh verification fails', async () => {
        const data = book(); const { host } = storageHost(data);
        host.loadWorldInfoFresh.mockRejectedValue(new Error('transport failure'));
        await expect(new WorldInfoAiConfigStore(host).save('Lore', config(), data)).rejects.toThrow('transport failure');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(host.storeSetJson).not.toHaveBeenCalled();
    });

    it('resets only the decision domain, preserving bodies, native fields and all unrelated data', async () => {
        const data = embedWorldInfoAiConfig(book(), config());
        const { host, values, read } = storageHost(data);
        const key = await worldInfoFallbackKey('Lore');
        values.set(`world-info-ai/${key}`, config());
        values.set('world-info-ai/Lore', config());
        values.set('world-info-ai/other-book', config());
        values.set('main/llm-presets-v1', { keep: 'models' });
        const result = await new WorldInfoAiConfigStore(host).reset('Lore', data);
        expect(read()).toEqual(book());
        expect(result).toMatchObject({ data: book(), backend: 'default', config: createDefaultWorldInfoAiConfig() });
        expect(readEmbeddedWorldInfoAiConfig(data)).toEqual(config());
        expect(host.storeDeleteJson.mock.calls).toEqual([['world-info-ai', key], ['world-info-ai', 'Lore']]);
        expect(values.get('world-info-ai/other-book')).toEqual(config());
        expect(values.get('main/llm-presets-v1')).toEqual({ keep: 'models' });
    });

    it('refuses a stale reset without deleting fallback or writing the whole book', async () => {
        const data = embedWorldInfoAiConfig(book(), config()); const { host, replace } = storageHost(data);
        const changed = structuredClone(data); changed.entries[1].content = 'New body'; replace(changed);
        await expect(new WorldInfoAiConfigStore(host).reset('Lore', data)).rejects.toMatchObject({ code: 'WORLD_INFO_STALE' });
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(host.storeDeleteJson).not.toHaveBeenCalled();
    });
});
