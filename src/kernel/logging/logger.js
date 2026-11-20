import { ToolkitError, errorKind, errorMessage } from '../errors.js';
import { createDefaultLogIndex, createDefaultLogSettings, levelEnabled, parseLogIndex, parseLogSettings } from './schema.js';
import { boundLogEvent, projectLogPayload } from './serialize.js';
import {
    acceptHostEntry,
    degradeHostStream,
    mergeHostEntries,
    probeHostFrontendLogs,
    recordHostEntry,
    rollbackStart,
    stopHostStream,
} from './host-stream.js';
import { createRedactor } from './redaction.js';
import {
    FLUSH_BYTES,
    INDEX_KEY,
    LOG_TABLE,
    bytes,
    clearFlushTimer,
    deleteSessionBlobs,
    enforceRetention,
    eventLine,
    exportEntries,
    flush,
    loadSession,
    persistIndexSafely,
    scheduleFlush,
    sessionId,
    syncSessions,
    trimMemory,
} from './session-store.js';

const SETTINGS_KEY = 'logger-settings-v1';
const LEGACY_INDEX_KEY = 'index-v1';

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
    hostSubscriptionCancel = null;
    hostIdSet = new Set();
    redactor = createRedactor();
    operationQueue = Promise.resolve();
    mutable = {
        enabled: false,
        settings: createDefaultLogSettings(),
        sessions: [],
        currentSessionId: null,
        currentEntries: [],
        stoppedMemorySession: null,
        persistenceError: '',
        configurationError: '',
        legacyLogsDetected: false,
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
        probeHostFrontendLogs(this);
        await this.loadProtectedValues();
        globalThis.addEventListener('pagehide', () => { if (this.mutable.enabled)
            void this.flush(); });
        this.notify();
    }
    loadProtectedValues() {
        return this.redactor.load(this.host);
    }
    get protectedValuesError() {
        return this.redactor.error;
    }
    protectValues(values) {
        this.redactor.protect(values);
    }
    redactProtected(value) {
        return this.redactor.redact(value);
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
        if (this.redactor.error)
            throw new Error(this.redactor.error);
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
        return mergeHostEntries(tail, buffer);
    }
    rollbackStart(subscribeCancel, contractFailed, error, pendingSession = null) {
        rollbackStart(this, subscribeCancel, contractFailed, error, pendingSession);
    }
    acceptHostEntry(entry) {
        acceptHostEntry(this, entry);
    }
    degradeHostStream(error) {
        degradeHostStream(this, error);
    }
    recordHostEntry(entry) {
        recordHostEntry(this, entry);
    }
    async _stopInternal() {
        if (!this.mutable.enabled)
            return;
        stopHostStream(this);
        this.record('info', 'system', 'logger', 'session.stopping');
        this.mutable.enabled = false;
        this.clearFlushTimer();
        try {
            await this.flush();
            await this.flushQueue;
        }
        finally {
            if (this.current) {
                this.current.endedAt = new Date().toISOString();
                if (!this.persistenceAvailable)
                    this.mutable.stoppedMemorySession = { id: this.current.id, entries: this.mutable.currentEntries };
            }
            this.current = null;
            this.mutable.currentSessionId = null;
            this.mutable.currentEntries = [];
            this.pending = [];
            this.pendingBytes = 0;
            this.memoryBytes = 0;
            this.hostIdSet = new Set();
            this.syncSessions();
            if (!this.storageBlocked)
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
            this.trimMemory();
            const retention = this.flushQueue.then(async () => {
                if (!this.storageBlocked) {
                    await this.enforceRetention();
                    await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
                }
            });
            this.flushQueue = retention.catch(() => undefined);
            await retention;
            this.notify();
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
        let phase = 'delete-table';
        try {
            await this.host.storeDeleteTable(LOG_TABLE).catch(error => {
                if (!(error instanceof ToolkitError) || error.code !== 'STORE_TABLE_NOT_FOUND')
                    throw error;
            });
            this.index = createDefaultLogIndex();
            this.mutable.currentEntries = [];
            this.mutable.stoppedMemorySession = null;
            this.mutable.legacyLogsDetected = false;
            this.syncSessions();
            phase = 'empty-index-write';
            try {
                await this.host.storeSetJson(LOG_TABLE, INDEX_KEY, this.index);
            }
            catch (error) {
                this.persistenceAvailable = false;
                this.storageBlocked = true;
                this.mutable.persistenceError = '日志已删除，但空索引写入失败。请检查存储后重新加载工具箱。';
                this.notify();
                throw error;
            }
            this.mutable.persistenceError = '';
            this.persistenceAvailable = true;
            this.storageBlocked = false;
            this.notify();
        }
        catch (error) {
            console.warn('[TT-Toolkit][system][logger][logs.clear_failed]', {
                operation: 'logs.clear', phase, sourceLocation: 'kernel/logging/logger.js:_clearLogsInternal',
                code: phase === 'delete-table' ? 'LOG_TABLE_DELETE_FAILED' : 'LOG_EMPTY_INDEX_WRITE_FAILED',
                outcome: 'clear-incomplete', nextAction: phase === 'delete-table' ? 'inspect-log-storage-and-retry' : 'inspect-log-storage-and-reload',
            });
            throw error;
        }
        if (restart)
            await this._startInternal({ importHostTail: false });
    }
    async loadSession(id) {
        return loadSession(this, id);
    }
    exportEntries(entries, format) {
        return exportEntries(this, entries, format);
    }
    record(level, featureId, source, event, input = {}) {
        this.recordInternal(level, featureId, source, event, input, true);
    }
    recordInternal(level, featureId, source, event, input, forwardConsole) {
        if (!this.mutable.enabled || !this.current || !levelEnabled(level, this.mutable.settings.minimumLevel))
            return;
        const full = this.mutable.settings.privacyMode === 'full';
        const payload = projectLogPayload(input.data, input.sensitive, full);
        if (this.redactor.size > 0) {
            if (payload.data !== undefined)
                payload.data = this.redactor.redact(payload.data);
            if (payload.sensitive !== undefined)
                payload.sensitive = this.redactor.redact(payload.sensitive);
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
        if (this.persistenceAvailable) {
            this.pending.push(bounded);
            this.pendingBytes += lineBytes;
        }
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
        trimMemory(this);
    }
    scheduleFlush() {
        scheduleFlush(this);
    }
    clearFlushTimer() {
        clearFlushTimer(this);
    }
    flush() {
        return flush(this);
    }
    enforceRetention() {
        return enforceRetention(this);
    }
    async deleteSessionBlobs(session) {
        return deleteSessionBlobs(this, session);
    }
    persistIndexSafely() {
        return persistIndexSafely(this);
    }
    syncSessions() {
        syncSessions(this);
    }
}
