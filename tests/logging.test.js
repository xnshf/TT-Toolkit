import { describe, expect, it, vi } from 'vitest';
import { ToolkitLogger } from '../src/kernel/logging/logger.js';
import { ChatExporterRuntime } from '../src/features/chat-exporter/runtime.js';
import { createDefaultLogSettings, MIB, parseLogIndex, parseLogSettings } from '../src/kernel/logging/schema.js';
import { boundLogEvent, projectLogPayload } from '../src/kernel/logging/serialize.js';
function createHost(initialSettings) {
    const json = new Map();
    const blobs = new Map();
    if (initialSettings)
        json.set('global:logger-settings-v1', initialSettings);
    const host = {
        globalGet: vi.fn(async (key) => json.get(`global:${key}`)),
        globalSet: vi.fn(async (key, value) => { json.set(`global:${key}`, structuredClone(value)); }),
        globalDelete: vi.fn(async (key) => { json.delete(`global:${key}`); }),
        storeTryGetJson: vi.fn(async (table, key) => json.get(`${table}:${key}`)),
        storeSetJson: vi.fn(async (table, key, value) => { json.set(`${table}:${key}`, structuredClone(value)); }),
        storeSetBlob: vi.fn(async (_table, key, data) => { blobs.set(key, data); }),
        storeGetBlob: vi.fn(async (_table, key) => {
            const blob = blobs.get(key);
            if (!blob)
                throw new Error('missing blob');
            return blob;
        }),
        storeDeleteBlob: vi.fn(async (_table, key) => {
            if (!blobs.delete(key))
                throw new Error('Not found: Extension store blob not found');
        }),
        storeDeleteTable: vi.fn(async () => { blobs.clear(); for (const key of [...json.keys()])
            if (key.startsWith('logs:'))
                json.delete(key); }),
        getHostConsoleCaptureEnabled: vi.fn(async () => false),
        assertFrontendLogsCapability: vi.fn(() => ({ list: vi.fn(), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() })),
        listFrontendLogs: vi.fn(async () => []),
        subscribeFrontendLogs: vi.fn(async () => vi.fn()),
    };
    return { host: host, json, blobs };
}
describe('logging schema and projection', () => {
    it('defaults to disabled-safe recording settings and validates byte bounds', () => {
        expect(parseLogSettings(undefined)).toEqual(createDefaultLogSettings());
        expect(() => parseLogSettings({ ...createDefaultLogSettings(), maxBytes: MIB - 1 })).toThrow(/1 MiB/);
        expect(() => parseLogIndex({ schemaVersion: 1, sessions: [{ id: 'bad', chunks: [] }] })).toThrow();
    });
    it('keeps sensitive values only in full mode and safely serializes cycles', () => {
        const cyclic = {};
        cyclic.self = cyclic;
        expect(projectLogPayload({ ok: true }, { secret: 'text' }, false)).toEqual({ data: { ok: true } });
        expect(projectLogPayload({}, cyclic, true).sensitive).toEqual({ self: '[Circular]' });
        const bounded = boundLogEvent({ data: 'x'.repeat(300_000) });
        expect(bounded.truncated).toBe(true);
        expect(bounded.originalBytes).toBeGreaterThan(256 * 1024);
    });
});
const context = (featureId = 'test', source = 'runtime') => ({ featureId, source });

describe('ToolkitLogger', () => {
    it('writes nothing while disabled and redacts sensitive event fields', async () => {
        const { host, blobs } = createHost();
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        logger.scoped(context()).info('ignored', { sensitive: { secret: 'no' } });
        expect(blobs.size).toBe(0);
        await logger.start();
        logger.scoped(context()).info('recorded', { data: { count: 1 }, sensitive: { secret: 'hidden' } });
        await logger.stop();
        const id = logger.state.sessions[0]?.id ?? '';
        const events = await logger.loadSession(id);
        expect(events.some(event => event.event === 'recorded')).toBe(true);
        expect(events.find(event => event.event === 'recorded')).toMatchObject({ featureId: 'test', source: 'runtime' });
        expect(events.find(event => event.event === 'recorded')).not.toHaveProperty('sensitive');
    });
    it('persists useful read-only chat diagnostics in redacted JSON and LOG exports without private values', async () => {
        const { host } = createHost({ ...createDefaultLogSettings(), consoleLevel: 'off' });
        host.snapshot = vi.fn(async () => ({
            identity: { stableId: 'private-chat-identity', ref: { kind: 'character', characterId: 'private-character', fileName: 'private-file' } },
            messages: [{ is_user: true, name: 'private-speaker', mes: 'private-good-body' }, { mes: { secret: 'private-bad-body' } }],
        }));
        host.chatAlias = () => 'chat-1';
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        const runtime = new ChatExporterRuntime(host, logger.scoped(context('chat-exporter', 'chat-exporter')));
        const plan = await runtime.preview(1, 2);
        await expect(runtime.prepareDownload('private-title')).rejects.toMatchObject({ code: 'EXPORT_CONFIRM_REQUIRED' });
        await runtime.prepareDownload('private-title', true, plan);
        await logger.stop();
        const sessionId = logger.state.sessions[0].id;
        const events = await logger.loadSession(sessionId);
        const issue = events.find(event => event.event === 'message.degraded');
        expect(issue).toMatchObject({ level: 'warn', data: {
            code: 'MESSAGE_BODY_NOT_STRING', field: 'mes', expected: 'string', actualType: 'object', absoluteIndex: 1, conversationIndex: 2,
            outcome: 'unreadable-placeholder', nextAction: 'inspect-message-or-confirm-export-skip', sourceLocation: 'kernel/chat-projection.js:projectConversationSnapshot',
        } });
        const entries = events.map(event => ({ sessionId, event }));
        for (const format of ['json', 'log']) {
            const exported = logger.exportEntries(entries, format);
            expect(exported).toContain('MESSAGE_BODY_NOT_STRING');
            expect(exported).toContain('absoluteIndex');
            expect(exported).not.toContain('private-');
        }
        expect(events.filter(event => event.featureId === 'chat-exporter').some(event => event.level === 'error')).toBe(false);
    });

    it('persists full mode across settings and exports json and log formats', async () => {
        const settings = { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' };
        const { host } = createHost(settings);
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        logger.scoped(context('chat-cleaner', 'transaction')).warn('sample', { data: { index: 3 }, sensitive: { before: 'secret text' } });
        await logger.stop();
        const sessionId = logger.state.sessions[0].id;
        const entries = (await logger.loadSession(sessionId)).map(event => ({ sessionId, event }));
        const json = logger.exportEntries(entries, 'json');
        const text = logger.exportEntries(entries, 'log');
        expect(JSON.parse(json).sessions[0].events.some((event) => Boolean(event.sensitive))).toBe(true);
        expect(text).toContain('secret text');
        expect(text).toContain('[chat-cleaner][transaction]');
        expect(logger.state.settings.privacyMode).toBe('full');
    });
    it('starts a new session when the privacy mode changes', async () => {
        const { host } = createHost();
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        await logger.saveSettings({ ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off' });
        expect(logger.state.enabled).toBe(true);
        expect(logger.state.sessions).toHaveLength(2);
        expect(logger.state.sessions[0]?.privacyMode).toBe('redacted');
        expect(logger.state.sessions[1]?.privacyMode).toBe('full');
        await logger.stop();
    });
    it('enforces the configured total byte capacity by dropping old chunks', async () => {
        const settings = { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off', maxBytes: MIB };
        const { host } = createHost(settings);
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        for (let index = 0; index < 10; index += 1)
            logger.scoped(context('test', 'large')).info('payload', { sensitive: { text: `${index}:${'x'.repeat(180_000)}` } });
        await logger.stop();
        const session = logger.state.sessions[0];
        expect(session?.bytes).toBeLessThanOrEqual(MIB);
        expect(session?.droppedBytes).toBeGreaterThan(0);
    });
    it('keeps chunk numbers increasing across repeated retention and deletes the closed session only once', async () => {
        const settings = { ...createDefaultLogSettings(), privacyMode: 'full', consoleLevel: 'off', maxBytes: MIB };
        const { host, blobs, json } = createHost(settings);
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        const firstId = logger.state.currentSessionId;
        for (let index = 0; index < 16; index += 1) {
            logger.scoped(context()).info('payload', { data: { index }, sensitive: { text: 'x'.repeat(180_000) } });
            await logger.flush();
        }
        await logger.stop();
        const first = logger.state.sessions.find(session => session.id === firstId);
        expect(first.droppedBytes).toBeGreaterThan(0);
        const written = host.storeSetBlob.mock.calls.map(([, key]) => key);
        expect(new Set(written).size).toBe(written.length);
        expect(first.chunks.every(chunk => blobs.has(chunk.key))).toBe(true);
        const loaded = await logger.loadSession(firstId);
        expect(loaded).toHaveLength(first.chunks.reduce((sum, chunk) => sum + chunk.eventCount, 0));
        expect(new Set(loaded.map(event => event.sequence)).size).toBe(loaded.length);
        expect(loaded.filter(event => event.event === 'payload').at(-1).data.index).toBe(15);
        expect(parseLogIndex(json.get('logs:index-v2'))).toEqual(json.get('logs:index-v2'));
        await logger.start();
        for (let index = 0; index < 8; index += 1) {
            logger.scoped(context()).info('new-payload', { sensitive: { text: 'x'.repeat(180_000) } });
            await logger.flush();
        }
        await logger.stop();
        expect(logger.state.persistenceError).toBe('');
        expect(logger.state.sessions.some(session => session.id === firstId)).toBe(false);
        const deleted = host.storeDeleteBlob.mock.calls.map(([, key]) => key);
        expect(new Set(deleted).size).toBe(deleted.length);
        expect(blobs.size).toBe(logger.state.sessions[0].chunks.length);
    });
    it('allocates unique numbers for queued flushes even when every chunk is immediately evicted', async () => {
        const { host, blobs } = createHost({ ...createDefaultLogSettings(), consoleLevel: 'off' });
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        // Force the empty-chunk edge case without generating MiB-sized events.
        logger.mutable.settings.maxBytes = 1;
        const flushes = [];
        for (let index = 0; index < 8; index += 1) {
            logger.scoped(context()).info('payload', { data: { index } });
            flushes.push(logger.flush());
        }
        await Promise.all(flushes);
        await logger.stop();
        const written = host.storeSetBlob.mock.calls.map(([, key]) => key);
        expect(new Set(written).size).toBe(written.length);
        expect(logger.state.persistenceError).toBe('');
        expect(blobs.size).toBe(0);
        expect(logger.state.sessions[0].chunks).toEqual([]);
    });
    it('blocks duplicate chunk indexes without deleting data and recovers only after explicit clear', async () => {
        const { host, blobs, json } = createHost({ ...createDefaultLogSettings(), consoleLevel: 'off' });
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        await logger.stop();
        const index = json.get('logs:index-v2');
        index.sessions[0].chunks.push(structuredClone(index.sessions[0].chunks[0]));
        expect(() => parseLogIndex(index)).toThrow(/重复分块/);
        const crossSession = structuredClone(index);
        crossSession.sessions[0].chunks.pop();
        crossSession.sessions.push(structuredClone(crossSession.sessions[0]));
        expect(() => parseLogIndex(crossSession)).toThrow(/重复分块/);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const restarted = new ToolkitLogger(host);
            await restarted.initialize();
            expect(restarted.state.persistenceError).toContain('手动清空');
            expect(blobs.size).toBeGreaterThan(0);
            expect(host.storeDeleteBlob).not.toHaveBeenCalled();
            expect(host.storeDeleteTable).not.toHaveBeenCalled();
            await expect(restarted.start()).rejects.toThrow(/清空日志/);
            expect(warn).toHaveBeenCalledWith('[TT-Toolkit][system][logger][index.invalid]', expect.objectContaining({
                code: 'DUPLICATE_LOG_CHUNK', field: 'sessions.chunks.key', sessionIndex: 0, chunkIndex: 1,
                outcome: 'log-storage-blocked',
            }));
            expect(JSON.stringify(warn.mock.calls)).not.toContain(index.sessions[0].id);
            await restarted.clearLogs();
            expect(blobs.size).toBe(0);
            await restarted.start();
            await restarted.stop();
            expect(restarted.state.persistenceError).toBe('');
        }
        finally {
            warn.mockRestore();
        }
    });
    it.each(['blob-write', 'retention', 'index-write'])('reports %s persistence failure as memory-only with safe warning diagnostics', async phase => {
        const { host } = createHost({ ...createDefaultLogSettings(), consoleLevel: 'off' });
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        await logger.start();
        const error = new Error('private-storage-error');
        if (phase === 'blob-write')
            host.storeSetBlob.mockRejectedValueOnce(error);
        else if (phase === 'retention')
            vi.spyOn(logger, 'enforceRetention').mockRejectedValueOnce(error);
        else
            host.storeSetJson.mockRejectedValueOnce(error);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await logger.flush();
            expect(logger.state.persistenceError).toContain('当前日志继续保留在内存');
            expect(logger.state.persistenceError).toContain(phase);
            expect(logger.persistenceAvailable).toBe(false);
            expect(warn).toHaveBeenCalledWith('[TT-Toolkit][system][logger][persistence.failed]', expect.objectContaining({
                phase, code: { 'blob-write': 'LOG_BLOB_WRITE_FAILED', retention: 'LOG_RETENTION_FAILED', 'index-write': 'LOG_INDEX_WRITE_FAILED' }[phase],
                chunkSequence: 1, outcome: 'memory-only',
            }));
            expect(JSON.stringify(warn.mock.calls)).not.toContain('private-storage-error');
            logger.scoped(context()).info('still-in-memory');
            expect((await logger.loadSession(logger.state.currentSessionId)).some(event => event.event === 'session.started')).toBe(true);
            expect(logger.state.currentEntries.some(event => event.event === 'still-in-memory')).toBe(true);
            await logger.stop();
        }
        finally {
            warn.mockRestore();
        }
    });
    it('blocks legacy logs until the log table is explicitly cleared', async () => {
        const { host, json } = createHost();
        json.set('logs:index-v1', { schemaVersion: 1, sessions: [] });
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        expect(logger.state.legacyLogsDetected).toBe(true);
        await expect(logger.start()).rejects.toThrow(/清空日志/);
        await logger.clearLogs();
        expect(logger.state.legacyLogsDetected).toBe(false);
        expect(json.get('logs:index-v2')).toEqual({ schemaVersion: 2, sessions: [] });
    });
    it('exports an empty filtered result as valid empty JSON or LOG', async () => {
        const { host } = createHost();
        const logger = new ToolkitLogger(host);
        await logger.initialize();
        expect(JSON.parse(logger.exportEntries([], 'json')).sessions).toEqual([]);
        expect(logger.exportEntries([], 'log')).toBe('');
    });
});
