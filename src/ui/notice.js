import { actionButton, h } from './dom.js';

const DEFAULT_TIMEOUTS = Object.freeze({
    success: 4500,
    info: 3000,
    warning: 0,
    danger: 0,
});

export function createNoticeController(onExpire, timerApi = globalThis) {
    let current = null;
    let timeoutId = null;

    function cancelTimer() {
        if (timeoutId !== null)
            timerApi.clearTimeout(timeoutId);
        timeoutId = null;
    }

    function show(text, kind = 'info', timeoutMs = DEFAULT_TIMEOUTS[kind] ?? 0) {
        cancelTimer();
        current = text ? { text: String(text), kind } : null;
        if (current && timeoutMs > 0) {
            const expected = current;
            timeoutId = timerApi.setTimeout(() => {
                timeoutId = null;
                if (current !== expected)
                    return;
                current = null;
                onExpire?.();
            }, timeoutMs);
        }
    }

    function clear(render = false) {
        cancelTimer();
        current = null;
        if (render)
            onExpire?.();
    }

    return {
        get current() { return current; },
        show,
        clear,
        dispose: cancelTimer,
    };
}

export function noticeBanner(notice, onDismiss) {
    if (!notice)
        return null;
    const role = notice.kind === 'danger' ? 'alert' : 'status';
    return h('div', {
        className: `feature-notice ${notice.kind}`,
        attrs: { role, 'aria-live': notice.kind === 'danger' ? 'assertive' : 'polite' },
    },
    h('span', { text: notice.text }),
    actionButton('×', onDismiss, { className: 'notice-dismiss', ariaLabel: '关闭提示' }));
}
