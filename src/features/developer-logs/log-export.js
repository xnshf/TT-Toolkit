import { confirmDanger } from '../../ui/confirm.js';
import { sessionLabel } from './log-history.js';

function documentContext(target) {
    const ownerDocument = target.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    try {
        if (ownerWindow?.top?.document)
            return { document: ownerWindow.top.document, window: ownerWindow.top };
    }
    catch {
        // Cross-origin embedding is not expected, but the iframe document remains usable.
    }
    return { document: ownerDocument, window: ownerWindow ?? globalThis };
}

export function exportFilename(extension) {
    return `tt-toolkit-logs-${new Date().toISOString().replaceAll(':', '-')}.${extension}`;
}

export async function copyText(target, text) {
    const context = documentContext(target);
    let clipboardError = null;
    try {
        if (context.window.navigator?.clipboard?.writeText) {
            await context.window.navigator.clipboard.writeText(text);
            return;
        }
    }
    catch (error) {
        clipboardError = error;
    }
    const textarea = context.document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    context.document.body.append(textarea);
    textarea.focus();
    textarea.select();
    const copied = context.document.execCommand?.('copy') === true;
    textarea.remove();
    if (!copied)
        throw clipboardError ?? new Error('当前 WebView 不允许访问剪贴板');
}

export function isMemorySession(state, session) {
    return session?.interrupted && (session.id === state.currentSessionId || session.id === state.stoppedMemorySession?.id);
}

export function confirmPartialLogs(document, state, sessions, records, issues, matchCount) {
    const warnings = issues.map(({ heading }) => heading);
    for (const session of sessions.filter(item => isMemorySession(state, item))) {
        const readable = records.filter(item => item.sessionId === session.id).length;
        if (readable < session.eventCount)
            warnings.push(`${sessionLabel(state.sessions.indexOf(session))}（中断）：共记录 ${session.eventCount} 条，当前可读 ${readable} 条。持久化已暂停，部分事件可能已超出容量上限或尚未读回。`);
    }
    if (!warnings.length)
        return null;
    return confirmDanger(document, {
        title: '只输出可读日志？',
        message: `${warnings.join(' ')} 缺失内容无法判断是否匹配筛选条件。继续仅输出当前筛选匹配的 ${matchCount} 条可读事件。`,
        details: issues.flatMap(({ label, details }) => details.map(text => `${label} · ${text}`)),
        confirmLabel: '继续', confirmClass: 'primary',
    });
}
