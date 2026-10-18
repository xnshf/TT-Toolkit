import { h } from './dom.js';

// 搜索框的 IME 约定：输入法组合（拼音候选）期间不能触发重绘，否则正在组合的输入框被替换会取消组合，
// 表现为中文打不进去、只能落下 ASCII 字母。组合结束后补发一次查询；Enter 交给调用方决定是否立即搜索。
export function searchField({ value = '', placeholder = '', ariaLabel = '', className = '', dataset, onQuery, onEnter } = {}) {
    const input = h('input', {
        type: 'search',
        value,
        placeholder,
        className,
        dataset,
        attrs: ariaLabel ? { 'aria-label': ariaLabel } : undefined,
    });
    let applied = input.value;
    const emit = () => {
        if (input.value === applied)
            return;
        applied = input.value;
        onQuery?.(input.value);
    };
    input.addEventListener('input', event => {
        if (event.isComposing)
            return;
        emit();
    });
    // 部分输入法只发 compositionend 而不补 input；重复值由 applied 去重。
    input.addEventListener('compositionend', emit);
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229)
            return;
        onEnter?.(input.value);
    });
    return input;
}
