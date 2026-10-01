import { actionButton, callout, h } from '../../ui/dom.js';
import { errorMessage } from '../../kernel/errors.js';
import {
    defaultChatRange,
    paginateChatItems,
    prefixSnippet,
    searchChatMessages,
    searchSnippet,
    selectChatRange,
} from './model.js';

const TABS = [['range', '楼层范围'], ['search', '正文搜索']];

function formatDate(value) {
    if (value === null)
        return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightedText(text, query) {
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

function stats(model) {
    const values = [
        ['对话楼层', model.stats.conversationMessages],
        ['原始消息', model.stats.totalMessages],
        ['明确 system 排除', model.stats.excludedSystemMessages],
        ['tool 排除', model.stats.excludedToolMessages],
        ['隐藏对话', model.stats.hiddenConversationMessages],
    ];
    return h('div', { className: 'viewer-stats' }, values.map(([label, value]) => h('div', {},
        h('span', { text: label }),
        h('strong', { text: String(value) }),
    )));
}

function messageBody(item, expanded, query) {
    const snippet = expanded
        ? { text: item.text, truncated: false }
        : query ? searchSnippet(item.text, query) : prefixSnippet(item.text);
    const body = h('div', { className: 'viewer-message-body' });
    if (snippet.leading)
        body.append(document.createTextNode('…'));
    body.append(highlightedText(snippet.text, query));
    if (snippet.trailing || (snippet.truncated && !snippet.leading))
        body.append(document.createTextNode('…'));
    return body;
}

function messageCard(item, view, runtime, props, rerender) {
    const key = `${view.resultMode}:${item.absoluteIndex}`;
    const expanded = view.expanded === key;
    const query = view.resultMode === 'search' ? view.appliedQuery : '';
    const metadata = [
        item.role === 'user' ? '用户' : 'AI',
        item.name,
        formatDate(item.sendDate),
        item.hidden ? (item.compact ? '隐藏/紧凑' : '隐藏') : '',
        item.swipeCount ? `swipe ${item.swipeNumber}/${item.swipeCount}` : '',
        `原始索引 ${item.absoluteIndex}`,
    ].filter(Boolean);
    return h('article', { className: 'viewer-message-card', dataset: { absoluteIndex: item.absoluteIndex } },
        h('header', {},
            h('div', {},
                h('strong', { text: `对话楼层 ${item.conversationIndex}` }),
                h('div', { className: 'viewer-message-meta' }, metadata.map(value => h('span', { text: value }))),
            ),
            h('div', { className: 'viewer-card-actions' },
                actionButton(expanded ? '收起' : '展开全文', () => {
                    view.expanded = expanded ? null : key;
                    rerender();
                }, { className: 'secondary' }),
                actionButton('跳转', () => {
                    void (async () => {
                        try {
                            view.notice = '';
                            await runtime.jump(item);
                            props.closeWorkbench();
                        }
                        catch (error) {
                            view.notice = errorMessage(error);
                            rerender();
                        }
                    })();
                }, { className: 'primary', disabled: runtime.state.busy }),
            ),
        ),
        messageBody(item, expanded, query),
    );
}

export function mountChatViewerPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        tab: 'range',
        rangeStart: '',
        rangeEnd: '',
        rangeIdentity: null,
        query: '',
        appliedQuery: '',
        resultMode: 'range',
        results: [],
        page: 0,
        expanded: null,
        notice: '',
    };
    let disposed = false;

    function adoptModel(model, resetRange = false) {
        const changedChat = view.rangeIdentity !== model.identity.stableId;
        if (resetRange || changedChat || !view.rangeStart || !view.rangeEnd) {
            const range = defaultChatRange(model);
            view.rangeStart = range.start ? String(range.start) : '';
            view.rangeEnd = range.end ? String(range.end) : '';
            view.rangeIdentity = model.identity.stableId;
        }
    }

    function applyCurrentView(model) {
        adoptModel(model);
        if (view.tab === 'search' && view.appliedQuery) {
            view.results = searchChatMessages(model, view.appliedQuery);
            view.resultMode = 'search';
        }
        else if (model.items.length) {
            view.results = selectChatRange(model, Number(view.rangeStart), Number(view.rangeEnd));
            view.resultMode = 'range';
        }
        else {
            view.results = [];
        }
        view.page = 0;
        view.expanded = null;
    }

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
                    applyCurrentView(model);
                }
                else {
                    view.results = [];
                    view.rangeIdentity = null;
                }
            });
        });
        root.append(h('header', { className: 'feature-header' },
            h('div', {},
                h('p', { className: 'eyebrow', text: '聊天数据' }),
                h('h2', { text: '聊天查看' }),
                h('p', { text: '按对话楼层范围查看、搜索并跳转当前聊天。' }),
            ),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '已启用' : '未启用' })),
        ));
        if (!view.enabled)
            root.append(callout('功能尚未启用。启用后才会读取当前聊天和订阅聊天变化事件。', 'warning'));
        if (view.notice)
            root.append(callout(view.notice, 'danger'));
        else if (runtime.state.error)
            root.append(callout(runtime.state.error, 'danger'));
        if (runtime.state.stale)
            root.append(callout('当前聊天已发生变化；下次查看、搜索或跳转时会自动重新读取。', 'warning'));
    }

    function renderTabs(root) {
        root.append(h('nav', { className: 'feature-tabs' }, TABS.map(([id, label]) => actionButton(label, () => {
            view.tab = id;
            view.page = 0;
            view.expanded = null;
            render();
        }, { className: view.tab === id ? 'active' : '' }))));
    }

    function renderRange(root, model) {
        const start = h('input', { className: 'number-input', type: 'number', min: 1, max: model.items.length, step: 1, value: view.rangeStart, attrs: { 'aria-label': '起始楼层' } });
        const end = h('input', { className: 'number-input', type: 'number', min: 1, max: model.items.length, step: 1, value: view.rangeEnd, attrs: { 'aria-label': '截止楼层' } });
        start.addEventListener('input', () => { view.rangeStart = start.value; });
        end.addEventListener('input', () => { view.rangeEnd = end.value; });
        root.append(h('section', { className: 'viewer-controls' },
            h('label', {}, h('span', { text: '起始楼层' }), start),
            h('span', { className: 'viewer-range-separator', text: '至' }),
            h('label', {}, h('span', { text: '截止楼层' }), end),
            actionButton('查看范围', () => {
                void run(async () => {
                    const result = await runtime.range(Number(view.rangeStart), Number(view.rangeEnd));
                    adoptModel(result.model);
                    view.results = result.items;
                    view.resultMode = 'range';
                    view.page = 0;
                    view.expanded = null;
                });
            }, { className: 'primary', disabled: runtime.state.busy || model.items.length === 0 }),
        ));
    }

    function renderSearch(root) {
        const query = h('input', { className: 'viewer-search-input', type: 'search', value: view.query, placeholder: '输入正文关键词', attrs: { 'aria-label': '正文关键词' } });
        query.addEventListener('input', () => { view.query = query.value; });
        query.addEventListener('keydown', event => {
            if (event.key === 'Enter')
                root.querySelector('[data-viewer-search]')?.click();
        });
        root.append(h('section', { className: 'viewer-search-controls' },
            query,
            actionButton('搜索全部对话', () => {
                void run(async () => {
                    const result = await runtime.search(view.query);
                    adoptModel(result.model);
                    view.appliedQuery = view.query;
                    view.results = result.items;
                    view.resultMode = 'search';
                    view.page = 0;
                    view.expanded = null;
                });
            }, { className: 'primary', dataset: { viewerSearch: '' }, disabled: runtime.state.busy }),
        ));
    }

    function renderResults(root) {
        const pagination = paginateChatItems(view.results, view.page);
        view.page = pagination.page;
        const summary = view.resultMode === 'search'
            ? `“${view.appliedQuery}”命中 ${view.results.length} 个对话楼层`
            : `当前范围 ${view.results.length} 个对话楼层`;
        root.append(h('div', { className: 'viewer-results-heading' },
            h('strong', { text: summary }),
            h('span', { text: `${pagination.page + 1} / ${pagination.pageCount}` }),
        ));
        if (pagination.items.length === 0) {
            root.append(callout(view.resultMode === 'search' ? '没有找到包含该正文的对话楼层。' : '当前范围没有可显示的对话楼层。'));
            return;
        }
        root.append(h('div', { className: 'viewer-message-list' }, pagination.items.map(item => messageCard(item, view, runtime, props, render))));
        root.append(h('div', { className: 'pager' },
            actionButton('上一页', () => { view.page -= 1; view.expanded = null; render(); }, { disabled: pagination.page === 0 }),
            h('span', { text: `${pagination.page + 1} / ${pagination.pageCount}` }),
            actionButton('下一页', () => { view.page += 1; view.expanded = null; render(); }, { disabled: pagination.page + 1 >= pagination.pageCount }),
        ));
    }

    function render() {
        if (disposed)
            return;
        const root = h('section', { className: 'feature-page chat-viewer-page' });
        renderHeader(root);
        if (!view.enabled) {
            target.replaceChildren(root);
            return;
        }
        const model = runtime.state.model;
        root.append(h('div', { className: 'viewer-toolbar' },
            h('span', { text: runtime.state.status }),
            actionButton('刷新当前聊天', () => {
                void run(async () => {
                    const refreshed = await runtime.refresh();
                    adoptModel(refreshed);
                    applyCurrentView(refreshed);
                });
            }, { className: 'secondary', disabled: runtime.state.busy }),
        ));
        if (!model) {
            root.append(callout(runtime.state.busy ? '正在读取当前聊天……' : '尚未读取当前聊天。'));
            target.replaceChildren(root);
            return;
        }
        root.append(stats(model));
        renderTabs(root);
        if (view.tab === 'range')
            renderRange(root, model);
        else
            renderSearch(root);
        renderResults(root);
        target.replaceChildren(root);
    }

    const unsubscribe = runtime.subscribe(render);
    render();
    if (view.enabled) {
        void run(async () => {
            const model = await runtime.refresh();
            adoptModel(model, true);
            applyCurrentView(model);
        });
    }
    return () => {
        disposed = true;
        unsubscribe();
        target.replaceChildren();
    };
}
