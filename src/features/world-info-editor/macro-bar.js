import { h } from '../../ui/dom.js';

// 成对宏在存在选区时包裹选区，其余宏在选区末尾续写，避免直接冲掉已选内容。
const PAIRED_MACROS = new Map([
    ['[[', ['[[', ']]']],
    ['*动作*', ['*', '*']],
    ['"对话"', ['"', '"']],
]);
const EDITOR_MACROS = ['{{char}}', '{{user}}', '[[', ']]', '*动作*', '"对话"'];

// 把宏按钮渲染成一行；点按时有选区则包裹选区，无选区则插入到光标处。
export function renderMacroBar(textarea, apply) {
    const bar = h('div', { className: 'wie-macro-bar' });
    for (const macro of EDITOR_MACROS) {
        const key = h('button', { type: 'button', className: 'wie-macro-key', text: macro });
        key.addEventListener('click', () => {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const selected = textarea.value.slice(start, end);
            const pair = PAIRED_MACROS.get(macro);
            const insert = pair && selected ? `${pair[0]}${selected}${pair[1]}` : macro;
            const next = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
            // 包裹后仍选中原文本，方便连续套用多个宏；否则光标落在插入内容之后。
            const caret = start + (pair && selected ? pair[0].length : insert.length);
            const selectEnd = pair && selected ? caret + selected.length : caret;
            apply(next, { start: caret, end: selectEnd });
        });
        bar.append(key);
    }
    return bar;
}
