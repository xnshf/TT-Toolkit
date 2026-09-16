import { actionButton, callout, h } from '../../ui/dom.js';
import { ToolkitError, errorMessage } from '../../kernel/errors.js';
import {
    SOURCE_LABELS,
    SOURCE_ORDER,
    TRIGGER_LABELS,
    WORLD_POSITION_LABELS,
    filterItems,
    promptDocumentFilename,
    sourceCounts,
    stringifyContent,
    sumTokens,
} from './model.js';

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightedText(text, query) {
    const fragment = document.createDocumentFragment();
    if (!query) {
        fragment.append(document.createTextNode(text));
        return fragment;
    }
    const matcher = new RegExp(escapeRegex(query), 'giu');
    let cursor = 0;
    for (const match of text.matchAll(matcher)) {
        const index = match.index ?? 0;
        if (index > cursor)
            fragment.append(document.createTextNode(text.slice(cursor, index)));
        fragment.append(h('mark', { text: match[0] }));
        cursor = index + match[0].length;
    }
    if (cursor < text.length)
        fragment.append(document.createTextNode(text.slice(cursor)));
    return fragment;
}

function itemKey(kind, item) {
    return `${kind}:${item.order}:${item.identifier}`;
}

function itemState(view, key) {
    if (view.expandAll === 'full')
        return 'full';
    if (view.expandAll === 'hidden')
        return 'hidden';
    const override = view.itemStates.get(key);
    if (override)
        return override;
    return view.settings?.defaultCollapsed === false ? 'full' : 'preview';
}

function sourceBadge(source) {
    return h('span', { className: `prompt-source-badge source-${source}`, text: SOURCE_LABELS[source] ?? source });
}

function worldEntryLine(entry, index) {
    const position = WORLD_POSITION_LABELS[entry.position] ?? WORLD_POSITION_LABELS.unknown;
    const depth = entry.position === 'depth' && Number.isFinite(entry.depth) ? ` d${entry.depth}` : '';
    return h('div', { className: 'prompt-world-entry' },
        h('span', { className: 'prompt-world-index', text: `#${index + 1}` }),
        h('strong', { text: entry.comment || String(entry.uid) }),
        entry.world ? h('span', { className: 'prompt-world-book', text: entry.world }) : null,
        h('span', { className: 'prompt-world-position', text: `${position}${depth}` }),
        h('span', { className: 'prompt-world-trigger', text: TRIGGER_LABELS[entry.trigger] ?? entry.trigger }),
        entry.role ? h('span', { className: 'prompt-world-role', text: entry.role }) : null,
    );
}

function modelParts(snapshot, info) {
    const model = snapshot?.model ?? (info ? { name: info.model, source: info.source } : null);
    const parts = [];
    parts.push(model?.name ? `模型：${model.name}` : '模型：未知');
    if (model?.source)
        parts.push(`来源：${model.source}`);
    const budget = snapshot?.tokenBudget ?? info?.tokenBudget ?? null;
    if (budget && Number.isFinite(budget.maxContext) && Number.isFinite(budget.maxTokens)) {
        const usable = budget.maxContext - budget.maxTokens;
        if (usable > 0)
            parts.push(`可用上下文：${usable} tokens`);
    }
    if (snapshot)
        parts.push(`本轮 token：${snapshot.tokenTotal}`);
    return parts;
}

export function mountPromptViewerPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        tab: 'sent',
        filterSource: 'all',
        query: '',
        expandAll: null,
        itemStates: new Map(),
        snapshotKey: null,
        input: '',
        notice: '',
    };
    let disposed = false;

    const currentSnapshot = () => (view.tab === 'prediction' ? runtime.state.prediction : runtime.state.snapshot);

    const run = async task => {
        try {
            view.notice = '';
            await task();
        }
        catch (error) {
            view.notice = errorMessage(error);
        }
        render();
    };

    async function copyCurrent() {
        const snapshot = currentSnapshot();
        if (!snapshot)
            throw new ToolkitError('PROMPT_VIEWER_NO_SNAPSHOT', '当前没有可复制的内容。');
        const text = runtime.exportText(view.tab);
        if (!navigator.clipboard?.writeText)
            throw new ToolkitError('PROMPT_VIEWER_EXPORT_FAILED', '当前环境不支持剪贴板复制。');
        await navigator.clipboard.writeText(text);
        runtime.logExport(view.tab, 'copy', snapshot.items.length);
        view.notice = '已复制实际发送的 messages 数组。';
    }

    function downloadCurrent() {
        const snapshot = currentSnapshot();
        if (!snapshot)
            throw new ToolkitError('PROMPT_VIEWER_NO_SNAPSHOT', '当前没有可下载的内容。');
        const text = runtime.exportText(view.tab);
        const document = target.ownerDocument;
        const window = document.defaultView ?? globalThis;
        const BlobCtor = window.Blob ?? Blob;
        const URLCtor = window.URL ?? URL;
        const url = URLCtor.createObjectURL(new BlobCtor([text], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = promptDocumentFilename(view.tab);
        link.style.display = 'none';
        document.body.append(link);
        link.click();
        window.setTimeout(() => {
            link.remove();
            URLCtor.revokeObjectURL(url);
        }, 1000);
        runtime.logExport(view.tab, 'download', snapshot.items.length);
        view.notice = `已下载 ${link.download}。`;
    }

    function renderHeader(root) {
        const toggle = h('input', { type: 'checkbox', checked: view.enabled });
        toggle.addEventListener('change', () => {
            const next = toggle.checked;
            void run(async () => {
                await props.setEnabled(next);
                view.enabled = next;
                if (next)
                    await runtime.refreshInfo();
                else {
                    view.toggled = new Set();
                    view.expandAll = null;
                }
            });
        });
        root.append(h('header', { className: 'feature-header' },
            h('div', {},
                h('p', { className: 'eyebrow', text: '提示词' }),
                h('h2', { text: '提示词查看' }),
                h('p', { text: '逐条查看最近一轮实际发送的提示词，并预测给定输入会组装成什么提示词。' }),
            ),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '已启用' : '未启用' })),
        ));
    }

    function renderStatus(root) {
        const info = runtime.state.info;
        if (!view.enabled) {
            root.append(callout('功能尚未启用。启用后才会在后台捕获正文轮次，并可进行预测。', 'warning'));
            return;
        }
        if (info && info.mainApi && info.mainApi !== 'openai') {
            root.append(callout('当前不是聊天补全（Chat Completion）接口，提示词查看不可用。', 'danger'));
        }
        else if (info && !info.promptManagerReady) {
            root.append(callout(`宿主 PromptManager 尚不可用（${info.reason ?? '未知原因'}），暂时无法捕获或预测。`, 'warning'));
        }
        if (view.notice)
            root.append(callout(view.notice, 'success'));
        if (runtime.state.error)
            root.append(callout(runtime.state.error, 'danger'));
        const snapshot = runtime.state.snapshot;
        if (snapshot?.squashSystemMessages)
            root.append(callout('宿主已开启 system 消息合并，逐条粒度可能受限；导出内容仍为实际发送结果。', 'warning'));
        if (snapshot && snapshot.removedAgentItemCount > 0)
            root.append(callout(`该轮含 ${snapshot.removedAgentItemCount} 条 Agent 专用条目，已按普通组装口径移除。`, 'info'));
        if (snapshot && snapshot.assemblyRoundCount > 1)
            root.append(callout(`本轮组装 ${snapshot.assemblyRoundCount} 次（可能包含工具调用或多轮 Agent 调用），仅显示最后一次结果。`, 'info'));
        if (runtime.state.pendingUpdate && view.tab === 'sent') {
            root.append(h('div', { className: 'prompt-update-banner' },
                h('span', { text: '检测到新的一轮。' }),
                actionButton('查看新的一轮', () => {
                    runtime.acknowledgeUpdate();
                    render();
                }, { className: 'primary' }),
            ));
        }
        if (runtime.state.status && view.enabled && !runtime.state.error)
            root.append(h('p', { className: 'prompt-status', text: runtime.state.status }));
    }

    function renderModelBar(root) {
        const snapshot = currentSnapshot();
        const parts = modelParts(snapshot, runtime.state.info);
        root.append(h('div', { className: 'prompt-model-bar' }, parts.map(part => h('span', { text: part }))));
    }

    function renderTabs(root) {
        const tabs = [['sent', '上一轮'], ['prediction', '预测']];
        root.append(h('nav', { className: 'feature-tabs' }, tabs.map(([id, label]) => actionButton(label, () => {
            view.tab = id;
            view.expandAll = null;
            view.itemStates = new Map();
            if (id === 'prediction')
                void runtime.refreshInfo();
            render();
        }, { className: view.tab === id ? 'active' : '' }))));
    }

    function renderToolbar(root, snapshot) {
        const items = snapshot?.items ?? [];
        const counts = sourceCounts(items);
        if (view.filterSource !== 'all' && !counts.some(entry => entry.source === view.filterSource))
            view.filterSource = 'all';
        const select = h('select', { className: 'prompt-source-filter', attrs: { 'aria-label': '来源筛选' } },
            h('option', { value: 'all', text: '全部来源', selected: view.filterSource === 'all' }),
            counts.map(({ source, label, count }) => h('option', {
                value: source,
                text: `${label}（${count}）`,
                selected: view.filterSource === source,
            })),
        );
        select.addEventListener('change', () => {
            view.filterSource = select.value;
            render();
        });
        const search = h('input', {
            className: 'prompt-search-input',
            type: 'search',
            value: view.query,
            placeholder: '搜索正文或条目名称',
            attrs: { 'aria-label': '搜索提示词' },
        });
        search.addEventListener('input', () => {
            view.query = search.value;
            render();
        });
        root.append(h('div', { className: 'prompt-toolbar' },
            select,
            search,
            h('label', { className: 'prompt-default-expand' },
                h('input', {
                    type: 'checkbox',
                    checked: runtime.state.settings.defaultCollapsed === false,
                    on: {
                        change: event => {
                            const checked = event.target.checked;
                            void run(async () => {
                                await runtime.updateSettings({ defaultCollapsed: !checked });
                                view.expandAll = null;
                                view.itemStates = new Map();
                            });
                        },
                    },
                }),
                h('span', { text: '默认展开全部正文' }),
            ),
            actionButton('全部展开', () => { view.expandAll = 'full'; view.itemStates = new Map(); render(); }, { className: 'secondary', disabled: items.length === 0 }),
            actionButton('全部折叠', () => { view.expandAll = 'hidden'; view.itemStates = new Map(); render(); }, { className: 'secondary', disabled: items.length === 0 }),
            actionButton('复制提示词', () => { void run(copyCurrent); }, { className: 'secondary', disabled: !snapshot }),
            actionButton('下载 .txt', () => { void run(async () => downloadCurrent()); }, { className: 'primary', disabled: !snapshot }),
        ));
    }

    function renderItems(root, snapshot) {
        const filtered = filterItems(snapshot.items, { source: view.filterSource, query: view.query });
        root.append(h('div', { className: 'prompt-list-heading' },
            h('strong', { text: `显示 ${filtered.length} / ${snapshot.items.length} 条条目` }),
            h('span', { text: `共 ${sumTokens(filtered)} tokens` }),
        ));
        if (filtered.length === 0) {
            root.append(callout(snapshot.items.length === 0 ? '这一轮没有任何组装条目。' : '没有符合筛选或搜索条件的条目。'));
            return;
        }
        root.append(h('div', { className: 'prompt-list' }, filtered.map(item => {
            const key = itemKey(snapshot.kind, item);
            const searching = view.query.trim().length > 0;
            const state = searching ? 'full' : itemState(view, key);
            const body = h('div', { className: `prompt-item-body${state === 'preview' ? ' preview' : ''}` });
            if (state !== 'hidden') {
                const content = stringifyContent(item.content);
                if (content) {
                    body.append(highlightedText(content, view.query));
                }
                else {
                    body.append(h('span', { className: 'prompt-empty-content', text: '（无正文）' }));
                }
                if (item.worldEntryRefs.length) {
                    const refs = item.worldEntryRefs
                        .map(index => snapshot.worldEntries[index])
                        .filter(Boolean);
                    if (refs.length)
                        body.append(h('p', { className: 'prompt-item-hint', text: `聚合了 ${refs.length} 条世界书条目，见下方“本次激活的世界书条目”。` }));
                }
            }
            const toggleButton = searching ? null : actionButton(state === 'full' ? '收起' : '展开', () => {
                const next = state === 'full' ? 'preview' : 'full';
                if (view.expandAll !== null) {
                    for (const other of filtered)
                        view.itemStates.set(itemKey(snapshot.kind, other), view.expandAll);
                    view.expandAll = null;
                }
                view.itemStates.set(key, next);
                render();
            }, { className: 'secondary' });
            return h('article', { className: 'prompt-item', dataset: { source: item.source } },
                h('header', {},
                    h('div', { className: 'prompt-item-title' },
                        h('span', { className: 'prompt-item-order', text: `#${item.order + 1}` }),
                        sourceBadge(item.source),
                        h('strong', { text: item.label }),
                        item.name ? h('span', { className: 'prompt-item-name', text: item.name }) : null,
                        h('span', { className: 'prompt-item-role', text: item.role }),
                    ),
                    h('div', { className: 'prompt-item-actions' },
                        h('span', { className: 'prompt-item-tokens', text: item.tokens === null ? '-' : `${item.tokens} t` }),
                        toggleButton,
                    ),
                ),
                state === 'hidden' ? null : body,
            );
        })));
    }

    function renderWorldPanel(root, snapshot) {
        if (!snapshot.worldEntries.length)
            return;
        const entries = snapshot.worldEntries.map(worldEntryLine);
        root.append(h('details', { className: 'prompt-world-panel' },
            h('summary', { text: `本次激活的世界书条目（${snapshot.worldEntries.length}）` }),
            h('div', { className: 'prompt-world-list' }, entries),
        ));
    }

    function renderPredictionForm(root) {
        const info = runtime.state.info;
        const disabled = !view.enabled || runtime.state.busy || (info && !info.promptManagerReady) || (info && info.mainApi && info.mainApi !== 'openai');
        const textarea = h('textarea', {
            className: 'prompt-prediction-input',
            value: view.input,
            rows: 3,
            placeholder: '输入假设的用户消息，预测会组装成什么提示词',
            attrs: { 'aria-label': '假设的用户消息' },
        });
        textarea.addEventListener('input', () => { view.input = textarea.value; });
        root.append(h('section', { className: 'prompt-prediction' },
            textarea,
            h('div', { className: 'prompt-prediction-actions' },
                actionButton(runtime.state.busy ? '正在预测……' : '预测', () => {
                    void run(async () => {
                        await runtime.predict(view.input);
                    });
                }, { className: 'primary', disabled }),
            ),
            h('p', { className: 'prompt-prediction-hint', text: '预测通过宿主 dry-run 组装，会短暂占用宿主输入框并发出一轮 dry-run 事件，完成后立即还原；固定按普通聊天补全组装。' }),
        ));
    }

    function render() {
        if (disposed)
            return;
        const root = h('section', { className: 'feature-page prompt-viewer-page' });
        renderHeader(root);
        if (!view.enabled) {
            renderStatus(root);
            target.replaceChildren(root);
            return;
        }
        const snapshot = currentSnapshot();
        const snapshotKey = snapshot ? `${snapshot.kind}:${snapshot.capturedAtMs}` : null;
        if (snapshotKey !== view.snapshotKey) {
            view.snapshotKey = snapshotKey;
            view.expandAll = null;
            view.itemStates = new Map();
        }
        view.settings = runtime.state.settings;
        renderStatus(root);
        renderModelBar(root);
        renderTabs(root);
        renderToolbar(root, snapshot);
        if (snapshot) {
            renderWorldPanel(root, snapshot);
            renderItems(root, snapshot);
        }
        else {
            root.append(callout(view.tab === 'prediction'
                ? '输入一段假设的用户消息后点击“预测”。'
                : '尚未捕获正文轮次；在宿主中发送一条消息后再查看。'));
        }
        if (view.tab === 'prediction')
            renderPredictionForm(root);
        target.replaceChildren(root);
    }

    const unsubscribe = runtime.subscribe(render);
    render();
    if (view.enabled)
        void runtime.refreshInfo();
    return () => {
        disposed = true;
        unsubscribe();
        target.replaceChildren();
    };
}
