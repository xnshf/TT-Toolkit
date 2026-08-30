import { actionButton, h } from './dom.js';

// 危险操作的统一模态确认:showModal 提供遮罩、焦点陷阱与 Esc 取消,
// 关闭按钮默认获得焦点以防回车误触确认。
// resolve 由按钮/取消路径主动完成,close 事件只作意外关闭的兜底——
// 部分内核不派发 dialog close 事件,依赖它会泄漏 dialog 并悬挂 Promise。
export function confirmDanger(doc, { title, message, confirmLabel = '确认', cancelLabel = '取消', confirmClass = 'danger-button' }) {
    return new Promise(resolve => {
        let settled = false;
        const dialog = h('dialog', { className: 'ttk-confirm', attrs: { 'data-tt-mobile-surface': 'fullscreen-window' } },
            h('h3', { text: title }),
            h('p', { text: message }),
            h('div', {},
                actionButton(cancelLabel, () => settle(false)),
                actionButton(confirmLabel, () => settle(true), { className: confirmClass }),
            ),
        );
        const settle = value => {
            if (settled)
                return;
            settled = true;
            resolve(value);
            if (dialog.open)
                dialog.close(value ? 'confirm' : 'cancel');
            dialog.remove();
        };
        dialog.addEventListener('close', () => settle(dialog.returnValue === 'confirm'));
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            settle(false);
        });
        doc.body.append(dialog);
        dialog.showModal();
        dialog.querySelector('button')?.focus();
    });
}
