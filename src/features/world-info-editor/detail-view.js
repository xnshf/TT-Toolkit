import { actionButton, h } from '../../ui/dom.js';
import { confirmDanger } from '../../ui/confirm.js';
import { renderMacroBar } from './macro-bar.js';

// 详情头部、窄容器保存条镜像与全屏写作浮层。
export function createDetailView({ runtime, view, target, render, runNavigating, saveManually }) {
    function statusLabel(state) {
        if (state.saveStatus === 'unsaved')
            return { text: '未保存修改', className: 'unsaved' };
        if (state.saveStatus === 'saving')
            return { text: '正在保存...', className: 'saving' };
        if (state.saveStatus === 'saved_auto')
            return { text: `已自动保存 (${state.lastSavedTime || '刚刚'})`, className: 'saved' };
        if (state.saveStatus === 'saved_manual')
            return {
                text: `已保存 (${state.lastSavedTime || '刚刚'})${state.lastConversionCount > 0 ? ` · 已转换 ${state.lastConversionCount} 处 user` : ''}`,
                className: 'saved',
            };
        if (state.saveStatus === 'error')
            return { text: '保存失败', className: 'error' };
        return { text: '已同步', className: 'saved' };
    }

    // 窄容器下详情头部被隐藏，把保存状态镜像到窄容器顶部栏，保证手机上也能看到并发起保存。
    function syncMobileSaveChip(statusEl) {
        const chip = target.querySelector('.wie-mobile-save');
        if (!chip)
            return;
        const source = statusEl ?? target.querySelector('.wie-status-indicator');
        const label = chip.querySelector('.wie-mobile-save-label');
        if (label && source) label.textContent = source.lastElementChild?.textContent ?? '';
        chip.title = source?.title ?? '';
        chip.className = `wie-mobile-save${source?.classList.contains('wie-status-action') ? ' wie-status-action' : ''}`;
    }

    function renderDetailHeader(draft) {
        const state = runtime.state;
        const { text: statusText, className: statusClass } = statusLabel(state);

        const statusEl = h('span', { className: `wie-status-indicator ${statusClass}`, attrs: { role: 'status' } },
            h('span', { text: '●' }),
            h('span', { text: statusText }),
        );
        // 自动保存与手动保存的结果不同（手动保存会按设置转换 user 宏）；
        // 状态可点：未保存或失败时直接重试一次手动保存。
        if (state.saveStatus === 'unsaved' || state.saveStatus === 'error') {
            statusEl.classList.add('wie-status-action');
            statusEl.title = '点击立即保存';
            statusEl.addEventListener('click', () => { void saveManually(); });
        }
        else {
            statusEl.title = '自动保存不会改写正文；手动保存按设置转换 user 宏。';
        }
        syncMobileSaveChip(statusEl);

        const duplicateBtn = actionButton('📋 复制', () => {
            void runNavigating(async () => {
                await runtime.duplicateEntry(draft.uid);
            });
        }, { className: 'secondary' });

        const deleteBtn = actionButton('🗑️ 删除', () => {
            void runNavigating(async () => {
                const confirmed = await confirmDanger(target.ownerDocument, {
                    title: `确认删除条目 #${draft.uid}`,
                    message: `确定要永久删除条目「${draft.comment || '未命名'}」吗？`,
                    confirmLabel: '删除条目',
                });
                if (confirmed) {
                    await runtime.deleteEntry(draft.uid);
                    view.mobileSubView = 'list';
                }
            });
        }, { className: 'danger-button' });

        const saveBtn = actionButton('💾 保存条目', () => {
            void saveManually();
        }, { className: 'primary', title: '手动保存；开启选项时同时把独立成词的 user 转成 {{user}}。' });

        return h('div', { className: 'wie-detail-header' },
            h('div', { className: 'wie-detail-title-group' },
                h('div', {},
                    h('div', { className: 'wie-detail-h1' },
                        h('span', { text: `#${draft.uid}` }),
                        h('span', { className: 'wie-detail-name', text: draft.comment || '(未命名条目)' }),
                        draft.constant ? h('span', { className: 'wie-badge wie-badge-constant', text: '常驻' }) : null,
                    ),
                    h('div', { className: 'wie-detail-meta' }, statusEl),
                ),
            ),
            h('div', { className: 'wie-top-actions' }, duplicateBtn, deleteBtn, saveBtn),
        );
    }

    function renderZenOverlay(draft, scheduleScroll) {
        const textarea = h('textarea', {
            className: 'wie-zen-textarea',
            value: draft.content,
            placeholder: '在此沉浸输入设定正文...',
        });
        textarea.addEventListener('input', () => {
            runtime.updateDraftField('content', textarea.value);
            scheduleScroll(textarea, { delay: 60 });
        });
        textarea.addEventListener('focus', () => {
            scheduleScroll(textarea);
        });

        const header = h('div', { className: 'wie-zen-header' },
            actionButton('✕ 关闭', () => {
                view.zenMode = false;
                render();
            }, { className: 'secondary' }),
            h('span', { style: 'font-size: 13px; font-weight: 600;', text: `全屏写作: #${draft.uid} ${draft.comment || ''}` }),
            actionButton('完成', () => {
                view.zenMode = false;
                render();
            }, { className: 'primary' }),
        );

        // 宏栏放在输入区上方：软键盘从底部弹起，顶部栏始终可见可点。
        return h('div', { className: 'wie-zen-overlay' },
            header,
            renderMacroBar(textarea),
            textarea,
        );
    }

    return { renderDetailHeader, renderZenOverlay, syncMobileSaveChip };
}
