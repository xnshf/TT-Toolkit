import { errorMessage } from '../../kernel/errors.js';
import { actionButton, callout, h } from '../../ui/dom.js';
import { confirmDanger } from '../../ui/confirm.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { saveChatDocument } from './file.js';

const PAGE_SIZE = 20;
const TABS = [['export', '导出'], ['rules', '规则设置']];

function option(value, label, selected) {
    return h('option', { value, text: label, selected });
}

function settingRow(title, description, control) {
    return h('div', { className: 'setting-row' },
        h('div', {}, h('strong', { text: title }), description ? h('small', { text: description }) : null),
        control,
    );
}

function statsGrid(plan) {
    const values = [
        ['历史楼层', plan.projectionStats.totalMessages],
        ['对话楼层', plan.projectionStats.conversationMessages],
        ['明确 system 排除', plan.projectionStats.excludedSystemMessages],
        ['tool 排除', plan.projectionStats.excludedToolMessages],
        ['范围内', plan.stats.rangedMessages],
        ['角色过滤后', plan.stats.roleFilteredMessages],
        ['最终导出', plan.stats.exportedMessages],
        ['规则跳过', plan.stats.skippedMessages],
        ['正文变化', plan.stats.changedMessages],
        ['警告', plan.stats.warningCount],
    ];
    return h('div', { className: 'exporter-stats' }, values.map(([label, value]) =>
        h('div', {}, h('span', { text: label }), h('strong', { text: String(value) }))));
}

function createRuleRow(group, kind, rule, index, render, dirty) {
    const rules = group[kind === 'include' ? 'includeRules' : 'excludeRules'];
    const enabled = h('input', { type: 'checkbox', checked: rule.enabled, title: '启用规则' });
    const start = h('input', { value: rule.start, placeholder: '开始标记' });
    const end = h('input', { value: rule.end, placeholder: kind === 'include' ? '结束标记（必填）' : '结束标记（可单独使用）' });
    enabled.addEventListener('change', () => { rule.enabled = enabled.checked; dirty(); });
    start.addEventListener('input', () => { rule.start = start.value; dirty(); });
    end.addEventListener('input', () => { rule.end = end.value; dirty(); });
    return h('div', { className: 'exporter-rule-row' },
        enabled, start, end,
        actionButton('↑', () => {
            if (index > 0) {
                const [moved] = rules.splice(index, 1);
                rules.splice(index - 1, 0, moved);
                dirty();
                render();
            }
        }),
        actionButton('↓', () => {
            if (index + 1 < rules.length) {
                const [moved] = rules.splice(index, 1);
                rules.splice(index + 1, 0, moved);
                dirty();
                render();
            }
        }),
        actionButton('删除', () => { rules.splice(index, 1); dirty(); render(); }),
    );
}

export function mountChatExporterPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        tab: 'export',
        title: '聊天记录',
        rangeStart: '',
        rangeEnd: '',
        rangeIdentity: null,
        draft: structuredClone(runtime.state.settings),
        dirty: false,
        page: 0,
    };
    let disposed = false;
    const notices = createNoticeController(() => render());

    function markDirty() {
        view.dirty = true;
    }

    function adoptModel(model, reset = false) {
        if (reset || view.rangeIdentity !== model.identity.stableId || !view.rangeStart || !view.rangeEnd) {
            view.rangeStart = model.items.length ? '1' : '';
            view.rangeEnd = model.items.length ? String(model.items.length) : '';
            view.rangeIdentity = model.identity.stableId;
        }
    }

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

    async function download(confirmed) {
        try {
            const suggestion = runtime.downloadSuggestion(view.title);
            const result = await saveChatDocument(target, suggestion, () => runtime.prepareDownload(view.title, confirmed));
            if (result.saved) {
                runtime.downloaded(result.payload);
                notices.show('文档已保存。', 'success');
            }
            else {
                notices.show('已取消保存。', 'info');
            }
        }
        catch (error) {
            runtime.fileFailed(error);
            throw error;
        }
    }

    function renderHeader(root) {
        const toggle = h('input', { type: 'checkbox', checked: view.enabled });
        toggle.addEventListener('change', () => {
            const next = toggle.checked;
            void run(async () => {
                await props.setEnabled(next);
                view.enabled = next;
                if (next) {
                    const model = await runtime.refresh();
                    adoptModel(model, true);
                }
                else {
                    view.rangeIdentity = null;
                    view.rangeStart = '';
                    view.rangeEnd = '';
                }
            });
        });
        root.append(h('header', { className: 'feature-header' },
            h('div', {},
                h('p', { className: 'eyebrow', text: '聊天数据' }),
                h('h2', { text: '聊天导出' }),
                h('p', { text: '将当前聊天整理为 Markdown 或纯文本文档，不保留原始聊天结构。' }),
            ),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '已启用' : '未启用' })),
        ));
        root.append(h('nav', { className: 'feature-tabs' }, TABS.map(([id, label]) => actionButton(label, () => {
            view.tab = id;
            view.page = 0;
            render();
        }, { className: view.tab === id ? 'active' : '' }))));
        if (!view.enabled)
            root.append(callout('功能尚未启用。可以先配置规则；启用前不会读取聊天或订阅聊天变化事件。', 'warning'));
        const notice = noticeBanner(notices.current, () => notices.clear(true));
        if (notice)
            root.append(notice);
        if (runtime.state.error)
            root.append(callout(runtime.state.error, 'danger'));
        if (runtime.state.stale)
            root.append(callout('当前聊天已变化，原预览已失效，请重新生成。', 'warning'));
        if (view.dirty && runtime.state.currentPlan)
            root.append(callout('导出设置已有未预览的更改，请重新生成预览。', 'warning'));
    }

    function renderExportControls(root, model) {
        const title = h('input', { value: view.title, placeholder: '聊天记录', maxlength: 120 });
        title.addEventListener('input', () => { view.title = title.value; });
        const format = h('select', {},
            option('markdown', 'Markdown (.md)', view.draft.format === 'markdown'),
            option('text', '纯文本 (.txt)', view.draft.format === 'text'),
        );
        format.addEventListener('change', () => { view.draft.format = format.value; markDirty(); });
        const roleFilter = h('select', {},
            option('all', '全部消息', view.draft.roleFilter === 'all'),
            option('assistant', '仅 AI', view.draft.roleFilter === 'assistant'),
            option('user', '仅用户', view.draft.roleFilter === 'user'),
        );
        roleFilter.addEventListener('change', () => { view.draft.roleFilter = roleFilter.value; markDirty(); });
        const anonymous = h('input', { type: 'checkbox', checked: view.draft.anonymous });
        anonymous.addEventListener('change', () => { view.draft.anonymous = anonymous.checked; markDirty(); });
        const start = h('input', { className: 'number-input', type: 'number', min: 1, max: model?.items.length || 1, value: view.rangeStart });
        const end = h('input', { className: 'number-input', type: 'number', min: 1, max: model?.items.length || 1, value: view.rangeEnd });
        start.addEventListener('input', () => { view.rangeStart = start.value; markDirty(); });
        end.addEventListener('input', () => { view.rangeEnd = end.value; markDirty(); });
        root.append(h('section', { className: 'page-section exporter-controls' },
            settingRow('文档标题', '仅用于本次文档和文件名，不写入持久设置。', title),
            settingRow('文件格式', 'Markdown 为默认格式；正文字符不会被重新排版。', format),
            settingRow('角色过滤', '过滤发生在规则处理之前。', roleFilter),
            settingRow('匿名说话者', '只把角色标签改为“用户/助手”，绝不替换正文。', anonymous),
            h('div', { className: 'exporter-range' },
                h('label', {}, h('span', { text: '起始对话楼层' }), start),
                h('span', { text: '至' }),
                h('label', {}, h('span', { text: '截止对话楼层' }), end),
            ),
            h('div', { className: 'actions' },
                actionButton('刷新当前聊天', () => {
                    void run(async () => {
                        const refreshed = await runtime.refresh();
                        adoptModel(refreshed, true);
                        view.dirty = false;
                    });
                }, { className: 'secondary', disabled: runtime.state.busy || !view.enabled }),
                actionButton('生成导出预览', () => {
                    void run(async () => {
                        await runtime.saveSettings(structuredClone(view.draft));
                        view.draft = structuredClone(runtime.state.settings);
                        await runtime.preview(Number(view.rangeStart), Number(view.rangeEnd));
                        view.dirty = false;
                        view.page = 0;
                    });
                }, { className: 'primary', disabled: runtime.state.busy || !view.enabled || !model?.items.length }),
            ),
        ));
    }

    function renderPreview(root) {
        const plan = runtime.state.currentPlan;
        if (!plan) {
            root.append(callout('必须先生成预览，确认最终正文后才能下载。'));
            return;
        }
        root.append(statsGrid(plan));
        if (plan.warnings.length)
            root.append(callout(plan.warnings.map(item => item.message).join('\n'), 'warning'));
        root.append(h('div', { className: 'feature-action-bar' },
            h('span', { text: `已预览 ${plan.stats.exportedMessages} 条消息；保存不会修改聊天。` }),
            actionButton('保存文档', () => {
                void run(async () => {
                    if (plan.requiresConfirmation) {
                        const confirmed = await confirmDanger(target.ownerDocument, {
                            title: '确认跳过有风险的消息',
                            message: `预览包含 ${plan.stats.warningCount} 条警告，将跳过 ${plan.stats.skippedMessages} 条消息。导出不会修改聊天，确定按预览结果保存吗？`,
                            confirmLabel: '确认并保存',
                            confirmClass: 'primary',
                        });
                        if (!confirmed)
                            return;
                    }
                    await download(plan.requiresConfirmation);
                });
            }, { className: 'primary', disabled: runtime.state.busy || runtime.state.stale || view.dirty }),
        ));
        const pageCount = Math.max(1, Math.ceil(plan.entries.length / PAGE_SIZE));
        view.page = Math.min(view.page, pageCount - 1);
        const entries = plan.entries.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
        root.append(h('div', { className: 'exporter-preview-list' }, entries.map(entry =>
            h('article', { className: `exporter-preview-card${entry.included ? '' : ' skipped'}` },
                h('header', {},
                    h('strong', { text: `对话楼层 ${entry.conversationIndex} · ${entry.role === 'assistant' ? 'AI' : '用户'}` }),
                    h('span', { text: entry.included ? (entry.originalText === entry.text ? '原样' : '已处理') : '将跳过' }),
                ),
                entry.originalText !== entry.text && entry.included
                    ? h('div', { className: 'exporter-diff' }, h('pre', { text: entry.originalText }), h('pre', { text: entry.text }))
                    : h('pre', { text: entry.included ? entry.text : entry.originalText }),
            ))));
        root.append(h('div', { className: 'pager' },
            actionButton('上一页', () => { view.page -= 1; render(); }, { disabled: view.page === 0 }),
            h('span', { text: `${view.page + 1} / ${pageCount}` }),
            actionButton('下一页', () => { view.page += 1; render(); }, { disabled: view.page + 1 >= pageCount }),
        ));
    }

    function renderExport(root) {
        const model = runtime.state.model;
        root.append(h('div', { className: 'exporter-toolbar' }, h('span', { text: runtime.state.status })));
        renderExportControls(root, model);
        if (model)
            renderPreview(root);
    }

    function renderRuleGroup(root, role) {
        const group = view.draft[role];
        const label = role === 'assistant' ? 'AI 正文' : '用户正文';
        const strategy = h('select', {},
            option('none', '不处理', group.strategy === 'none'),
            option('include', '正选提取', group.strategy === 'include'),
            option('exclude', '反选删除', group.strategy === 'exclude'),
        );
        strategy.addEventListener('change', () => { group.strategy = strategy.value; markDirty(); });
        const box = h('section', { className: 'exporter-role-group' },
            h('div', { className: 'exporter-role-heading' },
                h('div', {}, h('h3', { text: label }), h('small', { text: '同一角色每次只会执行一种策略。' })),
                strategy,
            ),
        );
        for (const [kind, title, description] of [
            ['include', '正选规则', '只保留完整标记内部；开始和结束标记都必填。'],
            ['exclude', '反选规则', '删除标记及其内部；允许单边标记。'],
        ]) {
            const rules = group[kind === 'include' ? 'includeRules' : 'excludeRules'];
            box.append(h('div', { className: 'exporter-rule-bank' },
                h('header', {}, h('strong', { text: title }), h('small', { text: description })),
                ...rules.map((rule, index) => createRuleRow(group, kind, rule, index, render, markDirty)),
                actionButton(`添加${title}`, () => {
                    rules.push({ id: crypto.randomUUID(), enabled: true, start: '', end: '' });
                    markDirty();
                    render();
                }, { className: 'secondary' }),
            ));
        }
        root.append(box);
    }

    function renderRules(root) {
        const section = h('div', { className: 'page-section' });
        section.append(h('div', { className: 'feature-action-bar' },
            h('span', { text: '复制现有清洗规则，或保存当前导出规则。' }),
            actionButton('复制聊天清洗反选规则', () => {
                void run(async () => {
                    await runtime.copyCleanerRules();
                    view.draft = structuredClone(runtime.state.settings);
                    view.dirty = false;
                    notices.show(runtime.state.status, 'success');
                });
            }, { className: 'secondary', disabled: runtime.state.busy }),
            actionButton('保存规则设置', () => {
                void run(async () => {
                    await runtime.saveSettings(structuredClone(view.draft));
                    view.draft = structuredClone(runtime.state.settings);
                    view.dirty = false;
                    notices.show('聊天导出规则已保存。', 'success');
                });
            }, { className: 'primary', disabled: runtime.state.busy }),
        ));
        renderRuleGroup(section, 'assistant');
        renderRuleGroup(section, 'user');
        root.append(section);
    }

    function render() {
        if (disposed)
            return;
        const root = h('section', { className: 'feature-page chat-exporter-page' });
        renderHeader(root);
        if (view.tab === 'rules')
            renderRules(root);
        else if (view.enabled)
            renderExport(root);
        target.replaceChildren(root);
    }

    const unsubscribe = runtime.subscribe(render);
    render();
    if (view.enabled) {
        void run(async () => {
            const model = await runtime.refresh();
            adoptModel(model, true);
        });
    }
    return () => {
        disposed = true;
        notices.dispose();
        unsubscribe();
        target.replaceChildren();
    };
}
