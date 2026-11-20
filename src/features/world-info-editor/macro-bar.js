import { h } from '../../ui/dom.js';

// 成对宏在存在选区时包裹选区，其余宏在选区末尾续写，避免直接冲掉已选内容。
const PAIRED_MACROS = new Map([
    ['[[', ['[[', ']]']],
    ['*动作*', ['*', '*']],
    ['"对话"', ['"', '"']],
]);
const EDITOR_MACROS = ['{{char}}', '{{user}}', '[[', ']]', '*动作*', '"对话"'];

// 把宏按钮渲染成一行；点按时有选区则包裹选区，无选区则插入到光标处。
export function renderMacroBar(textarea) {
    const bar = h('div', { className: 'wie-macro-bar' });
    for (const macro of EDITOR_MACROS) {
        const key = h('button', { type: 'button', className: 'wie-macro-key', text: macro });
        key.addEventListener('mousedown', event => {
            // 已在正文中写作时，点宏不要先移走焦点；键盘仍可正常 Tab 到宏键。
            if (event.button === 0 && textarea.ownerDocument.activeElement === textarea)
                event.preventDefault();
        });
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
            textarea.value = next;
            // 键盘激活时焦点可能在按钮上；先恢复正文焦点，再走输入更新，避免同步重绘移除正文框。
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(caret, selectEnd);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
        bar.append(key);
    }
    return bar;
}
