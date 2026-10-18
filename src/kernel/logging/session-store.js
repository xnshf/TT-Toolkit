import { errorKind, errorMessage } from '../errors.js';

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
        catch (error) {
            logger.mutable.persistenceError = `日志持久化失败（${phase}）：${errorMessage(error)}。已暂停日志写入，当前日志继续保留在内存；请先导出可读日志，检查存储后清空日志再重新启用。`;
            logger.persistenceAvailable = false;
            logger.storageBlocked = true;
            logger.volatileSessions.set(session.id, structuredClone(logger.mutable.currentEntries));
            console.warn('[TT-Toolkit][system][logger][persistence.failed]', {
                operation: 'logs.flush', phase,
                code: { 'blob-write': 'LOG_BLOB_WRITE_FAILED', retention: 'LOG_RETENTION_FAILED', 'index-write': 'LOG_INDEX_WRITE_FAILED' }[phase],
                sourceLocation: 'kernel/logging/session-store.js:flush', chunkSequence, eventCount: batch.length,
                outcome: 'memory-only', nextAction: 'export-readable-logs-inspect-storage-and-clear-logs',
            });
            logger.notify();
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

// 读取历史会话事件：优先内存副本，其次按分块从 store 读回。
export async function loadSession(logger, id) {
    try {
        const volatile = logger.volatileSessions.get(id);
        if (volatile)
            return structuredClone(volatile);
        if (id === logger.mutable.currentSessionId && !logger.persistenceAvailable)
            return structuredClone(logger.mutable.currentEntries);
        if (id === logger.mutable.currentSessionId)
            await logger.flush();
        const session = logger.index.sessions.find(item => item.id === id);
        if (!session)
            return [];
        const events = [];
        for (const chunk of session.chunks) {
            const text = await (await logger.host.storeGetBlob(LOG_TABLE, chunk.key)).text();
            for (const line of text.split('\n'))
                if (line.trim())
                    events.push(JSON.parse(line));
        }
        return events;
    }
    catch (error) {
        logger.record('error', 'system', 'logger', 'session.load_failed', {
            data: { operation: 'session.load', ...errorKind(error) },
            sensitive: { error },
        });
        throw error;
    }
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
        events.push(structuredClone(item.event));
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
