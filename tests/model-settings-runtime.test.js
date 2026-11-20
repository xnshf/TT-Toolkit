import { describe, expect, it, vi } from 'vitest';
import { ModelSettingsRuntime } from '../src/features/model-settings/runtime.js';
import { createDefaultLlmPresetSettings } from '../src/kernel/llm-presets.js';
import { ToolkitLogger } from '../src/kernel/logging/logger.js';
import { createDefaultLogSettings } from '../src/kernel/logging/schema.js';
import { TauriTavernHost } from '../src/kernel/host.js';

function mockLogger() {
    const scopedLog = { fail: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
        scopedLog,
        protectValues: vi.fn(),
        scoped: vi.fn(() => scopedLog),
    };
}

function preset(overrides = {}) {
    return { id: 'p1', name: 'Primary', apiUrl: 'https://api.example.invalid/v1', model: 'model-a', apiKey: 'sk-top-secret', ...overrides };
}

function makeRuntime(options = {}) {
    const host = { globalGet: vi.fn(), globalSet: vi.fn(), globalDelete: vi.fn() };
    const logger = options.realLogger ? null : mockLogger();
    const fetchModels = options.fetchModels ?? vi.fn(async () => ['a']);
    const runtime = new ModelSettingsRuntime(host, logger ?? options.realLogger, { fetchModels });
    return { host, logger, runtime };
}

describe('model settings failure instrumentation', () => {
    it('routes System One discovery and connection tests to direct GET only, never background probes', async () => {
        const host = { globalGet: vi.fn(), globalSet: vi.fn(), getOpenAiCompatibleStatus: vi.fn() };
        const capabilities = { formatFor: vi.fn(), record: vi.fn() };
        const probeCapability = vi.fn();
        const fetch = vi.fn(async (_url, init) => {
            expect(init.method).toBe('GET');
            return { ok: true, text: async () => JSON.stringify({ models: [{ name: 'jev' }] }) };
        });
        const logger = mockLogger();
        const runtime = new ModelSettingsRuntime(host, logger, { fetch, capabilities, probeCapability });
        const decision = preset({ protocol: 'systemone' });
        await runtime.load();
        await runtime.save({ schemaVersion: 1, activePresetId: 'p1', presets: [decision] });
        expect(await runtime.fetchModels(decision)).toEqual(['jev']);
        expect(await runtime.testConnection(decision)).toEqual({ modelCount: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(host.getOpenAiCompatibleStatus).not.toHaveBeenCalled();
        expect(capabilities.formatFor).not.toHaveBeenCalled();
        expect(capabilities.record).not.toHaveBeenCalled();
        expect(probeCapability).not.toHaveBeenCalled();
    });

    it('keeps network and service details sanitized for System One settings errors', async () => {
        const logger = mockLogger();
        const runtime = new ModelSettingsRuntime({}, logger, { fetch: async () => { throw new Error('sk-top-secret model-a https://private.invalid'); } });
        for (const operation of ['fetchModels', 'testConnection']) {
            const error = await runtime[operation](preset({ protocol: 'systemone' })).catch(error => error);
            expect(error.code).toBe('DECISION_NETWORK_FAILED');
            expect(error.message).not.toMatch(/sk-top-secret|model-a|private.invalid/);
        }
        expect(JSON.stringify(logger.scopedLog.fail.mock.calls)).not.toMatch(/sk-top-secret|model-a|private.invalid/);
    });

    it('marks damaged data and resets only the preset key with explicit defaults', async () => {
        const { runtime, host } = makeRuntime();
        host.globalGet.mockResolvedValue({ schemaVersion: 99, activePresetId: null, presets: [] });
        await runtime.load();
        expect(runtime.state.damaged).toBe(true);
        expect(runtime.state.error).not.toBe('');
        expect(host.globalSet).not.toHaveBeenCalled();
        await runtime.reset();
        expect(host.globalSet).toHaveBeenCalledExactlyOnceWith('llm-presets-v1', createDefaultLlmPresetSettings());
        expect(host.globalDelete).not.toHaveBeenCalled();
        expect(runtime.state.damaged).toBe(false);
        expect(runtime.state.settings).toEqual(createDefaultLlmPresetSettings());
        expect(runtime.state.error).toBe('');
    });
    it('logs exactly one presets.load_failed event without sensitive payload', async () => {
        const { host, logger, runtime } = makeRuntime();
        host.globalGet.mockRejectedValueOnce(new Error('storage down'));
        await runtime.load();
        expect(logger.scopedLog.fail).toHaveBeenCalledTimes(1);
        expect(logger.scopedLog.fail).toHaveBeenCalledWith('presets.load_failed', 'presets.load', expect.any(Error), { includeError: false });
    });

    it('blocks saves and resets after a read failure until a retry succeeds', async () => {
        const { host, runtime } = makeRuntime();
        const saved = { schemaVersion: 1, activePresetId: 'p1', presets: [preset({ protocol: 'systemone' })] };
        host.globalGet.mockRejectedValueOnce(new Error('storage down')).mockResolvedValue(saved);
        const defaults = createDefaultLlmPresetSettings();
        await expect(runtime.save(defaults)).rejects.toHaveProperty('code', 'PRESET_WRITE_BLOCKED');
        await runtime.load();
        await expect(runtime.save(defaults)).rejects.toHaveProperty('code', 'PRESET_WRITE_BLOCKED');
        await expect(runtime.reset()).rejects.toHaveProperty('code', 'PRESET_WRITE_BLOCKED');
        expect(host.globalSet).not.toHaveBeenCalled();
        await runtime.load();
        expect(runtime.state.settings).toEqual(saved);
        await runtime.save(saved);
        expect(host.globalSet).toHaveBeenCalledExactlyOnceWith('llm-presets-v1', saved);
    });

    it('logs exactly one presets.save_failed event without sensitive payload', async () => {
        const { host, logger, runtime } = makeRuntime();
        await runtime.load();
        host.globalSet.mockRejectedValueOnce(new Error('save down'));
        await expect(runtime.save({ ...createDefaultLlmPresetSettings(), presets: [preset()] })).rejects.toThrow(/save down/);
        expect(logger.scopedLog.fail).toHaveBeenCalledTimes(1);
        expect(logger.scopedLog.fail).toHaveBeenCalledWith('presets.save_failed', 'presets.save', expect.any(Error), { includeError: false });
    });

    it('registers loaded and normalized preset values for protection before writing', async () => {
        const { host, logger, runtime } = makeRuntime();
        const settings = { schemaVersion: 1, activePresetId: 'p1', presets: [preset()] };
        host.globalGet.mockResolvedValue(settings);
        await runtime.load();
        expect(logger.protectValues).toHaveBeenCalledWith(expect.objectContaining({ presets: [expect.objectContaining({ apiKey: 'sk-top-secret' })] }));
        const changed = { ...settings, presets: [preset({ name: '  Renamed  ', apiKey: 'sk-test-next-save' })] };
        host.globalSet.mockImplementation(async () => {
            expect(logger.protectValues).toHaveBeenLastCalledWith(expect.objectContaining({
                presets: [expect.objectContaining({ name: 'Renamed', apiKey: 'sk-test-next-save' })],
            }));
        });
        await runtime.save(changed);
        expect(logger.protectValues).toHaveBeenCalledTimes(2);
    });

    it('silently probes JSON capability for missing presets after a successful save and records the result', async () => {
        const host = { globalGet: vi.fn(async () => undefined), globalSet: vi.fn() };
        const logger = mockLogger();
        const capabilities = {
            formatFor: vi.fn(async id => id === 'p1' ? 'strict' : null),
            record: vi.fn(async () => undefined),
        };
        const probeCapability = vi.fn(async () => ({ format: 'plain', checkedAt: Date.now() }));
        const runtime = new ModelSettingsRuntime(host, logger, { capabilities, probeCapability });
        const settings = { schemaVersion: 1, activePresetId: 'p1', presets: [preset(), preset({ id: 'p2', model: 'model-b' })] };
        await runtime.load();
        await runtime.save(settings);
        await vi.waitFor(() => expect(logger.scopedLog.info).toHaveBeenCalledWith('capability.probed', expect.objectContaining({ data: { presetId: 'p2', format: 'plain' } })));
        expect(probeCapability).toHaveBeenCalledTimes(1);
        expect(probeCapability.mock.calls[0][1].id).toBe('p2');
        expect(capabilities.record).toHaveBeenCalledWith('p2', 'plain');
    });

    it('keeps probing failures silent without touching the save result or logging sensitive details', async () => {
        const host = { globalGet: vi.fn(async () => undefined), globalSet: vi.fn() };
        const logger = mockLogger();
        const probeCapability = vi.fn(async () => { throw new Error(`连接 ${preset().apiUrl} 失败`); });
        const runtime = new ModelSettingsRuntime(host, logger, {
            capabilities: { formatFor: vi.fn(async () => null), record: vi.fn() },
            probeCapability,
        });
        await runtime.load();
        await runtime.save({ schemaVersion: 1, activePresetId: 'p1', presets: [preset()] });
        await vi.waitFor(() => expect(logger.scopedLog.warn).toHaveBeenCalledWith('capability.probe_failed', expect.objectContaining({ data: { presetId: 'p1', kind: 'Error' } })));
        expect(logger.scopedLog.warn.mock.calls[0][1].data).not.toHaveProperty('error');
    });

    it('never writes preset names, urls, models, keys, or unknown error bodies into real log events', async () => {
        const json = new Map();
        const blobs = new Map();
        const host = new TauriTavernHost();
        host.abi = { api: { dev: { frontendLogs: { list: vi.fn(async () => []), subscribe: vi.fn(async () => vi.fn()) } } } };
        host.globalGet = vi.fn(async key => key === 'llm-presets-v1' ? { schemaVersion: 1, activePresetId: 'p1', presets: [preset()] } : json.get(`global:${key}`));
        host.globalSet = vi.fn(async (key, value) => { json.set(`global:${key}`, structuredClone(value)); });
        host.globalDelete = vi.fn(async key => { json.delete(`global:${key}`); });
        host.storeTryGetJson = vi.fn(async (table, key) => json.get(`${table}:${key}`));
        host.storeSetJson = vi.fn(async (table, key, value) => { json.set(`${table}:${key}`, structuredClone(value)); });
        host.storeSetBlob = vi.fn(async (_table, key, data) => { blobs.set(key, data); });
        host.storeGetBlob = vi.fn(async (_table, key) => {
            const blob = blobs.get(key);
            if (!blob)
                throw new Error('missing blob');
            return blob;
        });
        host.storeDeleteBlob = vi.fn(async (_table, key) => { blobs.delete(key); });
        host.storeDeleteTable = vi.fn(async () => {
            blobs.clear();
            for (const key of [...json.keys()])
                if (key.startsWith('logs:'))
                    json.delete(key);
        });
        json.set('global:logger-settings-v1', { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        const diagnostic = logger.scoped({ featureId: 'system', source: 'test' });
        const fetchModels = vi.fn(async (_host, draft) => {
            diagnostic.info('request.simulated', { sensitive: { detail: `Bearer ${draft.apiKey}` } });
            throw new Error(`连接 ${draft.apiUrl} 失败，密钥 ${draft.apiKey} 被拒`);
        });
        const runtime = new ModelSettingsRuntime(host, logger, { fetchModels });
        await expect(runtime.fetchModels(preset({ apiKey: 'sk-test-unsaved-fetch' }))).rejects.toThrow(/连接/);
        await expect(runtime.testConnection(preset({ apiKey: 'sk-test-unsaved-test' }))).rejects.toThrow(/连接/);
        await logger.stop();
        const sessionId = logger.state.sessions[0].id;
        const { events: loaded } = await logger.loadSession(sessionId);
        const serialized = JSON.stringify(loaded);
        expect(serialized).not.toMatch(/sk-top-secret|sk-test-unsaved/);
        expect(loaded.filter(event => event.event === 'request.simulated').map(event => event.sensitive.detail))
            .toEqual(['Bearer [REDACTED_PROTECTED_VALUE]', 'Bearer [REDACTED_PROTECTED_VALUE]']);
        expect(serialized).not.toContain('api.example.invalid');
        expect(serialized).not.toContain('model-a');
        const failureEvents = loaded.filter(event => /fetch_failed|test_failed/.test(event.event));
        expect(failureEvents.length).toBe(2);
        for (const event of failureEvents)
            expect(event.sensitive).toBeUndefined();
    });
});
