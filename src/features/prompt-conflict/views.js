import { actionButton, callout, h } from '../../ui/dom.js';
import { searchField } from '../../ui/search-field.js';
import { isAnalyzable } from './sources.js';

const SOURCE_TYPE_LABELS = { preset: '预设', 'world-info': '世界书' };
const POSITION_LABELS = { 0: '相对', 1: '绝对', 2: '附加' };
const SEVERITY_LABELS = { high: '高', medium: '中', low: '低' };
const SEVERITY_ICONS = { high: '⛔', medium: '⚠️', low: '◽' };
const CATEGORY_LABELS = {
    contradiction: '矛盾',
    format: '格式',
    role: '角色',
    style: '风格',
    priority: '优先级',
    redundancy: '冗余',
};
const LORE_LIST_LABELS = {
    globalLore: '全局',
    characterLore: '角色',
    chatLore: '聊天',
    personaLore: 'Persona',
};

export function sourceLabel(source) {
    if (source.sourceType === 'world-info')
        return `${LORE_LIST_LABELS[source.loreList] ?? '世界书'} · ${source.worldName} · ${source.label}`;
    return source.label;
}

export function changeLabel(change, snapshot) {
    const source = snapshot?.sources?.find(candidate => candidate.sourceId === change.sourceId);
    if (source)
        return sourceLabel(source);
    return `世界书条目（UID ${String(change.uid)}，摘要 ${change.worldDigest.slice(0, 8)}…）`;
}

// 视图工厂：检测范围与结果列表都需要 runtime 状态、页面视图状态和重绘回调，
// 显式注入后这些渲染函数可以与页面编排分离。
export function createConflictViews({ runtime, view, render }) {
    function sourceRow(source, options) {
        const selectable = isAnalyzable(source);
        const check = h('input', { type: 'checkbox', className: 'pc-source-check', checked: source.enabledForDetection, disabled: !selectable });
        check.addEventListener('change', () => {
            void runtime.setSourceSelected(source.sourceId, check.checked);
        });
        const expanded = view.expanded.has(source.sourceId);
        const toggle = actionButton(expanded ? '收起' : '展开', () => {
            if (expanded)
                view.expanded.delete(source.sourceId);
            else
                view.expanded.add(source.sourceId);
            render();
        }, {
            className: 'pc-expand',
            attrs: { 'aria-expanded': String(expanded) },
        });
        const meta = source.sourceType === 'preset'
            ? `${POSITION_LABELS[source.position] ?? `位置 ${source.position}`} · 顺序 ${source.order} · ${source.content.length} 字符`
            : `UID ${String(source.uid)} · 常驻 · 顺序 ${source.order} · 位置 ${source.position} · ${source.content.length} 字符`;
        const badge = h('span', { className: `pc-badge pc-badge-${source.sourceType}`, text: SOURCE_TYPE_LABELS[source.sourceType] ?? source.sourceType });
        const heading = h('div', { className: 'pc-source-heading' },
            h('label', { className: 'pc-source-label' },
                check,
                h('div', { className: 'pc-source-name' },
                    h('div', { className: 'pc-source-title' }, badge, h('strong', { text: sourceLabel(source) })),
                    h('small', { text: meta }),
                ),
            ),
            h('div', { className: 'pc-source-actions' },
                toggle,
                source.sourceType === 'world-info'
                    ? options.suppressed
                        ? actionButton('暂存恢复', () => { void runtime.stageRestore(source.sourceId); }, { className: 'secondary' })
                        : actionButton('暂存屏蔽', () => { void runtime.stageSuppress(source.sourceId); }, { className: 'secondary' })
                    : null,
            ),
        );
        return h('article', { className: `pc-source${source.suppressedForCurrentChat ? ' suppressed' : ''}${source.dynamic ? ' dynamic' : ''}` },
            heading,
            expanded ? h('pre', { className: 'pc-source-content', text: source.content }) : null,
            source.dynamic ? h('div', { className: 'pc-source-note', text: '包含动态模板，无法静态检测；仍可直接对整个条目设置当前聊天屏蔽。' }) : null,
        );
    }

    function rangeTab() {
        const state = runtime.state;
        const sources = state.snapshot?.sources ?? [];
        const needle = view.search.trim().toLowerCase();
        const matches = source => (!needle
            || source.label.toLowerCase().includes(needle)
            || source.content.toLowerCase().includes(needle))
            && (view.sourceFilter === 'all' || source.sourceType === view.sourceFilter);
        const groups = [
            {
                key: 'preset',
                title: '预设提示词',
                hint: '当前 Chat Completions 预设中已启用、非 marker、非空且参与普通生成的项目。',
                sources: sources.filter(source => source.sourceType === 'preset' && !source.dynamic && matches(source)),
            },
            {
                key: 'world',
                title: '生效的常驻世界书',
                hint: '当前挂载世界书中启用且常驻的条目。',
                sources: sources.filter(source => source.sourceType === 'world-info' && !source.suppressedForCurrentChat && !source.dynamic && matches(source)),
            },
            {
                key: 'suppressed',
                title: '当前聊天已屏蔽',
                hint: '这些条目已在本聊天屏蔽，不再参与检测；可随时恢复。',
                sources: sources.filter(source => source.suppressedForCurrentChat && matches(source)),
            },
            {
                key: 'unsupported',
                title: '无法静态检测',
                hint: '包含 EJS 或 ST-Prompt-Template 动态内容，不会被发送给检测模型。',
                sources: sources.filter(source => source.dynamic && !source.suppressedForCurrentChat && matches(source)),
            },
        ];
        const search = searchField({
            value: view.search,
            placeholder: '搜索来源名称与全文',
            className: 'pc-search',
            dataset: { control: 'search' },
            onQuery: value => { view.search = value; render(); },
        });
        const filter = h('select', { className: 'pc-source-filter', attrs: { 'aria-label': '来源筛选' } });
        for (const [value, label] of [['all', '全部'], ['preset', '预设'], ['world-info', '世界书']])
            filter.append(h('option', { value, text: label }));
        filter.value = view.sourceFilter;
        filter.addEventListener('change', () => { view.sourceFilter = filter.value; render(); });
        const section = h('section', { className: 'pc-range' },
            h('div', { className: 'pc-range-toolbar' },
                search,
                filter,
                h('div', { className: 'pc-range-actions' },
                    actionButton('全选当前有效来源', () => { void runtime.selectAllAnalyzable(); }, { className: 'secondary' }),
                    actionButton('清空选择', () => { void runtime.clearSelection(); }, { className: 'secondary', disabled: !runtime.state.selectedSourceIds.size }),
                ),
            ),
            groups.map(group => {
                const groupNode = h('section', { className: 'pc-group' },
                    h('h3', { className: 'pc-group-title', text: `${group.title} ${group.sources.length}` }),
                    group.sources.length ? h('p', { className: 'pc-group-hint', text: group.hint }) : null,
                );
                if (!group.sources.length) {
                    groupNode.append(h('p', { className: 'empty-state', text: '暂无来源。' }));
                }
                else {
                    groupNode.append(h('div', { className: 'pc-source-list' },
                        group.sources.map(source => sourceRow(source, { suppressed: group.key === 'suppressed' })),
                    ));
                }
                return groupNode;
            }),
        );
        return section;
    }

    function directiveEvidence(directive) {
        return h('div', { className: 'pc-directive' },
            h('div', { className: 'pc-directive-head' },
                h('span', { className: `pc-kind pc-kind-${directive.kind}`, text: directive.kind }),
                h('strong', { text: directive.statement }),
            ),
            directive.condition ? h('p', { className: 'pc-directive-condition', text: `条件：${directive.condition}` }) : null,
            h('ul', { className: 'pc-evidence' }, directive.evidence.map(segment =>
                h('li', {}, h('code', { text: segment })))),
        );
    }

    function conflictCard(conflict, index) {
        const state = runtime.state;
        const report = state.report;
        const expanded = view.expanded.has(`conflict:${index}`);
        const involvedSources = [];
        const seen = new Set();
        for (const directiveId of conflict.directiveIds) {
            const sourceId = directiveId.split('#', 1)[0];
            if (seen.has(sourceId))
                continue;
            seen.add(sourceId);
            involvedSources.push(sourceId);
        }
        const toggle = actionButton(expanded ? '收起' : '展开', () => {
            if (expanded)
                view.expanded.delete(`conflict:${index}`);
            else
                view.expanded.add(`conflict:${index}`);
            render();
        }, { className: 'pc-expand', attrs: { 'aria-expanded': String(expanded) } });
        const card = h('article', { className: `pc-conflict pc-conflict-${conflict.severity}` },
            h('div', { className: 'pc-conflict-head' },
                h('div', { className: 'pc-conflict-meta' },
                    h('span', { className: `pc-sev pc-sev-${conflict.severity}`, text: `${SEVERITY_ICONS[conflict.severity]} ${SEVERITY_LABELS[conflict.severity]}` }),
                    h('span', { className: 'pc-category', text: CATEGORY_LABELS[conflict.category] ?? conflict.category }),
                ),
                toggle,
            ),
            h('h4', { text: conflict.title }),
            h('p', { className: 'pc-conflict-sources', text: involvedSources.length > 1 ? `涉及来源：${involvedSources.length} 个` : '来源内部' }),
            expanded ? h('div', { className: 'pc-conflict-detail' },
                h('h5', { text: '冲突解释' }),
                h('p', { text: conflict.explanation }),
                h('h5', { text: '涉及的原子指令' }),
                h('div', { className: 'pc-directives' },
                    conflict.directiveIds.map(directiveId => {
                        const directive = report.directives.find(candidate => candidate.directiveId === directiveId);
                        if (!directive)
                            return h('p', { className: 'pc-directive-missing', text: directiveId });
                        return directiveEvidence(directive);
                    }),
                ),
                conflict.options.length ? h('div', { className: 'pc-options' },
                    h('h5', { text: '处理选项' }),
                    conflict.options.map(option => h('div', { className: 'pc-option' },
                        h('strong', { text: option.label }),
                        h('p', { text: option.consequence }),
                    )),
                ) : null,
                h('div', { className: 'pc-conflict-actions' },
                    involvedSources.map(sourceId => {
                        const source = state.snapshot?.sources?.find(candidate => candidate.sourceId === sourceId);
                        if (!source || source.sourceType !== 'world-info' || source.suppressedForCurrentChat)
                            return null;
                        return actionButton(`暂存屏蔽：${sourceLabel(source)}`, () => { void runtime.stageSuppress(sourceId); }, {
                            className: 'secondary',
                            disabled: state.reportStale,
                        });
                    }),
                ),
            ) : null,
        );
        return card;
    }

    function resultsTab() {
        const state = runtime.state;
        const report = state.report;
        const section = h('section', { className: 'pc-results' });
        if (!report) {
            section.append(h('p', { className: 'empty-state', text: '还没有检测结果。请先调整检测范围并开始检测。' }));
            return section;
        }
        const counts = report.counts;
        const conflicts = report.conflicts.filter(conflict =>
            (view.severityFilter === 'all' || conflict.severity === view.severityFilter)
            && (view.categoryFilter === 'all' || conflict.category === view.categoryFilter));
        const time = new Date(report.finishedAt).toLocaleString('zh-CN');
        const summary = h('div', { className: 'pc-summary' },
            h('div', { className: 'pc-summary-row' },
                h('span', { text: `检测时间 ${time}` }),
                h('span', { text: `纳入 ${report.sourceIds.length} 个来源` }),
                h('span', { text: `${report.batches} 批提取 + 1 次比较 = ${report.calls} 次模型调用` }),
                h('span', { className: 'pc-sev-count', text: `⛔ ${counts.high} · ⚠️ ${counts.medium} · ◽ ${counts.low}` }),
            ),
            h('div', { className: 'pc-summary-filters' },
                h('label', {}, h('span', { text: '严重度' }),
                    selectFilter('severity', [['all', '全部'], ['high', '高'], ['medium', '中'], ['low', '低']])),
                h('label', {}, h('span', { text: '分类' }),
                    selectFilter('category', [['all', '全部'], ...Object.entries(CATEGORY_LABELS)])),
            ),
        );
        if (state.reportStale)
            section.append(callout('报告已过期：当前来源或选择已变化。请重新读取并重新检测后才能操作报告中的动作。', 'danger'));
        section.append(summary);
        if (!report.conflicts.length) {
            const sources = state.snapshot?.sources ?? [];
            section.append(h('div', { className: 'pc-no-conflict' },
                h('h3', { text: '在本次检测范围内未发现冲突' }),
                h('p', { text: `纳入 ${report.sourceIds.length} 个来源；临时排除 ${sources.filter(source => isAnalyzable(source) && !report.sourceIds.includes(source.sourceId)).length} 个；当前聊天已屏蔽 ${sources.filter(source => source.suppressedForCurrentChat).length} 个；无法静态检测 ${sources.filter(source => source.dynamic && !source.suppressedForCurrentChat).length} 个。` }),
            ));
        }
        else {
            section.append(h('div', { className: 'pc-conflict-list' }, conflicts.map((conflict, index) => conflictCard(conflict, index))));
        }
        return section;

        function selectFilter(key, options) {
            const select = h('select');
            for (const [value, label] of options)
                select.append(h('option', { value, text: label }));
            select.value = view[key + 'Filter'];
            select.addEventListener('change', () => { view[key + 'Filter'] = select.value; render(); });
            return select;
        }
    }

    return { rangeTab, resultsTab };
}
