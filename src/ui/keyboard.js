// 移动端软键盘避让：把被键盘占据的底部高度发布为 --ttk-keyboard-inset，
// 让 iframe 内的滚动容器、文本域和全屏写作浮层能给键盘让出空间。
// 键盘高度有两条来源：可视视口被压缩（iOS、桌面窗口）和宿主 Android IME 变量。
// 没有 visualViewport 也没有宿主 IME 变量时（桌面、部分 WebView）回落到 0px。
const INSET_VARIABLE = '--ttk-keyboard-inset';
const ACTIVE_ATTRIBUTE = 'data-ttk-keyboard';
const IME_VARIABLE = '--tt-ime-bottom';
// Android 的键盘不压缩视口，宿主只把高度写到当前 IME 目标节点，默认回退 #sheld。
// 工作台的输入在 iframe 内，不会被宿主登记为 IME 目标，因此只能读这个默认节点。
const IME_HOST_ID = 'sheld';

function viewportInset(view) {
    // 键盘只压缩可视视口，不改变布局视口；差值即被遮挡的底部高度。
    const visible = view?.height ?? globalThis.innerHeight;
    if (typeof visible !== 'number' || !Number.isFinite(visible))
        return 0;
    return Math.max(0, Math.round(globalThis.innerHeight - visible));
}

function imeInset(doc) {
    const host = doc?.getElementById?.(IME_HOST_ID);
    if (!host)
        return 0;
    const view = doc.defaultView ?? globalThis;
    const raw = view.getComputedStyle?.(host)?.getPropertyValue(IME_VARIABLE) ?? '';
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// IME 变量在宿主文档的默认承接节点上，与调用方传入的 root 不属于同一文档。
function keyboardInset() {
    return Math.max(viewportInset(globalThis.visualViewport), imeInset(globalThis.document));
}

// limit：把原始键盘高度收敛为插件实际需要让位的部分（悬浮工作台可能整体在键盘上方）。
export function installKeyboardInset(root = globalThis.document?.documentElement, { limit } = {}) {
    const view = globalThis.visualViewport;
    if (!root)
        return () => {};
    let frame = 0;
    const apply = () => {
        frame = 0;
        const measured = keyboardInset();
        const inset = Math.max(0, Math.min(measured, limit ? limit(measured) : measured));
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
    // Android 键盘弹出既不改变视口，也不改写根节点，只改写 IME 目标节点的 style。
    const imeHost = globalThis.document?.getElementById?.(IME_HOST_ID);
    const imeObserver = imeHost && typeof MutationObserver === 'function'
        ? new MutationObserver(schedule)
        : null;
    imeObserver?.observe(imeHost, { attributes: true, attributeFilter: ['style'] });
    return () => {
        if (frame)
            globalThis.clearTimeout(frame);
        frame = 0;
        view?.removeEventListener('resize', schedule);
        view?.removeEventListener('scroll', schedule);
        imeObserver?.disconnect();
        root.style.setProperty(INSET_VARIABLE, '0px');
        root.removeAttribute(ACTIVE_ATTRIBUTE);
    };
}

// 键盘弹出不会替 fixed 定位的工作台滚动焦点元素；显式把输入目标拉回可视区，
// 并留出键盘高度的余量，避免正在编辑的行被键盘覆盖。
// 键盘动画与宿主写入 IME 高度都是异步的，只测一次会测到 0，因此在焦点稳定前做有限次重试。
const RETRY_OFFSETS = [0, 260, 620];

function scrollableRoom(node) {
    return node.scrollHeight - node.clientHeight - node.scrollTop;
}

function revealAboveKeyboard(element) {
    const doc = element.ownerDocument;
    const view = doc?.defaultView ?? globalThis;
    const inset = keyboardInset();
    const visibleBottom = (view.innerHeight ?? globalThis.innerHeight) - inset;
    let overflow = element.getBoundingClientRect().bottom - (visibleBottom - 12);
    if (inset === 0 || overflow <= 0)
        return;
    // 从最近的可滚动祖先依次补齐；只按实际可滚动余量滚动，余量不足时交给下一层，
    // 不依赖固定的容器选择器，也不动输入控件自身的内部滚动（重试时会重复累加）。
    for (let node = element.parentElement; node && overflow > 0; node = node.parentElement) {
        if (!/(auto|scroll)/.test(view.getComputedStyle(node).overflowY))
            continue;
        const step = Math.min(overflow, Math.max(0, scrollableRoom(node)));
        if (step <= 0)
            continue;
        node.scrollTop += step;
        overflow -= step;
    }
}

export function scrollIntoViewAboveKeyboard(element, { delay = 120 } = {}) {
    if (!element?.isConnected)
        return;
    const timers = RETRY_OFFSETS.map(offset => setTimeout(() => {
        // 已经失去焦点后不再改动滚动位置，避免抢走用户手动滚动。
        if (element.isConnected && element.ownerDocument.activeElement === element)
            revealAboveKeyboard(element);
    }, delay + offset));
    return () => timers.forEach(timer => clearTimeout(timer));
}
