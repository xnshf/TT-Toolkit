import { ToolkitError } from '../errors.js';
export const MIB = 1024 * 1024;
export const MIN_LOG_BYTES = MIB;
export const MAX_LOG_BYTES = 200 * MIB;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const CONSOLE_LEVELS = ['off', ...LEVELS];
const PRIVACY_MODES = ['redacted', 'full'];
export function createDefaultLogSettings() {
    return { schemaVersion: 1, privacyMode: 'redacted', minimumLevel: 'debug', consoleLevel: 'warn', maxBytes: 20 * MIB };
}
export function createDefaultLogIndex() {
    return { schemaVersion: 2, sessions: [] };
}
export function parseLogSettings(value) {
    if (value === undefined || value === null)
        return createDefaultLogSettings();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '日志设置必须是对象');
    const raw = value;
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的日志设置版本：${String(raw.schemaVersion)}`);
    if (!PRIVACY_MODES.includes(raw.privacyMode))
        throw new ToolkitError('INVALID_SCHEMA', '日志隐私模式无效');
    if (!LEVELS.includes(raw.minimumLevel))
        throw new ToolkitError('INVALID_SCHEMA', '日志最低记录级别无效');
    if (!CONSOLE_LEVELS.includes(raw.consoleLevel))
        throw new ToolkitError('INVALID_SCHEMA', 'console 同步级别无效');
    if (!Number.isSafeInteger(raw.maxBytes) || Number(raw.maxBytes) < MIN_LOG_BYTES || Number(raw.maxBytes) > MAX_LOG_BYTES) {
        throw new ToolkitError('INVALID_SCHEMA', '日志容量必须介于 1 MiB 与 200 MiB 之间');
    }
    return {
        schemaVersion: 1,
        privacyMode: raw.privacyMode,
        minimumLevel: raw.minimumLevel,
        consoleLevel: raw.consoleLevel,
        maxBytes: Number(raw.maxBytes),
    };
}
export function parseLogIndex(value) {
    if (value === undefined || value === null)
        return createDefaultLogIndex();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '日志索引必须是对象');
    const raw = value;
    if (raw.schemaVersion === 1)
        throw new ToolkitError('LEGACY_LOG_SCHEMA', '检测到旧版日志，请清空日志后重新开始记录');
    if (raw.schemaVersion !== 2 || !Array.isArray(raw.sessions))
        throw new ToolkitError('INVALID_SCHEMA', '日志索引版本或 sessions 无效');
    const sessions = raw.sessions.map(session => {
        if (!session || typeof session !== 'object' || Array.isArray(session))
            throw new ToolkitError('INVALID_SCHEMA', '日志会话必须是对象');
        const candidate = session;
        if (typeof candidate.id !== 'string' || !Array.isArray(candidate.chunks) || !PRIVACY_MODES.includes(candidate.privacyMode)) {
            throw new ToolkitError('INVALID_SCHEMA', '日志会话字段无效');
        }
        if (typeof candidate.startedAt !== 'string' || !(candidate.endedAt === null || typeof candidate.endedAt === 'string') || typeof candidate.interrupted !== 'boolean') {
            throw new ToolkitError('INVALID_SCHEMA', '日志会话时间字段无效');
        }
        for (const field of ['eventCount', 'bytes', 'droppedBytes']) {
            if (!Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0)
                throw new ToolkitError('INVALID_SCHEMA', `日志会话 ${field} 无效`);
        }
        const chunks = candidate.chunks.map(chunk => {
            if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk))
                throw new ToolkitError('INVALID_SCHEMA', '日志分块必须是对象');
            const item = chunk;
            if (typeof item.key !== 'string')
                throw new ToolkitError('INVALID_SCHEMA', '日志分块 key 无效');
            for (const field of ['bytes', 'firstSequence', 'lastSequence', 'eventCount']) {
                if (!Number.isSafeInteger(item[field]) || Number(item[field]) < 0)
                    throw new ToolkitError('INVALID_SCHEMA', `日志分块 ${field} 无效`);
            }
            return { key: item.key, bytes: Number(item.bytes), firstSequence: Number(item.firstSequence), lastSequence: Number(item.lastSequence), eventCount: Number(item.eventCount) };
        });
        return {
            id: candidate.id,
            startedAt: candidate.startedAt,
            endedAt: candidate.endedAt,
            interrupted: candidate.interrupted,
            privacyMode: candidate.privacyMode,
            eventCount: Number(candidate.eventCount),
            bytes: Number(candidate.bytes),
            droppedBytes: Number(candidate.droppedBytes),
            chunks,
        };
    });
    return { schemaVersion: 2, sessions };
}
export function levelEnabled(level, threshold) {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(threshold);
}
