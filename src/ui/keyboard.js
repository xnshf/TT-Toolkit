// 移动端软键盘避让：把被键盘占据的底部高度发布为 --ttk-keyboard-inset，
// 让 iframe 内的滚动容器、文本域和全屏写作浮层能给键盘让出空间。
// 没有 visualViewport 时（桌面、部分 WebView）变量回落到 0px。
const INSET_VARIABLE = '--ttk-keyboard-inset';
const ACTIVE_ATTRIBUTE = 'data-ttk-keyboard';

function viewportInset(view) {
    // 键盘只压缩可视视口，不改变布局视口；差值即被遮挡的底部高度。
    const visible = view?.height ?? globalThis.innerHeight;
    if (typeof visible !== 'number' || !Number.isFinite(visible))
        return 0;
    return Math.max(0, Math.round(globalThis.innerHeight - visible));
}

export function installKeyboardInset(root = globalThis.document?.documentElement) {
    const view = globalThis.visualViewport;
    if (!root)
        return () => {};
    let frame = 0;
    const apply = () => {
        frame = 0;
        const inset = viewportInset(view);
        root.style.setProperty(INSET_VARIABLE, `${inset}px`);
        root.toggleAttribute(ACTIVE_ATTRIBUTE, inset > 60);
    };
    // Android 的 resize 会先带旧高度触发一次，滚动事件才给出最终键盘高度。
    const schedule = () => {
        if (frame)
            return;
        frame = globalThis.setTimeout(apply, 0);
    };
    apply();
    view?.addEventListener('resize', schedule);
    view?.addEventListener('scroll', schedule);
    return () => {
        if (frame)
            globalThis.clearTimeout(frame);
        frame = 0;
        view?.removeEventListener('resize', schedule);
        view?.removeEventListener('scroll', schedule);
        root.style.setProperty(INSET_VARIABLE, '0px');
        root.removeAttribute(ACTIVE_ATTRIBUTE);
    };
}

// 键盘弹出不会替 fixed 定位的工作台滚动焦点元素；显式把输入目标拉回可视区，
// 并留出键盘高度的余量，避免正在编辑的行被键盘覆盖。
export function scrollIntoViewAboveKeyboard(element, { delay = 120 } = {}) {
    if (!element?.isConnected)
        return;
    const timer = setTimeout(() => {
        if (!element.isConnected)
            return;
        const inset = viewportInset(globalThis.visualViewport);
        const box = element.getBoundingClientRect();
        const visibleBottom = globalThis.innerHeight - inset;
        const overflow = box.bottom - (visibleBottom - 12);
        const remainsVisible = inset === 0 || overflow <= 0;
        if (remainsVisible)
            return;
        const doc = element.ownerDocument;
        // 元素多半位于 fixed 工作台内部，先滚最近的滚动祖先；全页滚动兜底。
        const main = doc?.querySelector('.workbench main');
        if (main && main.scrollHeight - main.clientHeight > overflow)
            main.scrollTop += overflow;
        else
            globalThis.scrollBy?.({ top: overflow, behavior: 'smooth' });
    }, delay);
    return () => clearTimeout(timer);
}
