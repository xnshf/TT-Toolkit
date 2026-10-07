import { actionButton, callout, h } from '../../ui/dom.js';
import { errorMessage } from '../../kernel/errors.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { confirmDanger } from '../../ui/confirm.js';

const PAGE_SIZE = 20;
const TABS = [['manual', '手动清洗'], ['rules', '规则设置'], ['auto', '自动清洗'], ['status', '运行状态']];

function settingRow(title, description, control) {
    return h('div', { className: 'setting-row' },
        h('div', {}, h('strong', { text: title }), description ? h('small', { text: description }) : null),
        control,
    );
}

function flattenPlan(plan) {
    const items = [];
    for (const change of plan?.changes ?? []) {
        for (const patch of change.bodyPatches) {
            items.push({
                key: `${change.messageIndex}:${String(patch.swipeIndex)}`,
                change,
                swipeIndex: patch.swipeIndex,
                before: patch.before,
                after: patch.after,
            });
        }
        if (change.clearSwipesPatch) {
            items.push({ key: `${change.messageIndex}:swipes`, change, swipeIndex: null,
                before: `[其它候选 ${change.clearSwipesPatch.removedCount} 个及其 swipe_info]`,
                after: '[仅保留当前候选，编号重置为 0]', removedSwipes: change.clearSwipesPatch.removedCount });
        }
        if (!change.bodyPatches.length && change.reasoningPatches.length) {
            items.push({
                key: `${change.messageIndex}:reasoning`,
                change,
                swipeIndex: null,
                before: '[原生 reasoning]',
                after: '[已清空]',
            });
        }
    }
    return items;
}

export function mountChatCleanerPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        tab: 'manual',
        keep: 0,
        page: 0,
        expanded: null,
        draft: structuredClone(runtime.state.settings),
        previewKeep: null,
    };
    let disposed = false;
    const notices = createNoticeController(() => render());

    const run = async task => {
        notices.clear();
        try {
            await task();
        }
        catch (error) {
            notices.show(errorMessage(error), 'danger');
        }
        render();
    };

    function renderHeader(root) {
        const toggle = h('input', { type: 'checkbox', checked: view.enabled });
        toggle.addEventListener('change', () => {
            const next = toggle.checked;
            void run(async () => {
                await props.setEnabled(next);
                view.enabled = next;
            });
        });
        root.append(h('header', { className: 'feature-header' },
            h('div', {},
                h('p', { className: 'eyebrow', text: '聊天数据' }),
                h('h2', { text: '聊天清洗' }),
                h('p', { text: '永久移除明确匹配区段与原生 reasoning，可选择仅保留当前 swipe。' }),
            ),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '已启用' : '未启用' })),
        ));
        root.append(h('nav', { className: 'feature-tabs' }, TABS.map(([id, label]) => actionButton(label, () => {
            view.tab = id;
            render();
        }, { className: view.tab === id ? 'active' : '' }))));
        if (!view.enabled)
            root.append(callout('功能尚未启用。可以先配置规则；启用前不会读取聊天、执行清洗或订阅生成事件。', 'warning'));
        const notice = noticeBanner(notices.current, () => notices.clear(true));
        if (notice)
            root.append(notice);
        if (runtime.state.error)
            root.append(callout(runtime.state.error, 'danger'));
    }

    function renderManual(root) {
        const section = h('div', { className: 'page-section' });
        const keep = h('input', { className: 'number-input', type: 'number', min: 0, step: 1, value: view.keep });
        keep.addEventListener('input', () => { view.keep = Number(keep.value); });
        keep.addEventListener('change', render);
        section.append(
            settingRow('分别保留最新消息', 'AI 与用户分别保留 M 条；0 表示扫描全部可处理历史。', keep),
            h('div', { className: 'actions' }, actionButton('扫描并预览', () => {
                void run(async () => {
                    await runtime.previewManual(view.keep);
                    view.page = 0;
                    view.expanded = null;
                    view.previewKeep = view.keep;
                });
            }, { className: 'primary', disabled: !view.enabled || runtime.state.busy })),
        );
        const plan = runtime.state.currentPlan;
        if (plan) {
            section.append(h('div', { className: 'stats-grid' }, [
                ['历史楼层', plan.stats.totalMessages],
                ['可处理楼层', plan.stats.eligibleMessages],
                ['明确 system 排除', plan.stats.excludedSystemMessages],
                ['tool 排除', plan.stats.excludedToolMessages],
                ['隐藏纳入', plan.stats.hiddenEligibleMessages],
                ['紧凑纳入', plan.stats.compactEligibleMessages],
                ['扫描楼层', plan.stats.scannedMessages],
                ['修改楼层', plan.stats.changedMessages],
                ['正文删除', plan.stats.bodyRemovedChars],
                ['思考删除', plan.stats.reasoningRemovedChars],
                ['其它候选清除', plan.stats.removedSwipes ?? 0],
                ['局部异常楼层', plan.stats.degradedMessages ?? 0],
            ].map(([label, value]) => h('div', {}, h('span', { text: label }), h('strong', { text: String(value) })))));
            if (plan.warnings.length) {
                section.append(h('details', { className: 'callout warning', open: true },
                    h('summary', { text: `预览警告（${plan.warnings.length} 条，请核对局部遗漏及候选清除）` }),
                    h('ul', {}, plan.warnings.map(message => h('li', { text: message }))),
                ));
            }
            const hasEmpty = plan.changes.some(change => change.emptySwipeIndexes.length > 0);
            const removedSwipes = plan.stats.removedSwipes ?? 0;
            if (hasEmpty)
                section.append(callout('存在将变为空字符串的 swipe。提交时需要额外危险确认。', 'danger'));
            const flattened = flattenPlan(plan);
            const pageCount = Math.max(1, Math.ceil(flattened.length / PAGE_SIZE));
            const stale = view.previewKeep !== view.keep;
            if (stale)
                section.append(callout('保留数量已变化；请重新扫描后再永久提交。', 'warning'));
            section.append(h('div', { className: 'feature-action-bar' },
                h('span', { text: `本次将修改 ${plan.stats.changedMessages} 个楼层；提交后无法由插件撤销。` }),
                actionButton('永久提交清洗', () => {
                    void run(async () => {
                        const confirmed = await confirmDanger(target.ownerDocument, {
                            title: hasEmpty ? '确认保存空 swipe' : '确认永久清洗',
                            message: `将永久写回当前聊天。${hasEmpty ? '本批次包含将被保存为空字符串的候选。' : ''}${removedSwipes ? `将删除 ${removedSwipes} 个其它候选及其 swipe_info，仅保留当前候选。` : ''}${plan.warnings.length ? `有 ${plan.warnings.length} 条警告，请核对上述局部遗漏后继续。` : ''}插件不提供备份或撤销，请先自行备份；删除内容只能从你自己的备份恢复。确定继续吗？`,
                            confirmLabel: '确认永久提交',
                        });
                        if (!confirmed)
                            return;
                        await runtime.commitManual(hasEmpty, plan);
                        view.previewKeep = null;
                        notices.show(runtime.state.status, 'success');
                    });
                }, { className: 'danger-button', disabled: stale || runtime.state.busy || plan.changes.length === 0 }),
            ));
            view.page = Math.min(view.page, pageCount - 1);
            const visible = flattened.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
            section.append(h('div', { className: 'preview-list' }, visible.map(item => {
                const row = actionButton('', () => {
                    view.expanded = view.expanded === item.key ? null : item.key;
                    render();
                }, { className: 'preview-row' });
                row.append(
                    h('span', { text: `楼层 ${item.change.messageIndex} · ${item.swipeIndex === null ? '当前正文/思考' : `swipe ${item.swipeIndex + 1}`}` }),
                    h('b', { text: item.removedSwipes ? `清除 ${item.removedSwipes} 个候选` : `-${item.before.length - item.after.length} 字符` }),
                );
                if (view.expanded === item.key)
                    row.append(h('div', { className: 'diff-grid' }, h('pre', { text: item.before }), h('pre', { text: item.after })));
                return row;
            })));
            section.append(h('div', { className: 'pager' },
                actionButton('上一页', () => { view.page -= 1; render(); }, { disabled: view.page === 0 }),
                h('span', { text: `${view.page + 1} / ${pageCount}` }),
                actionButton('下一页', () => { view.page += 1; render(); }, { disabled: view.page + 1 >= pageCount }),
            ));
        }
        root.append(section);
    }

    function renderRules(root) {
        const section = h('div', { className: 'page-section' });
        const reasoning = h('input', { type: 'checkbox', checked: view.draft.deleteNativeReasoning });
        reasoning.addEventListener('change', () => { view.draft.deleteNativeReasoning = reasoning.checked; });
        const clearSwipes = h('input', { type: 'checkbox', checked: view.draft.clearSwipes });
        clearSwipes.addEventListener('change', () => { view.draft.clearSwipes = clearSwipes.checked; });
        section.append(h('div', { className: 'feature-action-bar' },
            h('span', { text: '保存正文、reasoning 与候选清洗设置。' }),
            actionButton('保存规则', () => {
                void run(async () => {
                    await runtime.saveSettings(structuredClone(view.draft));
                    notices.show('设置已保存。规则变化后，自动清洗将在当前聊天重新建立基线。', 'success');
                });
            }, { className: 'primary', disabled: runtime.state.busy })));
        section.append(
            settingRow('删除原生 reasoning', '按酒馆原生行为清空明文及展示状态，保留 signature、native 与未知字段。', reasoning),
            settingRow('清除其它 swipes（仅保留当前候选）', '默认关闭；适用于手动和自动清洗范围内的 AI/用户楼层，不受正文规则开关影响。永久删除其它候选及其 swipe_info，当前正文保留，编号重置为 0。请先自行备份，插件无法撤销。', clearSwipes),
        );
        for (const groupName of ['assistant', 'user']) {
            const group = view.draft[groupName];
            const enabled = h('input', { type: 'checkbox', checked: group.enabled });
            enabled.addEventListener('change', () => { group.enabled = enabled.checked; });
            const box = h('div', { className: 'rule-group' },
                h('div', { className: 'rule-heading' },
                    h('div', {}, h('h3', { text: groupName === 'assistant' ? 'AI 正文规则' : '用户正文规则' }), h('small', { text: '与另一角色完全独立，按列表顺序执行。' })),
                    h('label', {}, enabled, ' 启用'),
                ),
            );
            group.rules.forEach((rule, index) => {
                const ruleEnabled = h('input', { type: 'checkbox', checked: rule.enabled, title: '启用规则' });
                ruleEnabled.addEventListener('change', () => { rule.enabled = ruleEnabled.checked; });
                const start = h('input', { value: rule.start, placeholder: '开始标记（可单独使用）' });
                start.addEventListener('input', () => { rule.start = start.value; });
                const end = h('input', { value: rule.end, placeholder: '结束标记（可单独使用）' });
                end.addEventListener('input', () => { rule.end = end.value; });
                const row = h('div', { className: 'rule-row' },
                    ruleEnabled, start, end,
                    actionButton('↑', () => {
                        if (index > 0) {
                            const [moved] = group.rules.splice(index, 1);
                            group.rules.splice(index - 1, 0, moved);
                            render();
                        }
                    }),
                    actionButton('↓', () => {
                        if (index + 1 < group.rules.length) {
                            const [moved] = group.rules.splice(index, 1);
                            group.rules.splice(index + 1, 0, moved);
                            render();
                        }
                    }),
                    actionButton('删除', () => { group.rules.splice(index, 1); render(); }),
                );
                if (!rule.start || !rule.end)
                    row.append(h('small', { className: 'risk', text: '单边规则会删除到正文边界，请仔细预览。' }));
                box.append(row);
            });
            box.append(actionButton('添加字面规则', () => {
                group.rules.push({ id: crypto.randomUUID(), enabled: true, start: '', end: '' });
                render();
            }, { className: 'secondary' }));
            section.append(box);
        }
        root.append(section);
    }

    function renderAuto(root) {
        const section = h('div', { className: 'page-section' });
        const enabled = h('input', { type: 'checkbox', checked: view.draft.auto.enabled });
        enabled.addEventListener('change', () => { view.draft.auto.enabled = enabled.checked; });
        const keepAssistant = h('input', { className: 'number-input', type: 'number', min: 1, value: view.draft.auto.keepAssistant });
        keepAssistant.addEventListener('input', () => { view.draft.auto.keepAssistant = Number(keepAssistant.value); });
        const keepUser = h('input', { className: 'number-input', type: 'number', min: 1, value: view.draft.auto.keepUser });
        keepUser.addEventListener('input', () => { view.draft.auto.keepUser = Number(keepUser.value); });
        section.append(h('div', { className: 'feature-action-bar' },
            h('span', { text: '保存自动清洗开关与保留数量。' }),
            actionButton('保存自动清洗设置', () => {
                void run(async () => {
                    await runtime.saveSettings(structuredClone(view.draft));
                    notices.show('设置已保存。规则变化后，自动清洗将在当前聊天重新建立基线。', 'success');
                });
            }, { className: 'primary', disabled: runtime.state.busy })));
        section.append(
            settingRow('生成结束后自动增量清洗', '首次运行或规则变化只建立基线，不回扫旧历史。', enabled),
            settingRow('保留最新 AI 消息', '', keepAssistant),
            settingRow('保留最新用户消息', '', keepUser),
        );
        root.append(section);
    }

    function renderStatus(root) {
        const progress = runtime.state.progress;
        root.append(h('div', { className: 'page-section' },
            h('div', { className: 'status-card' }, h('strong', { text: '最近状态' }), h('p', { text: runtime.state.status })),
            h('div', { className: 'status-card' }, h('strong', { text: '当前聊天断点（绝对索引）' }), h('p', {
                text: progress ? `AI 已处理至 ${progress.assistantThrough} · 用户已处理至 ${progress.userThrough} · ${progress.lastSuccessfulAt ?? '尚未成功清洗'}` : '尚未读取。',
            })),
            h('div', { className: 'actions' },
                actionButton('重置当前聊天断点', () => { void run(async () => { await runtime.resetProgress(); notices.show('当前聊天清洗断点已重置。', 'success'); }); }, { className: 'secondary' }),
                actionButton('重置清洗设置', () => { void run(async () => { await runtime.resetSettings(); view.draft = structuredClone(runtime.state.settings); notices.show('聊天清洗设置已重置。', 'success'); }); }, { className: 'secondary' }),
            ),
        ));
    }

    function render() {
        if (disposed)
            return;
        const root = h('section', { className: 'feature-page' });
        renderHeader(root);
        if (view.tab === 'manual')
            renderManual(root);
        else if (view.tab === 'rules')
            renderRules(root);
        else if (view.tab === 'auto')
            renderAuto(root);
        else
            renderStatus(root);
        target.replaceChildren(root);
    }

    const unsubscribe = runtime.subscribe(render);
    render();
    void runtime.loadProgress().catch(() => undefined);
    return () => {
        notices.dispose();
        disposed = true;
        unsubscribe();
        target.replaceChildren();
    };
}
