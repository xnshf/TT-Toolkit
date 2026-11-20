import { callout, h } from '../../ui/dom.js';

const REASONS = {
    STORE_BLOB_NOT_FOUND: '存储中不存在',
    LOG_CHUNK_READ_FAILED: '读取失败',
    LOG_CHUNK_INVALID: 'JSONL、事件结构或范围损坏',
};

export const sessionLabel = index => `会话 #${index + 1}`;

function describeChunk(chunk) {
    const label = chunk.chunkSequence === null ? `索引第 ${chunk.chunkIndex + 1} 块` : `分块 #${chunk.chunkSequence}`;
    return `${label}：事件 ${chunk.firstSequence}–${chunk.lastSequence}（索引预计 ${chunk.eventCount} 条），${REASONS[chunk.code]}`;
}

export function createLogHistory(runtime, render) {
    const reads = new Map();
    async function load(id) {
        const read = { result: null };
        reads.set(id, read);
        try {
            const result = await runtime.loadSession(id);
            if (reads.get(id) === read)
                read.result = result;
        }
        catch {
            // Unexpected session-level failure, distinct from an unreadable chunk.
            read.result = { events: null, unreadableChunks: [], failed: true };
        }
        if (reads.get(id) === read)
            render();
    }
    return {
        load,
        reload(sessions) {
            reads.clear();
            const pending = sessions.map(session => load(session.id));
            render();
            return Promise.all(pending);
        },
        forget(id) { reads.delete(id); },
        entries(id) { return reads.get(id)?.result?.events; },
        pending(session) {
            return session.id !== runtime.state.currentSessionId && session.id !== runtime.state.stoppedMemorySession?.id
                && reads.get(session.id)?.result === null;
        },
        issues(sessions) {
            return sessions.flatMap(session => {
                const read = reads.get(session.id)?.result;
                if (!read?.failed && !read?.unreadableChunks.length)
                    return [];
                const label = sessionLabel(runtime.state.sessions.indexOf(session));
                if (read.failed)
                    return [{ label, heading: `${label}：无法读取存储中的日志。`, details: [] }];
                return [{ label, heading: `${label}：${read.unreadableChunks.length} 个分块不可读。`, details: read.unreadableChunks.map(describeChunk) }];
            });
        },
    };
}

export function historyWarnings(issues) {
    return issues.map(({ heading, details }) => h('div', {},
        callout(`${heading}仍可查看及导出已读事件；请检查存储后重新打开日志页。`, 'warning'),
        details.length ? h('ul', {}, details.map(text => h('li', { text }))) : null,
    ));
}
