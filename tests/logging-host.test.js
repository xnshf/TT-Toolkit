import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { ToolkitLogger } from '../src/kernel/logging/logger.js';
import { createDefaultLogSettings } from '../src/kernel/logging/schema.js';

function entry(id, overrides = {}) {
    return { id, timestampMs: id * 1000, level: 'info', message: `message-${id}`, ...overrides };
}

function createLoggerHost(options = {}) {
    const json = new Map();
    const blobs = new Map();
    const tail = structuredClone(options.tail ?? []);
    let handler = null;
    let underlyingCancel = vi.fn(() => { handler = null; });
    let captureEnabled = options.captureEnabled ?? false;
    const frontendLogs = {
        list: vi.fn(async () => structuredClone(tail)),
        subscribe: vi.fn(async callback => {
            handler = callback;
            underlyingCancel = vi.fn(() => { handler = null; });
            return underlyingCancel;
        }),
        getConsoleCaptureEnabled: vi.fn(async () => captureEnabled),
    };
    const host = new TauriTavernHost();
    host.abi = { api: { dev: { frontendLogs } } };
    host.globalGet = vi.fn(async key => json.get(`global:${key}`));
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
    host.storeDeleteBlob = vi.fn(async (_table, key) => {
        if (!blobs.delete(key))
            throw new Error('Not found: Extension store blob not found');
    });
    host.storeDeleteTable = vi.fn(async () => {
        blobs.clear();
        for (const key of [...json.keys()])
            if (key.startsWith('logs:'))
                json.delete(key);
    });
    return {
        host,
        json,
        blobs,
        list: frontendLogs.list,
        subscribe: frontendLogs.subscribe,
        getCapture: frontendLogs.getConsoleCaptureEnabled,
        cancel: () => underlyingCancel,
        setTail(value) { tail.splice(0, tail.length, ...structuredClone(value)); },
        setCapture(value) { captureEnabled = value; },
        push(raw) { handler?.(structuredClone(raw)); },
    };
}

const context = (featureId = 'test', source = 'runtime') => ({ featureId, source });

async function makeLogger(hostSetup = {}, settings = undefined) {
    const created = createLoggerHost(hostSetup);
    if (settings)
        created.json.set('global:logger-settings-v1', settings);
    const logger = new ToolkitLogger(created.host);
    await logger.initialize();
    return { ...created, logger };
}

describe('logger host stream integration', () => {
    it('stays closed by default: no subscription, no tail import, no persistence', async () => {
        const { host, list, subscribe, blobs, logger } = await makeLogger({ tail: [entry(1)] });
        expect(subscribe).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        logger.scoped(context()).info('ignored', { sensitive: { secret: 'x' } });
        expect(blobs.size).toBe(0);
        expect(logger.state.hostFrontendStatus.phase).toBe('idle');
        await logger.stop();
    });

    it('imports the retained tail on start and keeps receiving live entries', async () => {
        const { list, logger, push } = await makeLogger({ tail: [entry(1), entry(2)] });
        await logger.start();
        expect(list).toHaveBeenCalledOnce();
        const hostIds = () => logger.state.currentEntries
            .filter(event => event.event === 'host.frontend_log')
            .map(event => event.data.hostEntryId);
        expect(hostIds()).toEqual([1, 2]);
        push(entry(3));
        expect(hostIds()).toEqual([1, 2, 3]);
        await logger.stop();
    });

    it('merges tail [1,2] with the init live buffer [2,3] into a single ascending 1,2,3', async () => {
        const created = createLoggerHost({ tail: [entry(1), entry(2)] });
        created.subscribe.mockImplementation(async callback => {
            callback(entry(2));
            callback(entry(3));
            const cancel = vi.fn(() => { created.handler = null; });
            created.handler = callback;
            return cancel;
        });
        const logger = new ToolkitLogger(created.host);
        await logger.initialize();
        await logger.start();
        const hostIds = () => logger.state.currentEntries
            .filter(event => event.event === 'host.frontend_log')
            .map(event => event.data.hostEntryId);
        expect(hostIds()).toEqual([1, 2, 3]);
        await logger.stop();
    });

    it('does not leave a session, enabled state, or subscription when the initial index save fails', async () => {
        const created = createLoggerHost();
        const originalSetJson = created.host.storeSetJson;
        created.host.storeSetJson = vi.fn(async (table, key, value) => {
            if (table === 'logs' && key === 'index-v2' && created.json.get('logs:index-v2') === undefined)
                throw new Error('disk full');
            return originalSetJson(table, key, value);
        });
        const logger = new ToolkitLogger(created.host);
        await logger.initialize();
        await expect(logger.start()).rejects.toThrow(/disk full/);
        expect(logger.state.enabled).toBe(false);
        expect(logger.state.sessions).toHaveLength(0);
        expect(logger.state.currentSessionId).toBeNull();
        expect(logger.state.hostFrontendStatus.phase).toBe('unavailable');
        expect(created.cancel()).toHaveBeenCalledTimes(1);
    });

    it('cleans up the subscription when the tail read fails', async () => {
        const created = createLoggerHost({ tail: [entry(1)] });
        created.list.mockRejectedValueOnce(new Error('tail down'));
        const logger = new ToolkitLogger(created.host);
        await logger.initialize();
        await expect(logger.start()).rejects.toMatchObject({ code: 'HOST_FRONTEND_LOG_LIST_INVALID' });
        expect(logger.state.enabled).toBe(false);
        expect(logger.state.sessions).toHaveLength(0);
        expect(created.cancel()).toHaveBeenCalledTimes(1);
    });

    it('stops receiving host events after stop and flushes the final batch', async () => {
        const { blobs, logger, push } = await makeLogger();
        await logger.start();
        push(entry(5));
        logger.scoped(context()).info('own-event');
        await logger.stop();
        push(entry(6));
        expect(logger.state.currentEntries.some(event => event.data?.hostEntryId === 6)).toBe(false);
        expect(blobs.size).toBeGreaterThan(0);
    });

    it('does not re-import the tail for privacy rotation or clear restarts', async () => {
        const { list, logger } = await makeLogger({ tail: [entry(1)] });
        await logger.start();
        await logger.saveSettings({ ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        expect(list).toHaveBeenCalledTimes(1);
        await logger.clearLogs();
        expect(list).toHaveBeenCalledTimes(1);
        await logger.stop();
    });

    it('ignores duplicate concurrent start calls and creates a single session and subscription', async () => {
        const created = createLoggerHost();
        const logger = new ToolkitLogger(created.host);
        await logger.initialize();
        await Promise.all([logger.start(), logger.start()]);
        expect(created.subscribe).toHaveBeenCalledTimes(1);
        expect(logger.state.sessions).toHaveLength(1);
        await logger.stop();
    });

    it('applies the minimum level to host entries while still marking ignored ids as processed', async () => {
        const created = createLoggerHost({ tail: [entry(1, { level: 'info' })] });
        const logger = new ToolkitLogger(created.host);
        created.json.set('global:logger-settings-v1', { ...createDefaultLogSettings(), minimumLevel: 'warn', consoleLevel: 'off' });
        await logger.initialize();
        await logger.start();
        expect(logger.state.currentEntries.filter(event => event.event === 'host.frontend_log')).toHaveLength(0);
        created.push(entry(1, { level: 'error' }));
        expect(logger.state.currentEntries.filter(event => event.event === 'host.frontend_log')).toHaveLength(0);
        created.push(entry(2, { level: 'error' }));
        expect(logger.state.currentEntries.filter(event => event.event === 'host.frontend_log')).toHaveLength(1);
        await logger.stop();
    });

    it('keeps redacted storage, memory, and export free of host message and target', async () => {
        const { blobs, logger, push } = await makeLogger({ tail: [entry(1, { message: 'secret body', target: 'main' })] });
        await logger.start();
        push(entry(2, { message: 'live secret', target: 'iframe' }));
        const events = logger.state.currentEntries.filter(event => event.event === 'host.frontend_log');
        for (const event of events)
            expect(event.sensitive).toBeUndefined();
        await logger.stop();
        const sessionId = logger.state.sessions[0].id;
        const loaded = await logger.loadSession(sessionId);
        for (const event of loaded.filter(item => item.event === 'host.frontend_log'))
            expect(event.sensitive).toBeUndefined();
        const serialized = JSON.stringify({ events: loaded });
        expect(serialized).not.toContain('secret body');
        expect(serialized).not.toContain('live secret');
        const entries = loaded.map(event => ({ sessionId, event }));
        const exported = logger.exportEntries(entries, 'json');
        expect(exported).not.toContain('secret body');
        expect(blobs.size).toBeGreaterThan(0);
    });

    it('persists, displays, and exports host message and target in full mode', async () => {
        const { logger, push } = await makeLogger({ tail: [entry(1, { message: 'body text', target: 'main' })] }, { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        await logger.start();
        push(entry(2, { message: 'second', target: 'iframe' }));
        await logger.stop();
        const sessionId = logger.state.sessions[0].id;
        const loaded = await logger.loadSession(sessionId);
        const hostEvents = loaded.filter(event => event.event === 'host.frontend_log');
        expect(hostEvents[0].sensitive).toMatchObject({ message: 'body text', target: 'main' });
        expect(hostEvents[1].sensitive).toMatchObject({ message: 'second', target: 'iframe' });
        const exported = logger.exportEntries(loaded.map(event => ({ sessionId, event })), 'log');
        expect(exported).toContain('body text');
        expect(exported).toContain('second');
    });

    it('redacts protected model values across nested data, Error fields, host messages, memory, console and export', async () => {
        const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        try {
            const { logger, push } = await makeLogger({ tail: [entry(1, { message: 'sk-secret' })] }, { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'info' });
            logger.protectValues({ presets: [{ name: 'MyModel', apiUrl: 'https://secret.invalid/v1', model: 'model-x', apiKey: 'sk-secret' }] });
            await logger.start();
            const keyError = new Error('sk-secret');
            keyError.stack = 'Error: redacted stack frame';
            logger.scoped(context()).error('with-key', {
                data: { preset: { name: 'MyModel', apiUrl: 'https://secret.invalid/v1', model: 'model-x' } },
                sensitive: { error: keyError },
            });
            const redacted = '[REDACTED_PROTECTED_VALUE]';
            const persisted = logger.state.currentEntries.find(event => event.event === 'with-key');
            expect(persisted.data.preset.name).toBe(redacted);
            expect(persisted.data.preset.apiUrl).toBe(redacted);
            expect(persisted.data.preset.model).toBe(redacted);
            expect(persisted.sensitive.error.message).toBe(redacted);
            const hostEvent = logger.state.currentEntries.find(event => event.event === 'host.frontend_log');
            expect(hostEvent.sensitive.message).toBe(redacted);
            await logger.stop();
            const sessionId = logger.state.sessions[0].id;
            const loaded = await logger.loadSession(sessionId);
            const serialized = JSON.stringify(loaded);
            expect(serialized).not.toContain('sk-secret');
            expect(serialized).not.toContain('MyModel');
            expect(serialized).not.toContain('https://secret.invalid/v1');
            expect(serialized).not.toContain('model-x');
            expect(serialized).toContain(redacted);
            expect(consoleInfo).toHaveBeenCalled();
            const infoArgs = consoleInfo.mock.calls.flat();
            expect(infoArgs.some(arg => JSON.stringify(arg).includes('sk-secret'))).toBe(false);
            const exported = logger.exportEntries(loaded.map(event => ({ sessionId, event })), 'json');
            expect(exported).not.toContain('sk-secret');
            expect(exported).toContain(redacted);
        }
        finally {
            consoleInfo.mockRestore();
        }
    });

    it('does not forward host-source events to the console', async () => {
        const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        try {
            const { logger, push } = await makeLogger({ tail: [] }, { ...createDefaultLogSettings(), privacyMode: 'redacted', consoleLevel: 'info' });
            await logger.start();
            expect(consoleInfo).toHaveBeenCalledTimes(1);
            const before = consoleInfo.mock.calls.length;
            push(entry(11));
            expect(consoleInfo).toHaveBeenCalledTimes(before);
            await logger.stop();
        }
        finally {
            consoleInfo.mockRestore();
        }
    });

    it('filters only the exact four-segment TT-Toolkit console prefix from host entries', async () => {
        const { logger, push } = await makeLogger({ tail: [] }, { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        await logger.start();
        push(entry(1, { message: '[TT-Toolkit][system][logger][session.started] {ok:true}' }));
        push(entry(2, { message: '[TT-Toolkit] Initialization failed' }));
        push(entry(3, { message: '[TT-Toolkit][logger][persistence.failed] {"x":1}' }));
        push(entry(4, { message: 'third party says [TT-Toolkit][a][b][c]' }));
        const hostIds = () => logger.state.currentEntries
            .filter(event => event.event === 'host.frontend_log')
            .map(event => event.data.hostEntryId);
        expect(hostIds()).toEqual([2, 3, 4]);
        await logger.stop();
    });

    it('degrades the host stream on an invalid runtime DTO but keeps recording Toolkit events', async () => {
        const created = createLoggerHost({ tail: [] });
        const logger = new ToolkitLogger(created.host);
        created.json.set('global:logger-settings-v1', { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        await logger.initialize();
        await logger.start();
        expect(logger.state.hostFrontendStatus.phase).toBe('active');
        created.push({ id: 99, timestampMs: 1, level: 'bogus', message: 'x' });
        expect(logger.state.hostFrontendStatus.phase).toBe('degraded');
        expect(logger.state.hostFrontendStatus.code).toBe('HOST_FRONTEND_LOG_ENTRY_INVALID');
        expect(created.cancel()).toHaveBeenCalledTimes(1);
        const contract = logger.state.currentEntries.find(event => event.event === 'host.stream_contract_failed');
        expect(contract).toBeDefined();
        expect(contract.sensitive).toBeUndefined();
        expect(JSON.stringify(contract)).not.toContain('bogus');
        logger.scoped(context()).info('toolkit-still-works');
        expect(logger.state.currentEntries.some(event => event.event === 'toolkit-still-works')).toBe(true);
        await logger.stop();
        const sessionId = logger.state.sessions[0].id;
        const loaded = await logger.loadSession(sessionId);
        expect(loaded.some(event => event.event === 'host.stream_contract_failed')).toBe(true);
        expect(loaded.some(event => event.event === 'toolkit-still-works')).toBe(true);
    });

    it('records a session.load_failed event when reading persisted chunks fails', async () => {
        const created = createLoggerHost({ tail: [] });
        const logger = new ToolkitLogger(created.host);
        created.json.set('global:logger-settings-v1', { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        await logger.initialize();
        await logger.start();
        created.host.storeGetBlob = vi.fn(async () => { throw new Error('blob read failed'); });
        await expect(logger.loadSession(logger.state.currentSessionId)).rejects.toThrow(/blob read failed/);
        const failure = logger.state.currentEntries.find(event => event.event === 'session.load_failed');
        expect(failure).toBeDefined();
        expect(failure.data).toMatchObject({ operation: 'session.load', kind: 'Error' });
        await logger.stop();
    });

    it('re-probes list and subscribe after a real disable and re-enable', async () => {
        const { list, subscribe, logger } = await makeLogger({ tail: [entry(1)] });
        await logger.start();
        await logger.stop();
        await logger.start();
        expect(list).toHaveBeenCalledTimes(2);
        expect(subscribe).toHaveBeenCalledTimes(2);
        await logger.stop();
    });

    it('marks host ABI unavailable without breaking initialize or other tools', async () => {
        const host = new TauriTavernHost();
        host.abi = { api: { dev: {} } };
        host.globalGet = vi.fn(async () => undefined);
        host.globalSet = vi.fn(async () => undefined);
        host.globalDelete = vi.fn(async () => undefined);
        host.storeTryGetJson = vi.fn(async () => undefined);
        host.storeSetJson = vi.fn(async () => undefined);
        host.storeSetBlob = vi.fn(async () => undefined);
        host.storeGetBlob = vi.fn(async () => { throw new Error('missing'); });
        host.storeDeleteBlob = vi.fn(async () => undefined);
        host.storeDeleteTable = vi.fn(async () => undefined);
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        expect(logger.state.hostFrontendStatus.phase).toBe('unavailable');
        expect(logger.state.enabled).toBe(false);
        await expect(logger.start()).rejects.toMatchObject({ code: 'HOST_FRONTEND_LOGS_MISSING' });
    });
});
