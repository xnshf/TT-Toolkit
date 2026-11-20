import { errorKind, errorMessage } from '../errors.js';
import { levelEnabled } from './schema.js';

const REFLUX_PREFIX_PATTERN = /^\[TT-Toolkit\]\[[^\]\n]+\]\[[^\]\n]+\]\[[^\]\n]+\]/;

// 宿主前端日志：能力探测、尾部与实时缓冲合并、按运行期 id 去重、契约失败降级。
// 宿主来源事件不转发 console，避免回流；降级后不自动重连。
export function probeHostFrontendLogs(logger) {
    try {
        logger.host.assertFrontendLogsCapability();
        logger.mutable.hostFrontendStatus = { phase: 'idle', code: '', message: '', importedCount: 0 };
    }
    catch (error) {
        logger.mutable.hostFrontendStatus = {
            phase: 'unavailable',
            code: error?.code ?? 'HOST_FRONTEND_LOGS_MISSING',
            message: errorMessage(error),
            importedCount: 0,
        };
    }
}

export function mergeHostEntries(tail, buffer) {
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

export function acceptHostEntry(logger, entry) {
    if (logger.hostIdSet.has(entry.id))
        return;
    logger.hostIdSet.add(entry.id);
    if (REFLUX_PREFIX_PATTERN.test(entry.message))
        return;
    if (levelEnabled(entry.level, logger.mutable.settings.minimumLevel))
        recordHostEntry(logger, entry);
}

export function degradeHostStream(logger, error) {
    if (logger.mutable.hostFrontendStatus.phase === 'degraded')
        return;
    const cancel = logger.hostSubscriptionCancel;
    logger.hostSubscriptionCancel = null;
    if (cancel) {
        try {
            cancel();
        }
        catch {
            // 取消订阅失败不改变降级结论
        }
    }
    logger.mutable.hostFrontendStatus = {
        phase: 'degraded',
        code: error?.code ?? '',
        message: errorMessage(error),
        importedCount: logger.mutable.hostFrontendStatus.importedCount ?? 0,
    };
    logger.record('warn', 'system', 'logger', 'host.stream_contract_failed', {
        data: {
            operation: 'host.stream.contract', ...errorKind(error),
            sourceLocation: 'kernel/host-store.js:validateFrontendLogEntry',
            outcome: 'host-stream-stopped', nextAction: 'disable-and-reenable-logs-to-retry',
        },
    });
    logger.notify();
}

export function recordHostEntry(logger, entry) {
    logger.recordInternal(entry.level, 'system', 'host-frontend', 'host.frontend_log', {
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

// 启动失败回滚：撤销订阅、丢弃半成品会话，并把宿主日志流标记为不可用。
export function rollbackStart(logger, subscribeCancel, contractFailed, error, pendingSession = null) {
    logger.mutable.enabled = false;
    logger.hostIdSet = new Set();
    logger.hostSubscriptionCancel = null;
    logger.pending = [];
    logger.pendingBytes = 0;
    if (subscribeCancel) {
        try {
            subscribeCancel();
        }
        catch {
            // 取消订阅失败不改变启动失败结论
        }
    }
    const sessionToRemove = logger.current ?? pendingSession;
    if (sessionToRemove && logger.index.sessions.includes(sessionToRemove)) {
        const index = logger.index.sessions.indexOf(sessionToRemove);
        logger.index.sessions.splice(index, 1);
    }
    logger.current = null;
    logger.mutable.currentSessionId = null;
    logger.mutable.currentEntries = [];
    logger.memoryBytes = 0;
    logger.syncSessions();
    const failed = contractFailed ?? error;
    logger.mutable.hostFrontendStatus = {
        phase: 'unavailable',
        code: failed?.code ?? 'HOST_FRONTEND_LOGS_MISSING',
        message: errorMessage(failed),
        importedCount: 0,
    };
    logger.notify();
}

// 会话收尾时的宿主日志取消订阅与状态复位。
export function stopHostStream(logger) {
    const cancel = logger.hostSubscriptionCancel;
    logger.hostSubscriptionCancel = null;
    if (cancel) {
        try {
            cancel();
        }
        catch {
            // 取消订阅失败不阻塞会话收尾
        }
    }
    logger.mutable.hostFrontendStatus = { phase: 'idle', code: '', message: '', importedCount: 0 };
}
