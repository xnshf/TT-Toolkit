// 全量重绘前的焦点保留：重绘会把正在编辑的控件换成新节点，焦点、光标和输入法组合都会丢。
// 约定：需要跨重绘保留的控件带 data-control="<稳定键>"；重绘后按键查找新节点并恢复。
export function captureFocus(container) {
    const active = container.ownerDocument?.activeElement;
    if (!active || !container.contains(active))
        return null;
    const key = active.dataset?.control;
    if (!key)
        return null;
    const caret = typeof active.selectionStart === 'number'
        ? [active.selectionStart, active.selectionEnd]
        : null;
    return { key, caret };
}

// 找不到新节点或它已禁用时返回 null，调用方可据此保留待恢复状态，等控件重新出现再恢复。
export function restoreFocus(container, snapshot) {
    if (!snapshot?.key)
        return null;
    const next = [...container.querySelectorAll('[data-control]')]
        .find(node => node.dataset.control === snapshot.key);
    if (!next || next.disabled)
        return null;
    next.focus({ preventScroll: true });
    if (snapshot.caret && next.setSelectionRange && ['input', 'textarea'].includes(next.localName)) {
        try {
            next.setSelectionRange(...snapshot.caret);
        }
        catch {
            // Number 等字段没有文本选区，忽略。
        }
    }
    return next;
}
