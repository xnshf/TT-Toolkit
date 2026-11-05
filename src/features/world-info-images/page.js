import { actionButton, callout, h } from '../../ui/dom.js';
import { createActionRunner } from '../../ui/run-action.js';
import { captureFocus, restoreFocus } from '../../ui/focus-keep.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { confirmDanger } from '../../ui/confirm.js';
import { searchField } from '../../ui/search-field.js';
import { errorMessage } from '../../kernel/errors.js';
import { readEntryImageBindingSafe } from './schema.js';

const SOURCE_LABELS = { chat: '当前聊天', character: '当前角色', global: '全局常驻', persona: '用户设定' };

function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMimeShort(mimeType) {
    return mimeType ? String(mimeType).replace(/^image\//i, '').toUpperCase() : '图片';
}

function computeBookStats(items) {
    let imageCount = 0;
    let invalidCount = 0;
    let totalBytes = 0;
    let constantCount = 0;
    for (const item of items) {
        if (item.constant) constantCount += 1;
        if (item.hasImage) {
            imageCount += 1;
            totalBytes += item.imageBinding?.sizeBytes ?? 0;
        }
        if (item.imageInvalid || item.broken) invalidCount += 1;
    }
    return {
        total: items.length, imageCount, constantCount, invalidCount, totalBytes,
        unimagedCount: Math.max(0, items.length - imageCount - invalidCount),
    };
}

export function mountWorldInfoImagesPage(target, props) {
    const { runtime } = props;
    let enabled = props.enabled;
    let disposed = false;
    let url = '';
    let mobileSubView = 'list';
    let contextOpen = false;
    let listScrollTop = 0;
    let renderedUid = null;
    let renderedWorld = '';

    const notices = createNoticeController(() => render());
    const run = createActionRunner({ notices, render, failureKind: 'warning' });
    const control = key => ({ 'data-control': key });
    target.classList.add('wii-host');

    async function saveManually() {
        try {
            const saved = await runtime.saveCurrentDraft();
            notices.show(saved ? '图片设置已保存。' : '没有需要保存的修改。', saved ? 'success' : 'info');
            return true;
        }
        catch (error) {
            notices.show(errorMessage(error), 'warning');
            render();
            return false;
        }
    }

    async function runNavigating(task) {
        notices.clear();
        try {
            await task();
        }
        catch (error) {
            const message = errorMessage(error);
            const discard = runtime.state.dirty && await confirmDanger(target.ownerDocument, {
                title: '图片设置草稿未能保存',
                message: `${message}\n\n继续将丢弃当前条目未保存的图片改动；世界书不会被本次放弃改写。`,
                confirmLabel: '放弃草稿并继续',
            });
            if (!discard) {
                notices.show(message, 'warning');
                render();
                return;
            }
            try {
                await runtime.discardDraft();
                await task();
            }
            catch (retryError) {
                notices.show(errorMessage(retryError), 'warning');
            }
        }
        render();
    }

    props.setLeaveGuard?.(async () => {
        if (!runtime.state.dirty && runtime.state.saveStatus !== 'error') return true;
        if (await saveManually()) return true;
        return confirmDanger(target.ownerDocument, {
            title: '图片设置尚未保存',
            message: '当前条目的图片设置未能写入世界书，继续离开将丢弃未保存修改。',
            confirmLabel: '不保存，继续离开',
        });
    });

    function statusMeta(state) {
        const map = {
            idle: { text: '已同步', tone: 'saved' },
            unsaved: { text: '未保存 · 1 秒后自动保存', tone: 'unsaved' },
            saving: { text: '正在保存…', tone: 'saving' },
            saved_auto: { text: `已自动保存${state.lastSavedTime ? ` (${state.lastSavedTime})` : ''}`, tone: 'saved' },
            saved_manual: { text: `已保存${state.lastSavedTime ? ` (${state.lastSavedTime})` : ''}`, tone: 'saved' },
            error: { text: '保存失败 · 点击重试', tone: 'error' },
        };
        return map[state.saveStatus] ?? { text: '已同步', tone: 'saved' };
    }

    function updateStatus() {
        const state = runtime.state;
        const { text, tone } = statusMeta(state);
        for (const status of target.querySelectorAll('[data-status]')) {
            status.textContent = text;
            status.dataset.tone = tone;
        }
        const descCount = target.querySelector('[data-desc-count]');
        if (descCount && state.currentDraft) {
            const { binding } = readEntryImageBindingSafe(state.currentDraft);
            descCount.textContent = `${(binding?.description ?? '').length} 字符`;
        }
        const error = target.querySelector('[data-error]');
        if (error) {
            error.textContent = state.error ?? '';
            error.hidden = !state.error;
        }
    }

    function renderEntryCards(listContainer) {
        const state = runtime.state;
        const filtered = runtime.getFilteredEntries();
        if (!filtered.length) {
            listContainer.replaceChildren(h('div', { className: 'wii-empty-list' },
                h('p', { text: state.searchQuery || state.filter !== 'all' ? '没有匹配的条目。' : '当前世界书暂无条目。' }),
                (state.searchQuery || state.filter !== 'all')
                    ? actionButton('重置筛选条件', () => { runtime.setSearchQuery(''); runtime.setFilter('all'); }, { className: 'secondary' })
                    : null,
            ));
            return;
        }
        listContainer.replaceChildren(...filtered.map(item => {
            const selected = String(item.uid) === String(state.selectedUid);
            const badge = item.broken ? h('span', { className: 'wii-badge invalid', text: '结构异常' })
                : item.imageInvalid ? h('span', { className: 'wii-badge invalid', text: '图片异常' })
                : item.hasImage ? h('span', { className: 'wii-badge has-image', text: `${formatMimeShort(item.imageBinding?.mimeType)} · ${formatBytes(item.imageBinding?.sizeBytes)}` })
                : h('span', { className: 'wii-badge empty', text: '未绑图' });

            const metaTags = [];
            if (item.constant) metaTags.push(h('span', { className: 'wii-mini-tag constant', text: '常驻' }));
            if (item.disable) metaTags.push(h('span', { className: 'wii-mini-tag disabled', text: '已禁用' }));
            for (const key of (item.key ?? []).slice(0, 2)) metaTags.push(h('span', { className: 'wii-mini-tag', text: String(key) }));
            if ((item.key?.length ?? 0) > 2) metaTags.push(h('span', { className: 'wii-mini-tag', text: `+${item.key.length - 2}` }));
            const descSnippet = item.imageBinding?.description?.trim();

            return h('button', {
                type: 'button',
                className: `wii-card${selected ? ' active' : ''}${item.disable ? ' is-disabled' : ''}${item.broken ? ' is-broken' : ''}`,
                disabled: item.broken, dataset: { uid: String(item.uid) },
                attrs: selected ? { 'aria-current': 'true' } : {},
                on: { click: () => { url = ''; mobileSubView = 'edit'; void runNavigating(() => runtime.selectEntry(item.uid)); } },
            },
                h('div', { className: 'wii-card-head' },
                    h('div', { className: 'wii-card-title-wrap' },
                        h('span', { className: 'wii-card-uid', text: `#${item.uid}` }),
                        h('strong', { className: 'wii-card-title', text: item.comment || '未命名条目' }),
                    ),
                    badge,
                ),
                descSnippet ? h('p', { className: 'wii-card-desc', text: descSnippet }) : null,
                metaTags.length ? h('div', { className: 'wii-card-foot' }, metaTags) : null,
            );
        }));
    }

    function renderListPane(stats, busy) {
        const state = runtime.state;
        const cardList = h('div', { className: 'wii-card-list' });
        renderEntryCards(cardList);

        const searchInput = searchField({
            value: state.searchQuery, placeholder: '搜索标题、UID、触发词或描述…',
            ariaLabel: '搜索世界书条目', className: 'wii-search-input', dataset: { control: 'search' },
            onQuery: value => { runtime.setSearchQuery(value); renderEntryCards(cardList); clearBtn.hidden = !value; },
        });
        const clearBtn = actionButton('×', () => {
            searchInput.value = ''; runtime.setSearchQuery(''); renderEntryCards(cardList);
            clearBtn.hidden = true; searchInput.focus();
        }, { className: 'wii-search-clear', ariaLabel: '清空搜索', title: '清空搜索', attrs: { hidden: !state.searchQuery } });

        const filterDefs = [
            ['all', `全部 ${stats.total}`], ['image', `已绑图 ${stats.imageCount}`],
            ['unimaged', `未绑图 ${stats.unimagedCount}`], ['constant', `常驻 ${stats.constantCount}`],
            ...(stats.invalidCount > 0 ? [['invalid-image', `异常 ${stats.invalidCount}`]] : []),
        ];
        const filterBar = h('div', { className: 'wii-filter-chips' },
            filterDefs.map(([id, text]) => actionButton(text, () => runtime.setFilter(id), {
                className: `wii-chip${state.filter === id ? ' active' : ''}`, disabled: busy,
            })),
        );

        return {
            pane: h('aside', { className: `wii-list-pane${mobileSubView === 'edit' ? ' wii-mobile-hidden' : ''}` },
                h('div', { className: 'wii-list-header' },
                    h('div', { className: 'wii-search-box' },
                        h('span', { className: 'wii-search-icon', text: '🔍', attrs: { 'aria-hidden': 'true' } }),
                        searchInput, clearBtn,
                    ),
                    filterBar,
                ),
                cardList,
            ),
            cardList,
        };
    }

    function renderDetailPane(draft, busy) {
        const state = runtime.state;
        if (!draft) {
            return h('section', { className: `wii-detail-pane${mobileSubView === 'list' ? ' wii-mobile-hidden' : ''}` },
                h('div', { className: 'wii-empty-detail' },
                    h('p', { className: 'wii-empty-title', text: '请选择世界书和有效条目' }),
                    h('p', { className: 'wii-hint', text: '在左侧列表中点击任意条目，即可为其上传本地图片、导入网络图片或编写随图描述。' }),
                ),
            );
        }

        const { binding, invalid } = readEntryImageBindingSafe(draft);
        const fileInput = h('input', {
            type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
            disabled: busy, className: 'wie-image-file', attrs: control('file'),
        });
        fileInput.addEventListener('change', () => {
            const chosen = fileInput.files?.[0];
            if (chosen) void run(() => runtime.bindEntryImageFromFile(chosen));
        });
        const openFilePicker = () => { if (!busy) fileInput.click(); };

        const preview = h('div', {
            className: `wie-image-preview wii-dropzone${state.currentImagePreviewUrl ? ' has-preview' : ''}`,
            on: {
                dragover: event => { event.preventDefault(); if (!busy) preview.classList.add('is-dragover'); },
                dragleave: () => preview.classList.remove('is-dragover'),
                drop: event => {
                    event.preventDefault();
                    preview.classList.remove('is-dragover');
                    const dropped = !busy && event.dataTransfer?.files?.[0];
                    if (dropped) void run(() => runtime.bindEntryImageFromFile(dropped));
                },
            },
        }, fileInput);

        if (state.currentImagePreviewUrl) {
            preview.append(
                h('div', { className: 'wii-thumb-stage', on: { click: openFilePicker }, title: '点击更换本地图片' },
                    h('img', { className: 'wie-image-thumb', src: state.currentImagePreviewUrl, alt: `条目图片：${draft.comment || `#${state.selectedUid}`}` }),
                ),
                h('div', { className: 'wii-media-bar' },
                    h('span', { className: 'wii-media-meta', text: binding ? `${formatMimeShort(binding.mimeType)} · ${formatBytes(binding.sizeBytes)}` : '已绑定图片' }),
                    h('div', { className: 'wie-image-actions' },
                        actionButton('更换本地图片', openFilePicker, { className: 'secondary', disabled: busy }),
                        actionButton('移除图片', () => runtime.removeEntryImage(), { className: 'secondary wii-remove-btn', disabled: busy }),
                    ),
                ),
            );
        }
        else {
            preview.append(
                h('div', { className: `wii-dropzone-empty${state.currentImageError || invalid ? ' is-error' : ''}`, on: { click: openFilePicker } },
                    h('span', { className: 'wii-dropzone-icon', text: state.currentImageError || invalid ? '⚠️' : '🖼️', attrs: { 'aria-hidden': 'true' } }),
                    h('span', { className: 'wie-image-empty', text: state.currentImageError || '尚未绑定图片 · 点击选择或拖放图片到此处' }),
                    h('small', { className: 'wii-dropzone-sub', text: '支持 PNG / JPEG / WebP / GIF，也可直接按 Ctrl+V 粘贴剪贴板图片' }),
                ),
                h('div', { className: 'wie-image-actions wii-empty-actions' },
                    actionButton('选择本地图片', openFilePicker, { className: 'secondary', disabled: busy }),
                    invalid ? actionButton('清除异常绑定', () => runtime.removeEntryImage(), { className: 'danger-button', disabled: busy }) : null,
                ),
            );
        }

        const importUrl = () => void run(async () => { await runtime.bindEntryImageFromUrl(url); url = ''; });
        const urlInput = h('input', {
            type: 'url', value: url, placeholder: 'https://example.com/image.png', disabled: busy,
            attrs: { ...control('url'), 'aria-label': '图片 URL（导入为本地副本）' },
        });
        urlInput.addEventListener('input', () => { url = urlInput.value; });
        urlInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); importUrl(); } });

        const description = h('textarea', {
            value: binding?.description ?? '', disabled: busy || !binding, rows: 6,
            placeholder: binding ? '描述图片中的人物外貌、服饰、场景细节或需要模型注意的视觉特征…' : '请先在左侧绑定或导入图片，再填写随图描述…',
            attrs: { ...control('description'), 'aria-label': '图片描述（随图片发送给模型）' },
        });
        description.addEventListener('input', () => runtime.setImageDescription(description.value));

        const triggerSummary = draft.constant ? '常驻激活' : (draft.key ?? []).length ? `触发词：${draft.key.join('、')}` : '未设置触发词';
        const contextDetails = h('details', {
            className: 'wii-entry-context', open: contextOpen,
            on: { toggle: event => { contextOpen = event.currentTarget.open; } },
        },
            h('summary', {}, h('span', { text: `📄 参考条目设定原文（${(draft.content ?? '').length} 字符）` }), h('small', { text: triggerSummary })),
            h('pre', { className: 'wii-entry-pre', text: draft.content || '（该条目暂无设定正文）' }),
        );

        return h('section', { className: `wii-detail-pane${mobileSubView === 'list' ? ' wii-mobile-hidden' : ''}` },
            h('div', { className: 'wii-mobile-bar' },
                actionButton('‹ 返回列表', () => { mobileSubView = 'list'; render(); }, { className: 'secondary' }),
                h('strong', { className: 'wii-mobile-title', text: `#${draft.uid} ${draft.comment || '未命名条目'}` }),
            ),
            h('div', { className: 'wii-detail-header' },
                h('div', { className: 'wii-detail-heading' },
                    h('span', { className: 'wii-detail-uid', text: `#${draft.uid}` }),
                    h('h3', { className: 'wii-detail-title', text: draft.comment || '未命名条目' }),
                    draft.constant ? h('span', { className: 'wii-mini-tag constant', text: '常驻' }) : null,
                    draft.disable ? h('span', { className: 'wii-mini-tag disabled', text: '条目已禁用' }) : null,
                ),
                h('div', { className: 'wii-detail-actions' },
                    actionButton('放弃草稿', () => void run(async () => {
                        if (await confirmDanger(target.ownerDocument, {
                            title: '放弃图片设置草稿',
                            message: '将丢弃当前条目未保存的图片绑定和描述，退回磁盘内容；不会改写世界书。',
                            confirmLabel: '放弃草稿',
                        })) await runtime.discardDraft();
                    }), { className: 'secondary', disabled: busy || !state.dirty }),
                    actionButton('保存图片设置', () => void saveManually(), { className: 'primary', disabled: busy || !draft }),
                ),
            ),
            contextDetails,
            h('div', { className: 'wii-editor' },
                h('div', { className: 'wii-media-card' },
                    h('div', { className: 'wii-section-head' }, h('strong', { text: '图片资源' }), h('small', { text: binding ? '已保存为扩展本地资源' : '本地上传或 URL 导入' })),
                    preview,
                    h('div', { className: 'wii-url-box' },
                        h('span', { className: 'wii-field-label', text: '从网络 URL 导入为本地副本' }),
                        h('div', { className: 'wii-url-row' }, urlInput, actionButton('导入 URL', importUrl, { className: 'secondary', disabled: busy })),
                    ),
                ),
                h('div', { className: 'wii-desc-card' },
                    h('div', { className: 'wii-section-head' },
                        h('strong', { text: '图片描述（随图片发送给模型）' }),
                        h('small', { attrs: { 'data-desc-count': '' }, text: `${(binding?.description ?? '').length} 字符` }),
                    ),
                    !binding ? h('div', { className: 'wii-desc-callout', text: '请先在左侧上传本地图片或导入 URL，绑定图片后即可填写随图描述。' }) : null,
                    description,
                    h('p', { className: 'wii-hint', text: '描述独立保存在条目扩展字段中，不改写条目设定正文；替换图片保留已有描述，移除图片将同时清除描述。' }),
                ),
            ),
        );
    }

    function render() {
        if (disposed) return;
        const prevList = target.querySelector('.wii-card-list');
        if (prevList) listScrollTop = prevList.scrollTop;

        const focus = captureFocus(target);
        const state = runtime.state;
        const busy = state.imageBusy || state.saveStatus === 'saving';
        const draft = state.currentDraft;
        renderedUid = state.selectedUid;
        renderedWorld = state.selectedWorld;

        const root = h('div', { className: 'wii-page' });
        const toggle = h('input', { type: 'checkbox', checked: enabled });
        toggle.addEventListener('change', () => void run(async () => { await props.setEnabled(toggle.checked); enabled = toggle.checked; }));

        root.append(h('header', { className: 'feature-header' },
            h('div', {}, h('p', { className: 'eyebrow', text: '世界书' }), h('h2', { text: '插入图片' }),
                h('p', { text: '为条目绑定图片及独立描述；随条目激活发送，无需启用世界书管理。' })),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: enabled ? '已启用' : '未启用' })),
        ));

        const banner = noticeBanner(notices.current, () => notices.clear(true));
        if (banner) root.append(banner);
        if (!enabled) root.append(callout('功能未启用，生成时不会附图。已有绑定保持不变，仍可在此预先配置。', 'warning'));
        root.append(h('div', { className: 'callout danger wii-error-banner', hidden: !state.error, attrs: { 'data-error': '', role: 'alert' }, text: state.error ?? '' }));

        const worlds = h('select', { className: 'wii-world-select', disabled: busy, attrs: { ...control('world'), 'aria-label': '选择世界书' } });
        if (!state.worldNames.length) worlds.append(h('option', { text: '暂无世界书', value: '' }));
        for (const name of state.worldNames) {
            const activeBinding = state.activeBindings?.find(b => b.name === name);
            const prefix = activeBinding ? `[${SOURCE_LABELS[activeBinding.source] ?? activeBinding.source}] ` : '';
            worlds.append(h('option', { value: name, text: `${prefix}${name}`, selected: name === state.selectedWorld }));
        }
        worlds.addEventListener('change', () => { url = ''; mobileSubView = 'list'; void runNavigating(() => runtime.selectWorld(worlds.value)); });

        const stats = computeBookStats(runtime.entrySummaries());
        const statusInfo = statusMeta(state);
        const statusPill = h('button', {
            type: 'button', className: 'wii-status-pill', dataset: { tone: statusInfo.tone },
            attrs: { 'data-status': '', role: 'status', title: '点击立即保存当前修改' }, text: statusInfo.text,
            on: { click: () => { if (state.dirty || state.saveStatus === 'error') void saveManually(); } },
        });

        root.append(h('div', { className: 'wii-top-bar' },
            h('div', { className: 'wii-book-group' },
                worlds,
                h('div', { className: 'wii-book-stats' },
                    h('span', {}, '共 ', h('b', { text: String(stats.total) }), ' 条目'),
                    h('span', { text: '·' }),
                    h('span', {}, h('b', { text: String(stats.imageCount) }), ' 已绑图'),
                    stats.totalBytes > 0 ? h('span', { text: `(${formatBytes(stats.totalBytes)})` }) : null,
                ),
            ),
            h('div', { className: 'wii-top-actions' },
                statusPill,
                actionButton('重读世界书', () => void run(async () => {
                    const result = await runtime.refreshWorlds({ keepDraft: true });
                    notices.show(result.draftKept ? '已重读，草稿仍保留；请核对后再保存。' : '已重读世界书。', 'info');
                }), { className: 'secondary', disabled: busy }),
            ),
        ));

        const { pane: listPane, cardList } = renderListPane(stats, busy);
        root.append(h('div', { className: 'wii-split-view' }, listPane, renderDetailPane(draft, busy)));
        target.replaceChildren(root);
        if (listScrollTop > 0) requestAnimationFrame(() => { cardList.scrollTop = listScrollTop; });
        updateStatus();
        restoreFocus(target, focus);
    }

    function onPaste(event) {
        if (disposed || !runtime.state.currentDraft || runtime.state.imageBusy) return;
        const image = [...(event.clipboardData?.files ?? [])].find(file => file.type?.startsWith('image/'));
        if (!image) return;
        event.preventDefault();
        void run(() => runtime.bindEntryImageFromFile(image));
    }

    target.addEventListener('paste', onPaste);
    const unsubscribe = runtime.subscribe(() => {
        const active = target.ownerDocument.activeElement;
        if ((active?.dataset?.control === 'description' || active?.dataset?.control === 'search')
            && target.contains(active) && renderedUid === runtime.state.selectedUid && renderedWorld === runtime.state.selectedWorld) {
            updateStatus();
            const list = target.querySelector('.wii-card-list');
            if (list) renderEntryCards(list);
        }
        else render();
    });

    render();
    void run(() => runtime.init());
    return () => {
        disposed = true;
        target.removeEventListener('paste', onPaste);
        target.classList.remove('wii-host');
        unsubscribe();
        notices.dispose();
        void runtime.flush().catch(() => {});
    };
}
