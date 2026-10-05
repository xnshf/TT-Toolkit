import { errorKind, errorMessage } from '../errors.js';
import { createDefaultLogIndex, createDefaultLogSettings, levelEnabled, parseLogIndex, parseLogSettings } from './schema.js';
import { boundLogEvent, projectLogPayload } from './serialize.js';
const SETTINGS_KEY = 'logger-settings-v1';
const LOG_TABLE = 'logs';
const INDEX_KEY = 'index-v2';
const LEGACY_INDEX_KEY = 'index-v1';
const LLM_PRESETS_KEY = 'llm-presets-v1';
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BYTES = 256 * 1024;
const REDACTED_PROTECTED_VALUE = '[REDACTED_PROTECTED_VALUE]';
const PROTECTED_PRESET_FIELDS = ['name', 'apiUrl', 'model', 'apiKey'];
const REFLUX_PREFIX_PATTERN = /^\[TT-Toolkit\]\[[^\]\n]+\]\[[^\]\n]+\]\[[^\]\n]+\]/;
function sessionId() {
    return `s-${Date.now()}-${crypto.randomUUID()}`;
}
function eventLine(event) {
    return `${JSON.stringify(event)}\n`;
}
function bytes(text) {
    return new TextEncoder().encode(text).byteLength;
}
function cloneSession(session) {
    return structuredClone(session);
}
export class ToolkitLogger {
    host;
    index = createDefaultLogIndex();
    current = null;
    pending = [];
    pendingBytes = 0;
    nextSequence = 1;
    nextChunkSequence = 1;
    flushTimer = null;
    flushQueue = Promise.resolve();
    memoryBytes = 0;
    persistenceAvailable = true;
    storageBlocked = false;
    volatileSessions = new Map();
    hostSubscriptionCancel = null;
    hostIdSet = new Set();
    protectedValues = new Set();
    protectedValuesError = '';
    operationQueue = Promise.resolve();
    mutable = {
        enabled: false,
        settings: createDefaultLogSettings(),
        sessions: [],
        currentSessionId: null,
        currentEntries: [],
        persistenceError: '',
        configurationError: '',
        legacyLogsDetected: false,
        hostConsoleCaptureEnabled: null,
        hostConsoleCaptureError: '',
        hostFrontendStatus: { phase: 'idle', code: '', message: '', importedCount: 0 },
    };
    state = this.mutable;
    listeners = new Set();
    notifyScheduled = false;
    constructor(host) {
        this.host = host;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    notify() {
        if (this.notifyScheduled)
            return;
        this.notifyScheduled = true;
        queueMicrotask(() => {
            this.notifyScheduled = false;
            for (const listener of this.listeners)
                listener(this.state);
        });
    }
    enqueue(task) {
        const result = this.operationQueue.then(task, task);
        this.operationQueue = result.catch(() => undefined);
        return result;
    }
    async initialize() {
        try {
            this.mutable.settings = parseLogSettings(await this.host.globalGet(SETTINGS_KEY));
        }
        catch (error) {
            this.mutable.settings = createDefaultLogSettings();
            this.mutable.configurationError = errorMessage(error);
        }
        try {
            const storedIndex = await this.host.storeTryGetJson(LOG_TABLE, INDEX_KEY);
            const legacyIndex = storedIndex === undefined || storedIndex === null
                ? await this.host.storeTryGetJson(LOG_TABLE, LEGACY_INDEX_KEY)
                : null;
            if (legacyIndex !== undefined && legacyIndex !== null)
                parseLogIndex(legacyIndex);
            this.index = parseLogIndex(storedIndex);
            const interruptedAt = new Date().toISOString();
            for (const session of this.index.sessions) {
                if (session.endedAt === null) {
                    session.endedAt = interruptedAt;
                    session.interrupted = true;
                }
            }
            this.syncSessions();
        }
        catch (error) {
            this.index = createDefaultLogIndex();
            this.storageBlocked = true;
            this.mutable.legacyLogsDetected = error?.code === 'LEGACY_LOG_SCHEMA';
            this.mutable.persistenceError = this.mutable.legacyLogsDetected
                ? errorMessage(error)
                : `日志索引读取失败：${errorMessage(error)}`;
            if (error?.code === 'DUPLICATE_LOG_CHUNK') {
                console.warn('[TT-Toolkit][system][logger][index.invalid]', {
                    operation: 'logs.initialize', phase: 'index-validation', code: error.code,
                    sourceLocation: 'kernel/logging/schema.js:parseLogIndex',
                    field: 'sessions.chunks.key', expected: 'unique blob key',
                    sessionIndex: error.context.sessionIndex, chunkIndex: error.context.chunkIndex,
                    outcome: 'log-storage-blocked', nextAction: 'back-up-log-storage-and-clear-logs',
                });
            }
        }
        await this.probeHostFrontendLogs();
        await this.loadProtectedValues();
        globalThis.addEventListener('pagehide', () => { if (this.mutable.enabled)
            void this.flush(); });
        this.notify();
    }
    async probeHostFrontendLogs() {
        try {
            this.host.assertFrontendLogsCapability();
            this.mutable.hostFrontendStatus = { phase: 'idle', code: '', message: '', importedCount: 0 };
        }
        catch (error) {
            this.mutable.hostFrontendStatus = {
                phase: 'unavailable',
                code: error?.code ?? 'HOST_FRONTEND_LOGS_MISSING',
                message: errorMessage(error),
                importedCount: 0,
            };
        }
        if (this.mutable.hostFrontendStatus.phase !== 'unavailable') {
            try {
                this.mutable.hostConsoleCaptureEnabled = await this.host.getHostConsoleCaptureEnabled();
                this.mutable.hostConsoleCaptureError = '';
            }
            catch (error) {
                this.mutable.hostConsoleCaptureEnabled = null;
                this.mutable.hostConsoleCaptureError = errorMessage(error);
            }
        }
    }
    async loadProtectedValues() {
        this.protectedValuesError = '';
        try {
            const raw = await this.host.globalGet(LLM_PRESETS_KEY);
            if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
                const presets = Array.isArray(raw.presets) ? raw.presets : [];
                for (const preset of presets)
                    this.protectValues(preset);
            }
        }
        catch (error) {
            this.protectedValuesError = `模型预设值保护不可用：${errorMessage(error)}`;
        }
    }
    protectValues(values) {
        if (Array.isArray(values)) {
            for (const item of values)
                this.protectValues(item);
            return;
        }
        if (!values || typeof values !== 'object')
            return;
        if (Array.isArray(values.presets)) {
            for (const preset of values.presets)
                this.protectValues(preset);
        }
        for (const key of PROTECTED_PRESET_FIELDS) {
            const value = values[key];
            if (typeof value === 'string' && value)
                this.protectedValues.add(value);
        }
    }
    redactProtected(value, seen = new WeakSet()) {
        if (typeof value === 'string')
            return this.protectedValues.has(value) ? REDACTED_PROTECTED_VALUE : value;
        if (value === null || value === undefined || typeof value !== 'object')
            return value;
        if (seen.has(value))
            return value;
        seen.add(value);
        if (Array.isArray(value))
            return value.map(item => this.redactProtected(item, seen));
        const output = {};
        for (const [key, item] of Object.entries(value))
            output[key] = this.redactProtected(item, seen);
        return output;
    }
    scoped(context) {
        if (!context || typeof context !== 'object' || typeof context.featureId !== 'string' || !context.featureId || typeof context.source !== 'string' || !context.source)
            throw new TypeError('日志上下文必须包含非空 featureId 和 source');
        const { featureId, source } = context;
        return {
            debug: (event, input) => this.record('debug', featureId, source, event, input),
            info: (event, input) => this.record('info', featureId, source, event, input),
            warn: (event, input) => this.record('warn', featureId, source, event, input),
            error: (event, input) => this.record('error', featureId, source, event, input),
            fail: (event, operation, error, options = {}) => {
                const includeError = options.includeError !== false;
                const data = { operation, ...errorKind(error) };
                this.record('error', featureId, source, event, includeError ? { data, sensitive: { error } } : { data });
            },
        };
    }
    start(options = {}) {
        return this.enqueue(() => this._startInternal(options));
    }
    stop() {
        return this.enqueue(() => this._stopInternal());
    }
    async _startInternal({ importHostTail = true } = {}) {
        if (this.mutable.enabled)
            return;
        if (this.mutable.configurationError)
            throw new Error(`日志设置不可用：${this.mutable.configurationError}`);
        if (this.storageBlocked)
            throw new Error(`日志存储不可用，请先清空日志：${this.mutable.persistenceError}`);
        if (this.protectedValuesError)
            throw new Error(this.protectedValuesError);
        this.mutable.hostFrontendStatus = { phase: 'starting', code: '', message: '', importedCount: 0 };
        this.notify();
        let subscribeCancel = null;
        let tailEntries = [];
        const initBuffer = [];
        let realtime = false;
        let contractFailed = null;
        const onEntry = entry => {
            if (realtime && this.mutable.enabled)
                this.acceptHostEntry(entry);
            else
                initBuffer.push(entry);
        };
        const onContractError = error => {
            if (realtime)
                this.degradeHostStream(error);
            else
                contractFailed ??= error;
        };
        let pendingSession = null;
        try {
            this.host.assertFrontendLogsCapability();
            try {
                this.mutable.hostConsoleCaptureEnabled = await this.host.getHostConsoleCaptureEnabled();
                this.mutable.hostConsoleCaptureError = '';
            }
            catch (error) {
                this.mutable.hostConsoleCaptureEnabled = null;
                this.mutable.hostConsoleCaptureError = errorMessage(error);
            }
            subscribeCancel = await this.host.subscribeFrontendLogs(onEntry, onContractError);
            if (contractFailed)
                throw contractFailed;
            if (importHostTail) {
                tailEntries = await this.host.listFrontendLogs();
                if (contractFailed)
                    throw contractFailed;
            }
            const session = {
                id: sessionId(),
                startedAt: new Date().toISOString(),
                endedAt: null,
                interrupted: false,
                privacyMode: this.mutable.settings.privacyMode,
                eventCount: 0,
                bytes: 0,
                droppedBytes: 0,
                chunks: [],
            };
            pendingSession = session;
            this.index.sessions.push(session);
            await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
            if (contractFailed)
                throw contractFailed;
            this.current = session;
            this.mutable.currentSessionId = session.id;
            this.mutable.currentEntries = [];
            this.memoryBytes = 0;
            this.nextSequence = 1;
            this.nextChunkSequence = 1;
            this.hostIdSet = new Set();
            this.mutable.enabled = true;
            this.mutable.persistenceError = '';
            this.mutable.legacyLogsDetected = false;
            this.persistenceAvailable = true;
            this.storageBlocked = false;
            this.volatileSessions.clear();
            this.syncSessions();
            this.record('info', 'system', 'logger', 'session.started', { data: { privacyMode: session.privacyMode, maxBytes: this.mutable.settings.maxBytes } });
            const merged = this.mergeHostEntries(tailEntries, initBuffer);
            for (const entry of merged)
                this.acceptHostEntry(entry);
            realtime = true;
            this.hostSubscriptionCancel = subscribeCancel;
            this.mutable.hostFrontendStatus = {
                phase: 'active',
                code: '',
                message: '',
                importedCount: merged.length,
            };
            this.notify();
        }
        catch (error) {
            this.rollbackStart(subscribeCancel, contractFailed, error, pendingSession);
            throw error;
        }
    }
    mergeHostEntries(tail, buffer) {
        const seen = new Set();
        const merged = [];
        for (const entry of [...tail, ...buffer]) {
            if (!seen.has(entry.id)) {
                seen.add(entry.id);
                merged.push(entry);
            }
        }
        return merged.sort((left, right) => left.id - right.id);
    }
    rollbackStart(subscribeCancel, contractFailed, error, pendingSession = null) {
        this.mutable.enabled = false;
        this.hostIdSet = new Set();
        this.hostSubscriptionCancel = null;
        this.pending = [];
        this.pendingBytes = 0;
        if (subscribeCancel) {
            try {
                subscribeCancel();
            }
            catch {
                // 取消订阅失败不改变启动失败结论
            }
        }
        const sessionToRemove = this.current ?? pendingSession;
        if (sessionToRemove && this.index.sessions.includes(sessionToRemove)) {
            const index = this.index.sessions.indexOf(sessionToRemove);
            this.index.sessions.splice(index, 1);
        }
        this.current = null;
        this.mutable.currentSessionId = null;
        this.mutable.currentEntries = [];
        this.memoryBytes = 0;
        this.syncSessions();
        const failed = contractFailed ?? error;
        this.mutable.hostFrontendStatus = {
            phase: 'unavailable',
            code: failed?.code ?? 'HOST_FRONTEND_LOGS_MISSING',
            message: errorMessage(failed),
            importedCount: 0,
        };
        this.notify();
    }
    acceptHostEntry(entry) {
        if (this.hostIdSet.has(entry.id))
            return;
        this.hostIdSet.add(entry.id);
        if (REFLUX_PREFIX_PATTERN.test(entry.message))
            return;
        if (levelEnabled(entry.level, this.mutable.settings.minimumLevel))
            this.recordHostEntry(entry);
    }
    degradeHostStream(error) {
        if (this.mutable.hostFrontendStatus.phase === 'degraded')
            return;
        const cancel = this.hostSubscriptionCancel;
        this.hostSubscriptionCancel = null;
        if (cancel) {
            try {
                cancel();
            }
            catch {
                // 取消订阅失败不改变降级结论
            }
        }
        this.mutable.hostFrontendStatus = {
            phase: 'degraded',
            code: error?.code ?? '',
            message: errorMessage(error),
            importedCount: this.mutable.hostFrontendStatus.importedCount ?? 0,
        };
        this.record('error', 'system', 'logger', 'host.stream_contract_failed', {
            data: { operation: 'host.stream.contract', ...errorKind(error) },
        });
        this.notify();
    }
    recordHostEntry(entry) {
        this.recordInternal(entry.level, 'system', 'host-frontend', 'host.frontend_log', {
            data: {
                hostEntryId: entry.id,
                hostTimestampMs: entry.timestampMs,
                hostLevel: entry.level,
                messagePresent: entry.message.length > 0,
            },
            sensitive: {
                message: entry.message,
                ...(entry.target !== undefined ? { target: entry.target } : {}),
            },
        }, false);
    }
    async _stopInternal() {
        if (!this.mutable.enabled)
            return;
        const cancel = this.hostSubscriptionCancel;
        this.hostSubscriptionCancel = null;
        if (cancel) {
            try {
                cancel();
            }
            catch {
                // 取消订阅失败不阻塞会话收尾
            }
        }
        this.mutable.hostFrontendStatus = { phase: 'idle', code: '', message: '', importedCount: 0 };
        this.record('info', 'system', 'logger', 'session.stopping');
        this.mutable.enabled = false;
        this.clearFlushTimer();
        try {
            await this.flush();
            await this.flushQueue;
        }
        finally {
            if (this.current)
                this.current.endedAt = new Date().toISOString();
            this.current = null;
            this.mutable.currentSessionId = null;
            this.mutable.currentEntries = [];
            this.pending = [];
            this.pendingBytes = 0;
            this.memoryBytes = 0;
            this.hostIdSet = new Set();
            this.syncSessions();
            await this.persistIndexSafely();
        }
        this.notify();
    }
    async saveSettings(settings) {
        return this.enqueue(() => this._saveSettingsInternal(settings));
    }
    async _saveSettingsInternal(settings) {
        const validated = parseLogSettings(settings);
        const modeChanged = validated.privacyMode !== this.mutable.settings.privacyMode;
        const wasEnabled = this.mutable.enabled;
        if (wasEnabled && modeChanged)
            await this._stopInternal();
        try {
            await this.host.globalSet(SETTINGS_KEY, validated);
            this.mutable.settings = validated;
            this.mutable.configurationError = '';
            await this.enforceRetention();
            if (!this.storageBlocked)
                await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
        }
        catch (error) {
            this.record('warn', 'system', 'logger', 'settings.save_failed', {
                data: { operation: 'settings.save', ...errorKind(error), sourceLocation: 'kernel/logging/logger.js:_saveSettingsInternal', outcome: 'settings-or-retention-incomplete', nextAction: 'inspect-log-storage-and-retry' },
                sensitive: { error },
            });
            throw error;
        }
        finally {
            if (wasEnabled && modeChanged && !this.mutable.enabled && !this.storageBlocked)
                await this._startInternal({ importHostTail: false });
        }
    }
    async resetSettings() {
        return this.enqueue(async () => {
            await this.host.globalDelete(SETTINGS_KEY);
            await this._saveSettingsInternal(createDefaultLogSettings());
        });
    }
    async clearLogs() {
        return this.enqueue(() => this._clearLogsInternal());
    }
    async _clearLogsInternal() {
        const restart = this.mutable.enabled;
        if (restart)
            await this._stopInternal();
        try {
            await this.host.storeDeleteTable(LOG_TABLE);
            this.index = createDefaultLogIndex();
            this.mutable.currentEntries = [];
            this.mutable.persistenceError = '';
            this.mutable.legacyLogsDetected = false;
            this.persistenceAvailable = true;
            this.storageBlocked = false;
            this.volatileSessions.clear();
            this.syncSessions();
            await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
        }
        catch (error) {
            this.record('error', 'system', 'logger', 'logs.clear_failed', {
                data: { operation: 'logs.clear', ...errorKind(error) },
                sensitive: { error },
            });
            throw error;
        }
        if (restart)
            await this._startInternal({ importHostTail: false });
    }
    async loadSession(id) {
        try {
            const volatile = this.volatileSessions.get(id);
            if (volatile)
                return structuredClone(volatile);
            if (id === this.mutable.currentSessionId && !this.persistenceAvailable)
                return structuredClone(this.mutable.currentEntries);
            if (id === this.mutable.currentSessionId)
                await this.flush();
            const session = this.index.sessions.find(item => item.id === id);
            if (!session)
                return [];
            const events = [];
            for (const chunk of session.chunks) {
                const text = await (await this.host.storeGetBlob(LOG_TABLE, chunk.key)).text();
                for (const line of text.split('\n'))
                    if (line.trim())
                        events.push(JSON.parse(line));
            }
            return events;
        }
        catch (error) {
            this.record('error', 'system', 'logger', 'session.load_failed', {
                data: { operation: 'session.load', ...errorKind(error) },
                sensitive: { error },
            });
            throw error;
        }
    }
    exportEntries(entries, format) {
        if (format !== 'json' && format !== 'log')
            throw new TypeError(`不支持的日志导出格式：${String(format)}`);
        const grouped = new Map();
        for (const item of entries) {
            if (!item || typeof item.sessionId !== 'string' || !item.event)
                continue;
            const events = grouped.get(item.sessionId) ?? [];
            events.push(structuredClone(item.event));
            grouped.set(item.sessionId, events);
        }
        const sessions = this.index.sessions
            .filter(session => grouped.has(session.id))
            .map(session => ({ meta: cloneSession(session), events: grouped.get(session.id) }));
        if (format === 'json')
            return JSON.stringify({ schemaVersion: 2, plugin: 'TT-Toolkit', exportedAt: new Date().toISOString(), sessions }, null, 2);
        const lines = [];
        for (const session of sessions) {
            lines.push(`=== ${session.meta.id} | ${session.meta.startedAt} | ${session.meta.privacyMode} ===`);
            for (const event of session.events) {
                const payload = event.sensitive === undefined ? event.data : { data: event.data, sensitive: event.sensitive };
                lines.push(`${event.timestamp} ${event.level.toUpperCase()} [${event.featureId}][${event.source}] ${event.event} ${JSON.stringify(payload)}`);
            }
        }
        return lines.length ? `${lines.join('\n')}\n` : '';
    }
    async refreshHostConsoleCaptureStatus() {
        try {
            this.mutable.hostConsoleCaptureEnabled = await this.host.getHostConsoleCaptureEnabled();
            this.mutable.hostConsoleCaptureError = '';
        }
        catch (error) {
            this.mutable.hostConsoleCaptureEnabled = null;
            this.mutable.hostConsoleCaptureError = errorMessage(error);
            this.record('error', 'system', 'logger', 'host.status_refresh_failed', {
                data: { operation: 'host.status.refresh', ...errorKind(error) },
                sensitive: { error },
            });
        }
        this.notify();
    }
    record(level, featureId, source, event, input = {}) {
        this.recordInternal(level, featureId, source, event, input, true);
    }
    recordInternal(level, featureId, source, event, input, forwardConsole) {
        if (!this.mutable.enabled || !this.current || !levelEnabled(level, this.mutable.settings.minimumLevel))
            return;
        const full = this.mutable.settings.privacyMode === 'full';
        const payload = projectLogPayload(input.data, input.sensitive, full);
        if (this.protectedValues.size > 0) {
            if (payload.data !== undefined)
                payload.data = this.redactProtected(payload.data);
            if (payload.sensitive !== undefined)
                payload.sensitive = this.redactProtected(payload.sensitive);
        }
        const bounded = boundLogEvent({
            sequence: this.nextSequence++,
            timestamp: new Date().toISOString(),
            level,
            featureId,
            source,
            event,
            ...payload,
            privacyMode: this.mutable.settings.privacyMode,
        });
        const lineBytes = bytes(eventLine(bounded));
        this.pending.push(bounded);
        this.pendingBytes += lineBytes;
        this.current.eventCount += 1;
        this.mutable.currentEntries.push(bounded);
        this.memoryBytes += lineBytes;
        this.trimMemory();
        this.syncSessions();
        if (forwardConsole)
            this.forwardConsole(bounded);
        if (!this.persistenceAvailable)
            return;
        if (this.pendingBytes >= FLUSH_BYTES)
            void this.flush();
        else
            this.scheduleFlush();
    }
    forwardConsole(event) {
        const threshold = this.mutable.settings.consoleLevel;
        if (threshold === 'off' || !levelEnabled(event.level, threshold))
            return;
        const args = [`[TT-Toolkit][${event.featureId}][${event.source}][${event.event}]`, event.data];
        if (event.sensitive !== undefined)
            args.push(event.sensitive);
        const method = event.level === 'debug' ? console.debug : event.level === 'info' ? console.info : event.level === 'warn' ? console.warn : console.error;
        method(...args);
    }
    trimMemory() {
        const limit = Math.min(this.mutable.settings.maxBytes, 5 * 1024 * 1024);
        while (this.memoryBytes > limit && this.mutable.currentEntries.length > 1) {
            const removed = this.mutable.currentEntries.shift();
            if (removed)
                this.memoryBytes -= bytes(eventLine(removed));
        }
    }
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush();
        }, FLUSH_INTERVAL_MS);
    }
    clearFlushTimer() {
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.flushTimer = null;
    }
    async flush() {
        if (!this.persistenceAvailable)
            return this.flushQueue;
        if (!this.current || this.pending.length === 0)
            return this.flushQueue;
        const session = this.current;
        const batch = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        this.flushQueue = this.flushQueue.then(async () => {
            const text = batch.map(eventLine).join('');
            const blob = new Blob([text], { type: 'application/x-ndjson' });
            const chunkSequence = this.nextChunkSequence++;
            const key = `${session.id}.${String(chunkSequence).padStart(6, '0')}.jsonl`;
            let phase = 'blob-write';
            try {
                await this.host.storeSetBlob(LOG_TABLE, key, blob);
                session.chunks.push({ key, bytes: blob.size, firstSequence: batch[0]?.sequence ?? 0, lastSequence: batch.at(-1)?.sequence ?? 0, eventCount: batch.length });
                session.bytes += blob.size;
                phase = 'retention';
                await this.enforceRetention();
                phase = 'index-write';
                await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
                this.mutable.persistenceError = '';
                this.syncSessions();
            }
            catch (error) {
                this.mutable.persistenceError = `日志持久化失败（${phase}）：${errorMessage(error)}。已暂停日志写入，当前日志继续保留在内存；请先导出可读日志，检查存储后清空日志再重新启用。`;
                this.persistenceAvailable = false;
                this.storageBlocked = true;
                this.volatileSessions.set(session.id, structuredClone(this.mutable.currentEntries));
                console.warn('[TT-Toolkit][system][logger][persistence.failed]', {
                    operation: 'logs.flush', phase,
                    code: { 'blob-write': 'LOG_BLOB_WRITE_FAILED', retention: 'LOG_RETENTION_FAILED', 'index-write': 'LOG_INDEX_WRITE_FAILED' }[phase],
                    sourceLocation: 'kernel/logging/logger.js:flush', chunkSequence, eventCount: batch.length,
                    outcome: 'memory-only', nextAction: 'export-readable-logs-inspect-storage-and-clear-logs',
                });
                this.notify();
            }
        });
        return this.flushQueue;
    }
    async enforceRetention() {
        let total = this.index.sessions.reduce((sum, session) => sum + session.bytes, 0);
        while (total > this.mutable.settings.maxBytes) {
            const oldestClosed = this.index.sessions.find(session => session !== this.current && session.endedAt !== null);
            if (oldestClosed) {
                await this.deleteSessionBlobs(oldestClosed);
                total -= oldestClosed.bytes;
                this.index.sessions.splice(this.index.sessions.indexOf(oldestClosed), 1);
                continue;
            }
            const oldestChunk = this.current?.chunks[0];
            if (!oldestChunk || !this.current)
                break;
            await this.host.storeDeleteBlob(LOG_TABLE, oldestChunk.key);
            this.current.chunks.shift();
            this.current.bytes -= oldestChunk.bytes;
            this.current.droppedBytes += oldestChunk.bytes;
            total -= oldestChunk.bytes;
            while (this.mutable.currentEntries[0] && this.mutable.currentEntries[0].sequence <= oldestChunk.lastSequence)
                this.mutable.currentEntries.shift();
            this.memoryBytes = this.mutable.currentEntries.reduce((sum, event) => sum + bytes(eventLine(event)), 0);
        }
        this.syncSessions();
    }
    async deleteSessionBlobs(session) {
        for (const chunk of session.chunks)
            await this.host.storeDeleteBlob(LOG_TABLE, chunk.key);
    }
    async persistIndexSafely() {
        try {
            await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
        }
        catch (error) {
            this.mutable.persistenceError = `日志索引保存失败：${errorMessage(error)}。请检查存储后重试；如需清空日志，请先导出可读日志。`;
            console.warn('[TT-Toolkit][system][logger][index.failed]', {
                operation: 'logs.index.save', phase: 'index-write', code: 'LOG_INDEX_WRITE_FAILED',
                sourceLocation: 'kernel/logging/logger.js:persistIndexSafely',
                outcome: 'index-not-saved', nextAction: 'inspect-storage-and-retry',
            });
            this.notify();
        }
    }
    syncSessions() {
        this.mutable.sessions = this.index.sessions.map(cloneSession);
        this.notify();
    }
}
