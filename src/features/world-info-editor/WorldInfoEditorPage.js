import { actionButton, callout, h } from '../../ui/dom.js';
import { errorMessage } from '../../kernel/errors.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { confirmDanger } from '../../ui/confirm.js';
import { scrollIntoViewAboveKeyboard } from '../../ui/keyboard.js';
import { estimateTokens } from './schema.js';
import { createDetailForm } from './detail-form.js';
import { createDetailView } from './detail-view.js';
import { createEntryCards } from './entry-cards.js';
import { createTagEditor } from './tag-editor.js';
import { createActionRunner } from '../../ui/run-action.js';

const SOURCE_LABELS = {
    chat: '当前聊天',
    character: '当前角色',
    global: '全局常驻',
    persona: '用户设定',
};

export function mountWorldInfoEditorPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        mobileSubView: 'list', // 'list' | 'edit'
        mobileTab: 'basic',
        zenMode: false,
        accordionOpen: false,
        listScrollTop: 0,
        formUid: null,
        formRevision: -1,
    };
    // 触发词编辑器持有自己的输入框与列表容器，使增删词条时无需全量重绘、不中断输入法。
    const tagRefs = { primary: null, secondary: null };
    // 焦点变化时只保留最新一次滚动避让，避免多个定时器争抢滚动位置。
    let cancelScroll = null;
    const scheduleScroll = (element, options) => {
        cancelScroll?.();
        cancelScroll = scrollIntoViewAboveKeyboard(element, options);
    };

    let disposed = false;
    let noticeSlot;
    let settingsFeedback = [];
    const notices = createNoticeController(syncNotice);

    function syncNotice() {
        if (disposed || !noticeSlot) return;
        const banner = noticeBanner(notices.current, () => notices.clear(true));
        noticeSlot.replaceChildren(...(banner ? [banner] : []));
        noticeSlot.hidden = !banner;
    }

    // 正在编辑的文本控件不得被重绘替换：移动端会因此关上键盘并丢失光标位置。
    function isTyping() {
        const active = target.ownerDocument.activeElement;
        return Boolean(active && target.contains(active) && active.matches('input:not([type=checkbox]):not([type=radio]), textarea, select'));
    }

    function renderAfterAction() {
        if (disposed) return;
        const { selectedWorld, selectedUid, settings, settingsError } = runtime.state;
        // 书、条目或启用状态真正改变时需要重建；同一编辑区的异步反馈不替换控件。
        if (!view.enabled || selectedWorld !== view.formWorld || selectedUid !== view.formUid || !isTyping()) {
            render();
            return;
        }
        syncLiveStatus();
        syncNotice();
        target.querySelector('.master-toggle input').checked = view.enabled;
        target.querySelector('.wie-save-option input').checked = settings.convertUserMacro;
        if (!settingsError) settingsFeedback.forEach(node => node.remove());
    }

    const run = createActionRunner({ notices, render: renderAfterAction });

    // 保存不上时导航会被 runtime 拦下；给出一次明确的“放弃草稿并继续”，
    // 避免一个写不进去的草稿把整个页面锁死。世界书本身不会被本次放弃改写。
    const runNavigating = async task => {
        notices.clear();
        try {
            await task();
        }
        catch (error) {
            const message = errorMessage(error);
            const discard = runtime.state.dirty && await confirmDanger(target.ownerDocument, {
                title: '草稿未能保存',
                message: `${message}\n\n继续会丢弃这条未保存的草稿；世界书不会被本次操作改写。`,
                confirmLabel: '放弃草稿并继续',
            });
            if (!discard) {
                notices.show(message, 'danger');
                render();
                return;
            }
            try {
                await runtime.discardDraft();
                await task();
            }
            catch (retryError) {
                notices.show(errorMessage(retryError), 'danger');
            }
        }
        render();
    };

    target.classList.add('wie-host');
    // 条目是自动保存的：离开前先尝试把草稿落盘，只有写不进去时才让用户决定是否放弃。
    props.setLeaveGuard?.(async () => {
        if (!runtime.state.dirty && runtime.state.saveStatus !== 'error')
            return true;
        if (await saveManually())
            return true;
        return confirmDanger(target.ownerDocument, {
            title: '草稿未能保存',
            message: '这条草稿没有写入世界书，继续离开不会保存它。世界书不会被本次离开改动。',
            confirmLabel: '不保存，继续离开',
        });
    });
    const unsubscribe = runtime.subscribe(() => {
        if (disposed) return;
        if (isTyping()) {
            syncLiveStatus();
            return;
        }
        render();
    });

    const renderTagEditor = createTagEditor({ runtime, tagRefs, scheduleScroll });
    const { renderCards } = createEntryCards({ runtime, view, target, runNavigating });
    const { renderDetailHeader, renderZenOverlay, syncMobileSaveChip } = createDetailView({
        runtime, view, target, render: () => render(), runNavigating, saveManually: () => saveManually(),
    });
    const renderDetailForm = createDetailForm({
        runtime, view, render: () => render(), saveManually: () => saveManually(), scheduleScroll, renderTagEditor, run,
    });

    function syncLiveStatus() {
        const { saveStatus, lastSavedTime, currentDraft, error } = runtime.state;
        const status = target.querySelector('.wie-status-indicator');
        const manualLabel = `已保存 (${lastSavedTime ?? '刚刚'})${runtime.state.lastConversionCount > 0 ? ` · 已转换 ${runtime.state.lastConversionCount} 处 user` : ''}`;
        const labels = {
            unsaved: '未保存修改', saving: '正在保存...',
            saved_auto: `已自动保存 (${lastSavedTime ?? '刚刚'})`,
            saved_manual: manualLabel, error: '保存失败',
        };
        const statusClass = saveStatus === 'error' ? 'error' : saveStatus === 'unsaved' ? 'unsaved' : saveStatus === 'saving' ? 'saving' : 'saved';
        if (status) {
            status.className = `wie-status-indicator ${statusClass}${statusClass === 'unsaved' || statusClass === 'error' ? ' wie-status-action' : ''}`;
            const label = status.lastElementChild;
            if (label) label.textContent = labels[saveStatus] ?? '已同步';
            status.title = statusClass === 'unsaved' || statusClass === 'error'
                ? '点击立即保存'
                : '自动保存不会改写正文；手动保存按设置转换 user 宏。';
        }
        const heading = target.querySelector('.wie-detail-name');
        if (heading && currentDraft) heading.textContent = currentDraft.comment || '(未命名条目)';
        const counter = target.querySelector('.wie-editor-count');
        if (counter && currentDraft) counter.textContent = `字数: ${currentDraft.content.length} · 预估 Token: ${estimateTokens(currentDraft.content)}`;
        const warning = target.querySelector('.wie-error-bar');
        if (warning) warning.classList.toggle('hidden', !error);
        const warningText = warning?.querySelector('span');
        if (warningText) warningText.textContent = error ?? '';
        // 其它入口（还原、切换条目）改动草稿后让触发词编辑器重新对齐权威草稿；
        // 用户在触发词框内输入时不触碰 DOM，避免移动端键盘闪断。
        if (currentDraft && (runtime.state.selectedUid !== view.formUid || runtime.revision !== view.formRevision)) {
            view.formRevision = runtime.revision;
            reseedTagEditors(currentDraft);
        }
    }

    // 按当前草稿重新渲染两个触发词编辑器，并同步它们内部的 revision 记账。
    function reseedTagEditors(draft) {
        for (const [slot, tags] of [['primary', draft?.key], ['secondary', draft?.keysecondary]]) {
            const editor = tagRefs[slot];
            if (!editor?.refresh)
                continue;
            editor.refresh(tags ?? [], runtime.revision);
        }
    }

    // 页面初始化加载
    void run(async () => {
        await runtime.init();
    });

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
                h('p', { className: 'eyebrow', text: '世界书' }),
                h('h2', { text: '世界书管理' }),
                h('p', { text: '查看、检索并编辑世界书条目设定，支持主次关键词与双轨自动保存。' }),
            ),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '已启用' : '未启用' })),
        ));

        noticeSlot = h('div');
        syncNotice();
        root.append(noticeSlot);

        if (!view.enabled) {
            root.append(callout('功能尚未启用。启用后可实时查看并修改世界书条目，自动同步宿主缓存。', 'warning'));
        }
        if (runtime.state.error) {
            root.append(callout(runtime.state.error, 'danger'));
        }
        settingsFeedback = runtime.state.settingsError ? [
            callout(runtime.state.settingsError, 'warning'),
            actionButton('重置世界书管理设置', () => {
                void run(async () => {
                    await runtime.resetSettings();
                    notices.show('世界书管理设置已重置。', 'success');
                });
            }, { className: 'secondary' }),
        ] : [];
        root.append(...settingsFeedback);
    }

    function renderTopBar() {
        const state = runtime.state;
        const select = h('select', { className: 'wie-select', attrs: { 'aria-label': '选择世界书' } });

        for (const name of state.worldNames) {
            const binding = state.activeBindings.find(b => b.name === name);
            const prefix = binding ? `[${SOURCE_LABELS[binding.source] ?? binding.source}] ` : '';
            select.append(h('option', { value: name, text: `${prefix}${name}`, selected: name === state.selectedWorld }));
        }

        select.addEventListener('change', () => {
            void runNavigating(async () => {
                await runtime.selectWorld(select.value);
            });
        });

        const stats = runtime.getStats();
        const statsEl = h('div', { className: 'wie-global-stats' },
            h('span', {}, '共 ', h('b', { text: String(stats.total) }), ' 条目'),
            h('span', { text: '·' }),
            h('span', {}, h('b', { text: String(stats.constant) }), ' 常驻'),
            h('span', { text: '·' }),
            h('span', {}, h('b', { text: String(stats.imageCount) }), ' 图片'),
            h('span', { text: '·' }),
            h('span', {}, '预估 ', h('b', { text: String(stats.totalTokens) }), ' Token'),
        );

        const newBtn = actionButton('＋ 新建条目', () => {
            void runNavigating(async () => {
                await runtime.createEntry();
                view.mobileSubView = 'edit';
            });
        }, { className: 'primary' });

        const refreshBtn = actionButton('刷新', () => {
            void runNavigating(async () => {
                await runtime.refreshWorlds();
            });
        }, { className: 'secondary' });

        const convertToggle = h('input', { type: 'checkbox', checked: state.settings.convertUserMacro });
        convertToggle.addEventListener('change', () => {
            void run(async () => {
                await runtime.setConvertUserMacro(convertToggle.checked);
            });
        });
        const convertOption = h('label', {
            className: 'wie-save-option',
            attrs: { title: '手动保存时把条目中独立成词的 user 替换为 {{user}}；自动保存与切换条目不改写正文。' },
        }, convertToggle, h('span', { text: '保存时转 user 宏' }));

        return h('div', { className: 'wie-top-bar' },
            h('div', { className: 'wie-book-selector-group' }, select, statsEl),
            h('div', { className: 'wie-top-actions' }, convertOption, newBtn, refreshBtn),
        );
    }

    function renderSearchAndFilter() {
        const state = runtime.state;
        const searchInput = h('input', {
            type: 'text',
            value: state.searchQuery,
            placeholder: '搜索标题、关键词或正文…',
            attrs: { 'aria-label': '搜索世界书条目' },
        });
        searchInput.addEventListener('input', () => {
            runtime.setSearchQuery(searchInput.value);
            const list = target.querySelector('.wie-card-list');
            if (list) renderCards(list);
            updateClear();
        });

        const clearBtn = h('button', {
            type: 'button',
            className: 'wie-search-clear',
            text: '×',
            attrs: { 'aria-label': '清空搜索', title: '清空搜索' },
        });
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            runtime.setSearchQuery('');
            const list = target.querySelector('.wie-card-list');
            if (list) renderCards(list);
            updateClear();
            searchInput.focus();
        });
        const updateClear = () => clearBtn.toggleAttribute('hidden', !searchInput.value);
        updateClear();

        const chips = [
            ['all', '全部'],
            ['constant', '常驻'],
            ['active', '已启用'],
            ['disabled', '已禁用'],
            ['depth', '@深度'],
            ['image', '含图片'],
        ].map(([key, label]) => actionButton(label, () => {
            runtime.setFilter(key);
        }, { className: `wie-chip${state.filter === key ? ' active' : ''}` }));

        return h('div', { className: 'wie-list-header' },
            h('div', { className: 'wie-search-box' },
                h('span', { className: 'wie-search-icon', text: '🔍', attrs: { 'aria-hidden': 'true' } }),
                searchInput,
                clearBtn,
            ),
            h('div', { className: 'wie-filter-chips' }, chips),
        );
    }

    // 手机输入法没有稳定的失焦时机：返回列表前先把未保存草稿落盘，避免静默丢失。
    async function closeDetailView() {
        if (runtime.state.dirty || runtime.state.saveStatus === 'error') {
            const saved = await saveManually();
            if (!saved) {
                const discard = await confirmDanger(target.ownerDocument, {
                    title: '草稿未能保存',
                    message: '继续返回列表会丢弃这条未保存的草稿；世界书不会被本次操作改写。',
                    confirmLabel: '放弃草稿并返回',
                });
                if (!discard)
                    return;
                try {
                    await runtime.discardDraft();
                }
                catch (error) {
                    notices.show(errorMessage(error), 'danger');
                    render();
                    return;
                }
            }
        }
        view.mobileSubView = 'list';
        render();
    }

    async function saveManually() {
        try {
            const written = await runtime.saveCurrentDraft({ isAuto: false });
            // 没有改动时也给一次明确反馈，避免保存按钮看起来没反应。
            if (!written) {
                notices.show('没有需要保存的修改。', 'info');
                syncNotice();
            }
            return true;
        }
        catch (error) {
            // 错误保留在 runtime.state，由顶部提示与状态区持续展示，不阻断查看列表。
            notices.show(errorMessage(error), 'danger');
            renderAfterAction();
            return false;
        }
    }

    // 保存失败时给出可执行的下一步：重试写入，或重新读取世界书对齐宿主状态。
    function renderErrorBar() {
        const state = runtime.state;
        const bar = h('div', { className: `wie-error-bar${state.error ? '' : ' hidden'}`, attrs: { role: 'alert' } }, h('span', { text: state.error ?? '' }));
        if (state.error) {
            bar.append(actionButton('重试保存', () => { void saveManually(); }, { className: 'secondary' }));
            bar.append(actionButton('重读世界书', () => {
                void run(async () => {
                    // 重读只对齐磁盘事实源：不写入、也不丢弃未保存的草稿。
                    const result = await runtime.refreshWorlds({ keepDraft: true });
                    notices.show(result?.draftKept
                        ? '已重新读取世界书，草稿保留但尚未写入。'
                        : '已重新读取世界书；原条目已不存在，草稿已丢弃。', result?.draftKept ? 'success' : 'warning');
                });
            }, { className: 'secondary' }));
        }
        return bar;
    }

    function render() {
        if (disposed)
            return;

        // 重绘前记住列表滚动位置：从详情返回长列表时不应回到顶部。
        const previousList = target.querySelector('.wie-card-list');
        if (previousList)
            view.listScrollTop = previousList.scrollTop;

        target.replaceChildren();
        const root = h('div', { className: `wie-root${view.mobileSubView === 'edit' ? ' wie-edit-view' : ''}` });
        renderHeader(root);
        root.append(renderErrorBar());

        if (!view.enabled) {
            target.append(root);
            return;
        }

        root.append(renderTopBar());

        // 双栏/移动端布局容器
        const splitView = h('div', { className: 'wie-split-view' });

        // 左侧列表区
        const listPane = h('aside', { className: 'wie-list-pane' });
        listPane.append(renderSearchAndFilter());

        const cardList = h('div', { className: 'wie-card-list' });
        renderCards(cardList);
        listPane.append(cardList);
        // fixed 定位的工作台里，滚动位置只能靠显式恢复。
        const restoreScroll = view.listScrollTop;
        if (restoreScroll > 0)
            requestAnimationFrame(() => { cardList.scrollTop = restoreScroll; });

        // 右侧详情区
        const detailPane = h('main', { className: 'wie-detail-pane' });
        const draft = runtime.state.currentDraft;
        view.formWorld = runtime.state.selectedWorld;
        view.formUid = runtime.state.selectedUid;

        if (draft) {
            view.formRevision = runtime.revision;
            // 窄容器返回栏
            const mobileBackBar = h('div', { className: 'wie-mobile-view-header' },
                actionButton('‹ 返回列表', () => {
                    closeDetailView();
                }, { className: 'secondary' }),
                h('strong', { style: 'font-size: 13px;', text: `#${draft.uid} ${draft.comment || ''}` }),
                h('button', {
                    type: 'button',
                    className: 'wie-mobile-save',
                    on: { click: () => { void saveManually(); } },
                }, h('span', { className: 'wie-mobile-save-label', text: '已同步' })),
            );

            detailPane.append(mobileBackBar);
            detailPane.append(renderDetailHeader(draft));
            const tabs = h('nav', { className: 'wie-mobile-tabs', attrs: { 'aria-label': '条目编辑部分' } },
                ...[['basic', '基本内容'], ['timing', '注入时机'], ['advanced', '高级规则']].map(([id, label]) =>
                    actionButton(label, () => { view.mobileTab = id; render(); }, {
                        className: `wie-mobile-tab-btn${view.mobileTab === id ? ' active' : ''}`,
                    })));
            detailPane.append(tabs, renderDetailForm(draft));
        }
        else {
            detailPane.append(h('div', { className: 'wie-empty-hint', text: '暂无选中条目，请在左侧选择或点击上方新建条目。' }));
        }

        // 移动端视图切换状态 (通过 CSS 类或显示隐藏控制)
        if (view.mobileSubView === 'list')
            detailPane.classList.add('wie-mobile-hidden');
        else
            listPane.classList.add('wie-mobile-hidden');

        splitView.append(listPane, detailPane);
        root.append(splitView);

        // 全屏 Zen 写作模式浮层
        if (view.zenMode && draft) {
            root.append(renderZenOverlay(draft, scheduleScroll));
        }

        target.append(root);
        // 窄容器顶部栏的保存状态与详情头部同源，首次渲染后同步一次。
        syncMobileSaveChip();
    }
    render();

    return () => {
        disposed = true;
        notices.dispose();
        unsubscribe();
        target.classList.remove('wie-host');
        void runtime.flush().catch(() => {}); // Retain failed draft for next mount.
    };
}
