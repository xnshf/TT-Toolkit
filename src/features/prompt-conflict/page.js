import { actionButton, callout, h } from '../../ui/dom.js';
import { captureFocus, restoreFocus } from '../../ui/focus-keep.js';
import { estimateModelCallCount, isAnalyzable } from './sources.js';
import { changeLabel, createConflictViews } from './views.js';

export function mountPromptConflictPage(target, props) {
    const runtime = props.runtime;
    const view = {
        tab: 'range',
        search: '',
        sourceFilter: 'all',
        severityFilter: 'all',
        categoryFilter: 'all',
        expanded: new Set(),
        dialogOpen: false,
        trigger: null,
        lastReportId: null,
    };
    let disposed = false;

    const dialog = document.createElement('dialog');
    dialog.className = 'pc-dialog';
    dialog.addEventListener('close', () => {
        view.dialogOpen = false;
        runtime.cancelApplyReview();
        view.trigger?.focus();
        render();
    });
    document.body.append(dialog);

    const { rangeTab, resultsTab } = createConflictViews({ runtime, view, render });

    function openDialog(trigger) {
        view.trigger = trigger;
        render();
        runtime.beginApplyReview().then(() => {
            if (disposed || view.dialogOpen)
                return;
            view.dialogOpen = true;
            dialog.showModal();
            const first = dialog.querySelector('button, [tabindex]');
            first?.focus();
        });
    }

    function closeDialog() {
        if (dialog.open)
            dialog.close();
    }

    function run(task) {
        try {
            task();
        }
        catch (error) {
            runtime.state.error = error instanceof Error ? error.message : String(error);
        }
        render();
    }

    function counts(state) {
        const sources = state.snapshot?.sources ?? [];
        return {
            analyzable: sources.filter(isAnalyzable).length,
            suppressed: sources.filter(source => source.suppressedForCurrentChat).length,
            unsupported: sources.filter(source => source.dynamic && !source.suppressedForCurrentChat).length,
        };
    }

    function stagedCounts() {
        const plan = [...runtime.state.stagedChanges.values()];
        return {
            suppress: plan.filter(change => change.action === 'suppress').length,
            restore: plan.filter(change => change.action === 'restore').length,
        };
    }

    function stagingBar() {
        const staged = stagedCounts();
        if (!staged.suppress && !staged.restore)
            return null;
        return h('div', { className: 'pc-staging-bar' },
            h('span', { className: 'pc-staging-count', text: `待屏蔽 ${staged.suppress} 项 · 待恢复 ${staged.restore} 项` }),
            h('div', { className: 'pc-staging-actions' },
                actionButton('放弃更改', () => { void runtime.clearStagedChanges(); }, { className: 'secondary' }),
                actionButton('检查并应用', event => openDialog(event.currentTarget), { className: 'primary' }),
            ),
        );
    }

    function renderDialog() {
        const state = runtime.state;
        const changes = [...state.stagedChanges.values()];
        const suppress = changes.filter(change => change.action === 'suppress');
        const restore = changes.filter(change => change.action === 'restore');
        const dynamicSuppress = suppress.filter(change => change.dynamic);
        const rows = [];
        rows.push(h('h3', { text: '确认聊天级屏蔽变更' }));
        rows.push(h('p', { className: 'pc-dialog-chat', text: `当前聊天：${state.chatIdentity?.label ?? '未知'}` }));
        rows.push(h('h4', { text: `待屏蔽（${suppress.length} 项）` }));
        if (suppress.length) {
            rows.push(h('ul', { className: 'pc-dialog-list' }, suppress.map(change =>
                h('li', { text: changeLabel(change, state.snapshot) }))));
        }
        else {
            rows.push(h('p', { className: 'pc-dialog-empty', text: '没有待屏蔽项。' }));
        }
        rows.push(h('h4', { text: `待恢复（${restore.length} 项）` }));
        if (restore.length) {
            rows.push(h('ul', { className: 'pc-dialog-list' }, restore.map(change =>
                h('li', { text: changeLabel(change, state.snapshot) }))));
        }
        else {
            rows.push(h('p', { className: 'pc-dialog-empty', text: '没有待恢复项。' }));
        }
        if (dynamicSuppress.length)
            rows.push(callout(`注意：${dynamicSuppress.length} 个动态模板条目被屏蔽时会禁用整个条目，而不是只禁用其中某个动态分支。`, 'warning'));
        const apply = actionButton('应用', () => {
            apply.disabled = true;
            cancel.disabled = true;
            void runtime.commitStagedChanges().then(() => {
                closeDialog();
            });
        }, { className: 'primary', disabled: state.applying });
        const cancel = actionButton('取消', closeDialog, { className: 'secondary', disabled: state.applying });
        rows.push(h('div', { className: 'pc-dialog-actions' }, cancel, apply));
        dialog.replaceChildren(...rows);
    }

    function render() {
        if (disposed)
            return;
        // 重绘前记下焦点控件与光标，重绘后恢复，否则每次输入都会丢掉正在编辑的搜索框。
        const snapshot = captureFocus(target);
        const state = runtime.state;
        if (state.report && state.report.reportId !== view.lastReportId) {
            view.lastReportId = state.report.reportId;
            view.tab = 'results';
        }
        const c = counts(state);
        const toggle = h('input', { type: 'checkbox', checked: props.enabled });
        toggle.addEventListener('change', () => {
            run(() => { void props.setEnabled(toggle.checked); });
            props.enabled = toggle.checked;
        });
        const preset = h('select', { className: 'pc-preset' });
        const activeName = state.presetOptions.find(item => item.id === state.activePresetId)?.name;
        preset.append(h('option', { value: '', text: activeName ? `跟随当前预设（${activeName}）` : '跟随当前预设（未设置）' }));
        for (const option of state.presetOptions)
            preset.append(h('option', { value: option.id, text: `${option.name}（${option.model}）` }));
        preset.value = state.selectedModelPresetId ?? '';
        preset.addEventListener('change', () => {
            void run(() => runtime.selectPreset(preset.value).catch(() => undefined));
        });
        const detecting = state.phase === 'detecting';
        const selected = runtime.selectedSources();
        const startButton = detecting
            ? actionButton('取消', () => runtime.cancelRun(), { className: 'danger' })
            : actionButton('开始检测', () => { void runtime.runDetection(); }, {
                className: 'primary',
                disabled: state.phase === 'reading' || state.applying || !selected.length,
            });
        const root = h('section', { className: 'feature-page pc-page' },
            h('header', { className: 'feature-header' },
                h('div', {},
                    h('p', { className: 'eyebrow', text: '提示词' }),
                    h('h2', { text: '冲突检测' }),
                    h('p', { text: '对照当前预设与挂载世界书中的常驻指令，并管理当前聊天的世界书屏蔽。' }),
                ),
                h('label', { className: 'master-toggle' }, toggle, h('span', { text: props.enabled ? '已启用' : '未启用' })),
            ),
            h('div', { className: 'pc-controls' },
                h('div', { className: 'pc-controls-meta' },
                    h('strong', { text: state.chatIdentity?.label ?? '正在读取聊天……' }),
                    h('small', { className: 'pc-counts', text: `可检测 ${c.analyzable} · 已屏蔽 ${c.suppressed} · 不支持 ${c.unsupported}` }),
                ),
                h('label', { className: 'pc-preset-select' }, h('span', { text: '模型预设' }), preset),
                h('div', { className: 'pc-controls-actions' },
                    actionButton('重新读取', () => { void runtime.refresh(); }, { className: 'secondary', disabled: state.phase !== 'idle' || state.applying }),
                    startButton,
                ),
            ),
            h('p', { className: 'pc-privacy', text: `检测会把选中来源的文本发送到所选模型服务；报告与模型中间结果只保存在内存中，不写入持久存储。预计模型调用 ${estimateModelCallCount(selected)} 次（提取批次数 + 1 次比较）。` }),
            h('div', { className: 'pc-tabs', role: 'tablist', attrs: { 'aria-label': '冲突检测内容' } },
                tabButton('range', `检测范围 ${state.snapshot?.sources.length ?? 0}`),
                tabButton('results', `检测结果 ${state.report?.conflicts.length ?? 0}`),
            ),
        );
        if (!props.enabled)
            root.append(callout('功能未启用；页面仍可配置检测范围，但不会在生成时过滤世界书条目。', 'warning'));
        if (state.presetError)
            root.append(callout(`模型预设读取失败：${state.presetError}`, 'warning'));
        if (state.metadataError)
            root.append(callout(`聊天屏蔽数据读取失败：${state.metadataError}。在修复前不会应用屏蔽。`, 'danger'),
                h('div', { className: 'actions' },
                    actionButton('重置本聊天数据', () => { void runtime.resetChatMetadata(); }, { className: 'danger' })));
        if (state.error)
            root.append(callout(state.error, 'danger'));
        if (state.status)
            root.append(callout(state.status));
        if (state.phase === 'detecting' && state.activeRun) {
            const run = state.activeRun;
            root.append(callout(run.stage === 'comparing'
                ? '正在比较冲突……'
                : `正在提取 ${run.done}/${run.total} 批……`));
        }
        root.append(h('div', { className: 'pc-tab-body', attrs: { role: 'tabpanel' } },
            view.tab === 'range' ? rangeTab() : resultsTab()));
        root.append(stagingBar());
        root.append(h('div', { className: 'pc-live', attrs: { 'aria-live': 'polite' }, text: state.status ? `状态：${state.status}` : '' }));
        target.replaceChildren(root);
        restoreFocus(target, snapshot);
        renderDialog();

        function tabButton(key, label) {
            const button = actionButton(label, () => { view.tab = key; render(); }, {
                className: `pc-tab${view.tab === key ? ' active' : ''}`,
                attrs: view.tab === key ? { 'aria-selected': 'true', 'aria-current': 'page' } : { 'aria-selected': 'false' },
                role: 'tab',
            });
            return button;
        }
    }

    const unsubscribe = runtime.subscribe(() => render());
    render();
    if (runtime.state.phase === 'idle' && !runtime.state.snapshot)
        void runtime.refresh();
    return () => {
        disposed = true;
        unsubscribe();
        if (dialog.open)
            dialog.close();
        dialog.remove();
        target.replaceChildren();
    };
}
