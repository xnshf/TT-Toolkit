import { errorMessage, ToolkitError } from '../errors.js';

export const LOG_TABLE = 'logs';
export const INDEX_KEY = 'index-v2';
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BYTES = 256 * 1024;

export function sessionId() {
    return `s-${Date.now()}-${crypto.randomUUID()}`;
}

export function eventLine(event) {
    return `${JSON.stringify(event)}\n`;
}

export function bytes(text) {
    return new TextEncoder().encode(text).byteLength;
}

export function cloneSession(session) {
    return structuredClone(session);
}

export { FLUSH_BYTES };

// 内存中保留的当前会话事件受用户上限与 5 MiB 双重约束：只丢弃最旧的整条事件。
export function trimMemory(logger) {
    const limit = Math.min(logger.mutable.settings.maxBytes, 5 * 1024 * 1024);
    while (logger.memoryBytes > limit && logger.mutable.currentEntries.length > 1) {
        const removed = logger.mutable.currentEntries.shift();
        if (removed)
            logger.memoryBytes -= bytes(eventLine(removed));
    }
}

export function scheduleFlush(logger) {
    if (logger.flushTimer)
        return;
    logger.flushTimer = setTimeout(() => {
        logger.flushTimer = null;
        void logger.flush();
    }, FLUSH_INTERVAL_MS);
}

export function clearFlushTimer(logger) {
    if (logger.flushTimer)
        clearTimeout(logger.flushTimer);
    logger.flushTimer = null;
}

// 落盘一批事件：blob 写入、保留策略、索引写入三段，任一段失败即暂停持久化并保留内存副本。
export async function flush(logger) {
    if (!logger.persistenceAvailable)
        return logger.flushQueue;
    if (!logger.current || logger.pending.length === 0)
        return logger.flushQueue;
    const session = logger.current;
    const batch = logger.pending;
    logger.pending = [];
    logger.pendingBytes = 0;
    logger.flushQueue = logger.flushQueue.then(async () => {
        // 已排队的批次也必须服从前一批触发的暂停。
        if (!logger.persistenceAvailable || logger.current !== session)
            return;
        const text = batch.map(eventLine).join('');
        const blob = new Blob([text], { type: 'application/x-ndjson' });
        const chunkSequence = logger.nextChunkSequence++;
        const key = `${session.id}.${String(chunkSequence).padStart(6, '0')}.jsonl`;
        let phase = 'blob-write';
        try {
            await logger.host.storeSetBlob(LOG_TABLE, key, blob);
            session.chunks.push({ key, bytes: blob.size, firstSequence: batch[0]?.sequence ?? 0, lastSequence: batch.at(-1)?.sequence ?? 0, eventCount: batch.length });
            session.bytes += blob.size;
            phase = 'retention';
            await logger.enforceRetention();
            phase = 'index-write';
            await logger.host.storeSetJson(LOG_TABLE, INDEX_KEY, logger.index);
            logger.mutable.persistenceError = '';
            logger.syncSessions();
        }
        catch {
            logger.mutable.persistenceError = `日志持久化失败（${phase}），已暂停写入。当前日志继续保留在内存，受内存上限限制；停用后仍可导出，重载不会恢复内存事件。请先导出可读日志，检查存储后清空日志再重新启用。`;
            logger.persistenceAvailable = false;
            logger.storageBlocked = true;
            session.interrupted = true;
            logger.pending = [];
            logger.pendingBytes = 0;
            clearFlushTimer(logger);
            console.warn('[TT-Toolkit][system][logger][persistence.failed]', {
                operation: 'logs.flush', phase,
                code: { 'blob-write': 'LOG_BLOB_WRITE_FAILED', retention: 'LOG_RETENTION_FAILED', 'index-write': 'LOG_INDEX_WRITE_FAILED' }[phase],
                sourceLocation: 'kernel/logging/session-store.js:flush', chunkSequence, eventCount: batch.length,
                outcome: 'memory-only', nextAction: 'export-readable-logs-inspect-storage-and-clear-logs',
            });
            logger.syncSessions();
        }
    });
    return logger.flushQueue;
}

// 保留策略：先删最旧已结束会话，再裁剪当前会话最旧分块。
export async function enforceRetention(logger) {
    let total = logger.index.sessions.reduce((sum, session) => sum + session.bytes, 0);
    while (total > logger.mutable.settings.maxBytes) {
        const oldestClosed = logger.index.sessions.find(session => session !== logger.current && session.endedAt !== null);
        if (oldestClosed) {
            await deleteSessionBlobs(logger, oldestClosed);
            total -= oldestClosed.bytes;
            logger.index.sessions.splice(logger.index.sessions.indexOf(oldestClosed), 1);
            continue;
        }
        const oldestChunk = logger.current?.chunks[0];
        if (!oldestChunk || !logger.current)
            break;
        await logger.host.storeDeleteBlob(LOG_TABLE, oldestChunk.key);
        logger.current.chunks.shift();
        logger.current.bytes -= oldestChunk.bytes;
        logger.current.droppedBytes += oldestChunk.bytes;
        total -= oldestChunk.bytes;
        while (logger.mutable.currentEntries[0] && logger.mutable.currentEntries[0].sequence <= oldestChunk.lastSequence)
            logger.mutable.currentEntries.shift();
        logger.memoryBytes = logger.mutable.currentEntries.reduce((sum, event) => sum + bytes(eventLine(event)), 0);
    }
    logger.syncSessions();
}

export async function deleteSessionBlobs(logger, session) {
    for (const chunk of session.chunks)
        await logger.host.storeDeleteBlob(LOG_TABLE, chunk.key);
}

export async function persistIndexSafely(logger) {
    try {
        await logger.host.storeSetJson(LOG_TABLE, INDEX_KEY, logger.index);
    }
    catch (error) {
        logger.mutable.persistenceError = `日志索引保存失败：${errorMessage(error)}。请检查存储后重试；如需清空日志，请先导出可读日志。`;
        console.warn('[TT-Toolkit][system][logger][index.failed]', {
            operation: 'logs.index.save', phase: 'index-write', code: 'LOG_INDEX_WRITE_FAILED',
            sourceLocation: 'kernel/logging/session-store.js:persistIndexSafely',
            outcome: 'index-not-saved', nextAction: 'inspect-storage-and-retry',
        });
        logger.notify();
    }
}

export function syncSessions(logger) {
    logger.mutable.sessions = logger.index.sessions.map(cloneSession);
    logger.notify();
}

function parseChunk(text, chunk) {
    const events = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event)
            || event.sequence !== chunk.firstSequence + events.length
            || !['debug', 'info', 'warn', 'error'].includes(event.level)
            || ['timestamp', 'featureId', 'source', 'event'].some(field => typeof event[field] !== 'string'))
            return null;
        events.push(event);
    }
    return events.length === chunk.eventCount && events.at(-1)?.sequence === chunk.lastSequence ? events : null;
}

async function readChunk(logger, chunk) {
    let text;
    try {
        text = await (await logger.host.storeGetBlob(LOG_TABLE, chunk.key)).text();
    }
    catch (error) {
        return { code: error instanceof ToolkitError && error.code === 'STORE_BLOB_NOT_FOUND' ? error.code : 'LOG_CHUNK_READ_FAILED' };
    }
    try {
        const events = parseChunk(text, chunk);
        if (events)
            return { events };
    }
    catch {
        // Invalid JSONL shares the same outcome as an invalid event or range.
    }
    return { code: 'LOG_CHUNK_INVALID' };
}

function describeUnreadableChunk(session, chunk, index, code, firstMemorySequence) {
    const suffix = chunk.key.slice(session.id.length).match(/^\.(\d+)\.jsonl$/);
    const number = suffix && Number(suffix[1]);
    const lastSequence = Math.min(chunk.lastSequence, firstMemorySequence - 1);
    return {
        chunkIndex: index,
        chunkSequence: Number.isSafeInteger(number) && chunk.key.startsWith(session.id) ? number : null,
        firstSequence: chunk.firstSequence, lastSequence,
        eventCount: Math.min(chunk.eventCount, Math.max(0, lastSequence - chunk.firstSequence + 1)),
        code,
    };
}

// 暂停后的活动会话可直接读内存；结束后从有界尾部接续已写入的分块。
export async function loadSession(logger, id) {
    if (id === logger.mutable.currentSessionId)
        await logger.flush();
    const events = [];
    const unreadableChunks = [];
    if (id === logger.mutable.currentSessionId && !logger.persistenceAvailable)
        return { events: structuredClone(logger.mutable.currentEntries), unreadableChunks };
    const sessionIndex = logger.index.sessions.findIndex(item => item.id === id);
    const session = logger.index.sessions[sessionIndex];
    if (!session)
        return { events, unreadableChunks };
    const stopped = logger.mutable.stoppedMemorySession;
    const tail = id === stopped?.id ? stopped.entries : [];
    const firstMemorySequence = tail[0]?.sequence ?? Infinity;
    for (const [index, chunk] of session.chunks.slice().entries()) {
        if (chunk.firstSequence >= firstMemorySequence)
            continue;
        const result = await readChunk(logger, chunk);
        if (result.events) {
            for (const event of result.events) {
                if (event.sequence < firstMemorySequence)
                    events.push(event);
            }
        }
        else {
            const issue = describeUnreadableChunk(session, chunk, index, result.code, firstMemorySequence);
            unreadableChunks.push(issue);
            // Read-only diagnostics must not append logs and trigger retention.
            console.warn('[TT-Toolkit][system][logger][session.chunk_unreadable]', {
                operation: 'session.load', phase: 'chunk-read', sourceLocation: 'kernel/logging/session-store.js:loadSession',
                sessionIndex, ...issue, outcome: 'chunk-omitted', nextAction: 'export-readable-logs-and-inspect-storage',
            });
        }
    }
    return logger.index.sessions.includes(session)
        ? { events: events.concat(structuredClone(tail)), unreadableChunks }
        : { events: [], unreadableChunks: [] };
}

// 导出只读文本：json 保留会话元信息，log 每行一条，便于人工检索。
export function exportEntries(logger, entries, format) {
    if (format !== 'json' && format !== 'log')
        throw new TypeError(`不支持的日志导出格式：${String(format)}`);
    const grouped = new Map();
    for (const item of entries) {
        if (!item || typeof item.sessionId !== 'string' || !item.event)
            continue;
        const events = grouped.get(item.sessionId) ?? [];
        const event = structuredClone(item.event);
        event.data = logger.redactor.redactKeys(event.data);
        if (event.sensitive !== undefined)
            event.sensitive = logger.redactor.redactKeys(event.sensitive);
        events.push(event);
        grouped.set(item.sessionId, events);
    }
    const sessions = logger.index.sessions
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
