import { afterEach, describe, expect, it, vi } from 'vitest';
import { installKeyboardInset, scrollIntoViewAboveKeyboard } from '../src/ui/keyboard.js';

const originalInnerHeight = Object.getOwnPropertyDescriptor(globalThis, 'innerHeight');

function setViewportHeight(cssHeight) {
    Object.defineProperty(globalThis, 'visualViewport', {
        value: { height: cssHeight, addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
        writable: true,
    });
}

// 宿主把 Android 键盘高度写到默认 IME 承接节点的公开变量上，而不是改写视口。
function setHostImeInset(value) {
    const host = document.createElement('div');
    host.id = 'sheld';
    if (value !== null)
        host.style.setProperty('--tt-ime-bottom', `${value}px`);
    document.body.append(host);
    return host;
}

afterEach(() => {
    if (originalInnerHeight)
        Object.defineProperty(globalThis, 'innerHeight', originalInnerHeight);
    delete globalThis.visualViewport;
    document.body.replaceChildren();
});

describe('keyboard inset', () => {
    it('publishes the visual viewport deficit as --ttk-keyboard-inset and marks the keyboard state', () => {
        vi.useFakeTimers();
        try {
            const root = document.createElement('div');
            Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true, writable: true });
            setViewportHeight(800);
            const dispose = installKeyboardInset(root);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');

            // 软键盘只压缩可视视口：差值是底部被遮挡的高度。
            globalThis.visualViewport.height = 520;
            globalThis.visualViewport.addEventListener.mock.calls.find(([type]) => type === 'resize')[1]();
            vi.advanceTimersByTime(1);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('280px');

            // 键盘收起后回到 0，并清理监听。
            globalThis.visualViewport.height = 800;
            globalThis.visualViewport.addEventListener.mock.calls.find(([type]) => type === 'scroll')[1]();
            vi.advanceTimersByTime(1);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');

            dispose();
            const removeCalls = globalThis.visualViewport.removeEventListener.mock.calls.map(([type]) => type);
            expect(removeCalls).toContain('resize');
            expect(removeCalls).toContain('scroll');
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('publishes the host Android IME height even though the viewport does not change', async () => {
        vi.useFakeTimers();
        try {
            const root = document.createElement('div');
            Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true, writable: true });
            setViewportHeight(800);
            const host = setHostImeInset(0);
            const dispose = installKeyboardInset(root);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');

            // 键盘弹出只改写 IME 承接节点的 style：不再触达视口，必须由该节点触发重测。
            host.style.setProperty('--tt-ime-bottom', '312.50px');
            await vi.advanceTimersByTimeAsync(1);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('313px');

            host.style.setProperty('--tt-ime-bottom', '0.00px');
            await vi.advanceTimersByTimeAsync(1);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');

            dispose();
            host.style.setProperty('--tt-ime-bottom', '312.50px');
            await vi.advanceTimersByTimeAsync(1);
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('clamps the published inset to the height the caller actually has to give way for', () => {
        vi.useFakeTimers();
        try {
            const root = document.createElement('div');
            Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true, writable: true });
            setViewportHeight(520);
            const dispose = installKeyboardInset(root, { limit: measured => Math.min(measured, 100) });
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('100px');

            dispose();
            const hidden = installKeyboardInset(root, { limit: () => 0 });
            expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');
            hidden();
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('leaves non-positive or unknown measurements at 0', () => {
        const root = document.createElement('div');
        Object.defineProperty(globalThis, 'innerHeight', { value: 700, configurable: true, writable: true });
        setViewportHeight(Number.NaN);
        installKeyboardInset(root);
        expect(root.style.getPropertyValue('--ttk-keyboard-inset')).toBe('0px');
    });
});

function scrollableElement(tag, className, { overflowY, scrollHeight, clientHeight }) {
    const node = document.createElement(tag);
    node.className = className;
    Object.defineProperty(node, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(node, 'clientHeight', { value: clientHeight, configurable: true });
    node.style.overflowY = overflowY;
    return node;
}

describe('scrollIntoViewAboveKeyboard', () => {
    it('scrolls the nearest scrollable ancestor of the edited field, not a fixed container', () => {
        vi.useFakeTimers();
        try {
            // 真实结构：正文框在表单里，表单在可滚动的详情区里；外层 main 自身不滚动。
            const outer = scrollableElement('main', 'wie-host', { overflowY: 'hidden', scrollHeight: 4000, clientHeight: 200 });
            const pane = scrollableElement('main', 'wie-detail-pane', { overflowY: 'auto', scrollHeight: 1200, clientHeight: 200 });
            const form = document.createElement('div');
            const textarea = document.createElement('textarea');
            form.append(textarea);
            pane.append(form);
            outer.append(pane);
            document.body.append(outer);

            Object.defineProperty(globalThis, 'innerHeight', { value: 400, configurable: true, writable: true });
            // 容器滚动后控件跟着上移，后续重试才能收敛。
            textarea.getBoundingClientRect = () => ({ top: 100 - pane.scrollTop, bottom: 320 - pane.scrollTop, left: 0, right: 100, width: 100, height: 220 });
            textarea.focus();

            // 没有键盘时不滚动，避免无谓跳动。
            setViewportHeight(400);
            scrollIntoViewAboveKeyboard(textarea, { delay: 0 });
            vi.runAllTimers();
            expect(pane.scrollTop).toBe(0);

            // 键盘遮挡 160px：把溢出的部分滚到可视区上方，外层不滚动容器保持不变。
            setViewportHeight(240);
            scrollIntoViewAboveKeyboard(textarea, { delay: 0 });
            vi.runAllTimers();
            expect(pane.scrollTop).toBe(92);
            expect(outer.scrollTop).toBe(0);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('uses the host IME height when the viewport itself does not change', () => {
        vi.useFakeTimers();
        try {
            // Android 真机场景：视口不变，键盘高度只出现在宿主的 IME 承接节点上。
            const pane = scrollableElement('main', 'wie-detail-pane', { overflowY: 'auto', scrollHeight: 1200, clientHeight: 400 });
            const textarea = document.createElement('textarea');
            pane.append(textarea);
            document.body.append(pane);
            Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true, writable: true });
            setViewportHeight(800);
            textarea.getBoundingClientRect = () => ({ top: 400 - pane.scrollTop, bottom: 800 - pane.scrollTop, left: 0, right: 100, width: 100, height: 400 });
            textarea.focus();

            const host = setHostImeInset(300);
            scrollIntoViewAboveKeyboard(textarea, { delay: 0 });
            vi.runAllTimers();
            // 遮挡 300px 时把控件底边推到键盘上方（800 - (800 - 300 - 12) = 312）。
            expect(pane.scrollTop).toBe(312);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('stops correcting the scroll position once the field loses focus', () => {
        vi.useFakeTimers();
        try {
            const pane = scrollableElement('main', 'wie-detail-pane', { overflowY: 'auto', scrollHeight: 1200, clientHeight: 200 });
            const textarea = document.createElement('textarea');
            pane.append(textarea);
            document.body.append(pane);
            Object.defineProperty(globalThis, 'innerHeight', { value: 400, configurable: true, writable: true });
            textarea.getBoundingClientRect = () => ({ top: 100 - pane.scrollTop, bottom: 320 - pane.scrollTop, left: 0, right: 100, width: 100, height: 220 });
            textarea.focus();

            setViewportHeight(240);
            scrollIntoViewAboveKeyboard(textarea, { delay: 0 });
            textarea.blur();
            vi.runAllTimers();
            expect(pane.scrollTop).toBe(0);
        }
        finally {
            vi.useRealTimers();
        }
    });
});
