import { actionButton, createPagerBar, h } from '../../ui/dom.js';

const PAGE_SIZE = 100;

function details({ sessionId, event: entry }) {
    if (entry.featureId !== 'system' || entry.source !== 'host-frontend')
        return h('pre', { text: JSON.stringify({ sessionId, ...entry }, null, 2) });

    const content = h('div', { className: 'log-expanded-host' },
        h('pre', { text: JSON.stringify({
            hostEntryId: entry.data?.hostEntryId,
            hostTimestampMs: entry.data?.hostTimestampMs,
            hostLevel: entry.data?.hostLevel,
            messagePresent: entry.data?.messagePresent,
        }, null, 2) }),
    );
    if (entry.privacyMode === 'full') {
        if (typeof entry.sensitive?.message === 'string')
            content.append(h('p', { className: 'log-host-message', text: entry.sensitive.message }));
        if (typeof entry.sensitive?.target === 'string')
            content.append(h('p', { className: 'log-host-target', text: `来源：${entry.sensitive.target}` }));
    }
    else {
        content.append(h('p', { className: 'log-host-redacted', text: '消息因隐私模式未保存' }));
    }
    return content;
}

function makeRow({ event: entry }, label, toggle) {
    const node = actionButton('', toggle, { className: `log-row level-${entry.level}` });
    node.append(
        h('span', { text: entry.timestamp.slice(11, 23) }),
        h('b', { text: entry.level }),
        h('em', { className: 'log-feature', text: label }),
        h('i', { text: entry.source }),
        h('strong', { text: entry.event }),
    );
    return { node, event: entry, detail: null };
}

export function createLogList({ featureLabels, onToggle, onPrevious, onNext }) {
    const list = h('div', { className: 'log-list' });
    const empty = h('p', { className: 'empty-state' });
    const pager = createPagerBar({ onPrevious, onNext });
    let rows = new Map();

    function update(results, page, expanded, emptyText) {
        const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
        page = Math.min(page, pageCount - 1);
        const visible = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const next = new Map();
        for (const record of visible) {
            const { sessionId, event } = record;
            const key = `${sessionId}:${event.sequence}`;
            let row = rows.get(key);
            if (row?.event !== event)
                row = makeRow(record, featureLabels.get(event.featureId) ?? event.featureId, () => onToggle(key));
            if (expanded === key && !row.detail) {
                row.detail = details(record);
                row.node.append(row.detail);
            }
            else if (expanded !== key && row.detail) {
                row.detail.remove();
                row.detail = null;
            }
            next.set(key, row);
        }
        // 先移除淘汰或离开当前页的行，不移动仍在原顺序中的 DOM，保留焦点和展开内容。
        for (const [key, row] of rows) {
            if (next.get(key) !== row)
                row.node.remove();
        }
        if (next.size) {
            empty.remove();
            let cursor = list.firstChild;
            for (const { node } of next.values()) {
                if (node !== cursor)
                    list.insertBefore(node, cursor);
                cursor = node.nextSibling;
            }
        }
        else {
            if (empty.textContent !== emptyText)
                empty.textContent = emptyText;
            if (!empty.parentNode)
                list.append(empty);
        }
        rows = next;
        pager.update(page, pageCount);
        return page;
    }

    return { elements: [list, pager.element], update };
}
