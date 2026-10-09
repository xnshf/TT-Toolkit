import { actionButton, callout, h } from '../../ui/dom.js';
import { errorMessage } from '../../kernel/errors.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { confirmDanger } from '../../ui/confirm.js';
import { scrollIntoViewAboveKeyboard } from '../../ui/keyboard.js';
import {
    estimateTokens,
    isRegexKey,
    POSITION_OPTIONS,
    ROLE_OPTIONS,
    SELECTIVE_LOGIC_OPTIONS,
} from './schema.js';

const SOURCE_LABELS = {
    chat: '当前聊天',
    character: '当前角色',
    global: '全局常驻',
    persona: '用户设定',
};

// 成对宏在存在选区时包裹选区，其余宏在选区末尾续写，避免直接冲掉已选内容。
const PAIRED_MACROS = new Map([
    ['[[', ['[[', ']]']],
    ['*动作*', ['*', '*']],
    ['"对话"', ['"', '"']],
]);
const EDITOR_MACROS = ['{{char}}', '{{user}}', '[[', ']]', '*动作*', '"对话"'];

// 把宏按钮渲染成一行；点按时有选区则包裹选区，无选区则插入到光标处。
function renderMacroBar(textarea, apply) {
    const bar = h('div', { className: 'wie-macro-bar' });
    for (const macro of EDITOR_MACROS) {
        const key = h('button', { type: 'button', className: 'wie-macro-key', text: macro });
        key.addEventListener('click', () => {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const selected = textarea.value.slice(start, end);
            const pair = PAIRED_MACROS.get(macro);
            const insert = pair && selected ? `${pair[0]}${selected}${pair[1]}` : macro;
            const next = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(end)}`;
            // 包裹后仍选中原文本，方便连续套用多个宏；否则光标落在插入内容之后。
            const caret = start + (pair && selected ? pair[0].length : insert.length);
            const selectEnd = pair && selected ? caret + selected.length : caret;
            apply(next, { start: caret, end: selectEnd });
        });
        bar.append(key);
    }
    return bar;
}

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
    const notices = createNoticeController(() => render());

    // 正在编辑的文本控件不得被重绘替换：移动端会因此关上键盘并丢失光标位置。
    function isTyping() {
        const active = target.ownerDocument.activeElement;
        return Boolean(active && target.contains(active) && active.matches('input:not([type=checkbox]):not([type=radio]), textarea, select'));
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

    target.classList.add('wie-host');
    const unsubscribe = runtime.subscribe(() => {
        if (disposed) return;
        if (isTyping()) {
            syncLiveStatus();
            return;
        }
        render();
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
            view.formUid = runtime.state.selectedUid;
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

        const notice = noticeBanner(notices.current, () => notices.clear(true));
        if (notice)
            root.append(notice);

        if (!view.enabled) {
            root.append(callout('功能尚未启用。启用后可实时查看并修改世界书条目，自动同步宿主缓存。', 'warning'));
        }
        if (runtime.state.error) {
            root.append(callout(runtime.state.error, 'danger'));
        }
        if (runtime.state.settingsError) {
            root.append(callout(runtime.state.settingsError, 'warning'));
            root.append(actionButton('重置世界书管理设置', () => {
                void run(async () => {
                    await runtime.resetSettings();
                    notices.show('世界书管理设置已重置。', 'success');
                });
            }, { className: 'secondary' }));
        }
    }

    function renderTopBar() {
        const state = runtime.state;
        const select = h('select', { className: 'wie-select' });

        for (const name of state.worldNames) {
            const binding = state.activeBindings.find(b => b.name === name);
            const prefix = binding ? `[${SOURCE_LABELS[binding.source] ?? binding.source}] ` : '';
            select.append(h('option', { value: name, text: `${prefix}${name}`, selected: name === state.selectedWorld }));
        }

        select.addEventListener('change', () => {
            void run(async () => {
                await runtime.selectWorld(select.value);
            });
        });

        const stats = runtime.getStats();
        const statsEl = h('div', { className: 'wie-global-stats' },
            h('span', {}, '共 ', h('b', { text: String(stats.total) }), ' 条目'),
            h('span', { text: '·' }),
            h('span', {}, h('b', { text: String(stats.constant) }), ' 常驻'),
            h('span', { text: '·' }),
            h('span', {}, '预估 ', h('b', { text: String(stats.totalTokens) }), ' Token'),
        );

        const newBtn = actionButton('＋ 新建条目', () => {
            void run(async () => {
                await runtime.createEntry();
                view.mobileSubView = 'edit';
            });
        }, { className: 'primary' });

        const refreshBtn = actionButton('刷新', () => {
            void run(async () => {
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
            placeholder: '搜索标题、关键词或正文...',
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
        ].map(([key, label]) => actionButton(label, () => {
            runtime.setFilter(key);
        }, { className: `wie-chip${state.filter === key ? ' active' : ''}` }));

        return h('div', { className: 'wie-list-header' },
            h('div', { className: 'wie-search-box' },
                h('span', { className: 'wie-search-icon', text: '🔍' }),
                searchInput,
                clearBtn,
            ),
            h('div', { className: 'wie-filter-chips' }, chips),
        );
    }

    function renderCards(list) {
        const entries = runtime.getFilteredEntries();
        list.replaceChildren(...(entries.length
            ? entries.map(renderEntryCard)
            : [h('div', { className: 'wie-empty-hint', text: '未找到匹配的条目。' })]));
    }

    function renderEntryCard(entry) {
        const state = runtime.state;
        const isSelected = state.selectedUid === entry.uid;
        const isDisabled = entry.disable;

        const card = h('article', {
            className: `wie-card${isSelected ? ' active' : ''}${isDisabled ? ' disabled' : ''}`,
            dataset: { uid: String(entry.uid) },
        });

        // 迷你内联开关
        const switchInput = h('input', { type: 'checkbox', checked: !isDisabled });
        switchInput.addEventListener('change', event => {
            event.stopPropagation();
            void run(async () => {
                await runtime.toggleEntryActive(entry.uid, switchInput.checked);
            });
        });
        const miniSwitch = h('label', { className: 'wie-mini-switch' },
            switchInput,
            h('span', { className: 'wie-mini-slider' }),
        );
        miniSwitch.addEventListener('click', e => e.stopPropagation());

        const head = h('div', { className: 'wie-card-head' },
            h('div', { className: 'wie-card-title-group' },
                h('span', { className: 'wie-card-uid', text: `#${entry.uid}` }),
                h('strong', { className: 'wie-card-title', text: entry.comment || '(未命名条目)' }),
            ),
            miniSwitch,
        );

        // 关键词预览
        const keysContainer = h('div', { className: 'wie-card-keys' });
        const primaryPreview = (entry.key || []).slice(0, 3);
        for (const k of primaryPreview) {
            keysContainer.append(h('span', { className: 'wie-tag', text: String(k) }));
        }
        if (entry.key && entry.key.length > 3) {
            keysContainer.append(h('span', { className: 'wie-tag', text: `+${entry.key.length - 3}` }));
        }
        if (entry.selective && entry.keysecondary && entry.keysecondary.length > 0) {
            keysContainer.append(h('span', { className: 'wie-tag secondary', text: `& ${entry.keysecondary[0]}` }));
        }

        // 底部徽章
        const badges = h('div', { className: 'wie-badges' });
        if (entry.constant) {
            badges.append(h('span', { className: 'wie-badge wie-badge-constant', text: '常驻' }));
        }
        if (entry.position === 4) {
            badges.append(h('span', { className: 'wie-badge wie-badge-depth', text: `@D ${entry.depth ?? 4}` }));
        }
        else {
            const posOption = POSITION_OPTIONS.find(p => p.value === entry.position);
            badges.append(h('span', { className: 'wie-badge wie-badge-pos', text: posOption?.label?.split(' ')[0] ?? '位置' }));
        }
        if (isDisabled) {
            badges.append(h('span', { className: 'wie-badge wie-badge-disabled', text: '禁用' }));
        }

        const foot = h('div', { className: 'wie-card-foot' },
            badges,
            h('span', { text: `~${estimateTokens(entry.content)} T` }),
        );

        card.append(head, keysContainer, foot);
        card.addEventListener('click', () => {
            void run(async () => {
                await runtime.selectEntry(entry.uid);
                view.mobileSubView = 'edit';
            });
        });

        return card;
    }

    // 触发词编辑器：输入框常驻，仅在增删词条时重建词条块本身。
    function renderTagEditor(slot, tags, mutate, revision, isSecondary = false) {
        const box = h('div', { className: 'wie-tag-box' });
        const tagList = h('div', { className: 'wie-tag-list' });
        const input = h('input', {
            type: 'text',
            className: 'wie-tag-input',
            placeholder: tags.length === 0 ? '键入词按回车或逗号添加...' : '+ 添加...',
        });
        const ref = { refresh: null };

        function commit(value) {
            const val = value.trim().replace(/^,+|[,，]+$/g, '');
            if (!val)
                return false;
            const next = [...ref.tags, val];
            mutate(next);
            // 在重建前对齐 revision：本次变更不是“外部改动”，无需重新播种。
            ref.revision = runtime.revision;
            ref.tags = next;
            ref.render();
            return true;
        }

        // 在标签之外处理刷新：输入框不重建，移动端键盘不会闪退。
        ref.refresh = (nextTags, nextRevision) => {
            ref.revision = nextRevision;
            if (JSON.stringify(nextTags ?? []) === JSON.stringify(ref.tags)) {
                ref.render();
                return;
            }
            ref.tags = [...(nextTags ?? [])];
            ref.render();
        };

        ref.render = () => {
            input.placeholder = ref.tags.length === 0 ? '键入词按回车或逗号添加...' : '+ 添加...';
            tagList.replaceChildren(...ref.tags.map((tag, idx) => {
                const isReg = isRegexKey(tag);
                const tagEl = h('span', { className: `wie-tag${isSecondary ? ' secondary' : ''}${isReg ? ' regex' : ''}` },
                    h('span', { text: tag }),
                    isReg ? h('span', { className: 'wie-tag-regex-badge', text: 'REG' }) : null,
                );
                const removeBtn = h('button', {
                    type: 'button',
                    className: 'wie-tag-remove',
                    text: '×',
                    attrs: { 'aria-label': `删除触发词 ${tag}` },
                });
                removeBtn.addEventListener('click', event => {
                    event.stopPropagation();
                    const next = [...ref.tags];
                    next.splice(idx, 1);
                    mutate(next);
                    ref.revision = runtime.revision;
                    ref.tags = next;
                    ref.render();
                });
                tagEl.append(removeBtn);
                return tagEl;
            }));
        };

        input.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === ',' && input.value.startsWith('/') && !isRegexKey(input.value)) return;
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                event.preventDefault();
                if (commit(input.value))
                    input.value = '';
            }
        });

        // 没有键盘上的逗号/回车可用时（手机输入法），失焦即成块，避免输入被静默丢弃。
        input.addEventListener('blur', () => {
            if (!input.value.trim())
                return;
            if (commit(input.value))
                input.value = '';
        });

        input.addEventListener('focus', () => {
            scheduleScroll(input);
        });

        box.append(tagList, input);
        ref.tags = [...(tags ?? [])];
        ref.revision = revision;
        ref.render();
        tagRefs[slot] = ref;
        return box;
    }

    // 窄容器下详情头部被隐藏，把保存状态镜像到吸顶栏，保证手机上也能看到并发起保存。
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

        let statusText = '已同步';
        let statusClass = 'saved';
        if (state.saveStatus === 'unsaved') {
            statusText = '未保存修改';
            statusClass = 'unsaved';
        }
        else if (state.saveStatus === 'saving') {
            statusText = '正在保存...';
            statusClass = 'saving';
        }
        else if (state.saveStatus === 'saved_auto') {
            statusText = `已自动保存 (${state.lastSavedTime || '刚刚'})`;
            statusClass = 'saved';
        }
        else if (state.saveStatus === 'saved_manual') {
            statusText = `已保存 (${state.lastSavedTime || '刚刚'})${state.lastConversionCount > 0 ? ` · 已转换 ${state.lastConversionCount} 处 user` : ''}`;
            statusClass = 'saved';
        }
        else if (state.saveStatus === 'error') {
            statusText = '保存失败';
            statusClass = 'error';
        }

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
            void run(async () => {
                await runtime.duplicateEntry(draft.uid);
            });
        }, { className: 'secondary' });

        const deleteBtn = actionButton('🗑️ 删除', () => {
            void run(async () => {
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

    function renderDetailForm(draft) {
        const form = h('div', { className: 'wie-form-body' });

        // 模块 1: 核心触发设定
        const commentInput = h('input', {
            type: 'text',
            className: 'wie-input-text',
            value: draft.comment,
            placeholder: '用于辨识条目的注释标题',
        });
        commentInput.addEventListener('input', () => {
            runtime.updateDraftField('comment', commentInput.value);
        });

        const activeChk = h('input', { type: 'checkbox', checked: !draft.disable });
        activeChk.addEventListener('change', () => {
            runtime.updateDraftField('disable', !activeChk.checked);
        });

        const constantChk = h('input', { type: 'checkbox', checked: draft.constant });
        constantChk.addEventListener('change', () => {
            runtime.updateDraftField('constant', constantChk.checked);
        });

        const vecChk = h('input', { type: 'checkbox', checked: draft.vectorized });
        vecChk.addEventListener('change', () => {
            runtime.updateDraftField('vectorized', vecChk.checked);
        });

        const statusGroup = h('div', { className: 'wie-checkbox-group' },
            h('label', { className: 'wie-checkbox-label' }, activeChk, h('span', { text: '启用条目 (Active)' })),
            h('label', { className: 'wie-checkbox-label gold' }, constantChk, h('span', { text: '常驻激活 (Constant)' })),
            h('label', { className: 'wie-checkbox-label' }, vecChk, h('span', { text: '向量检索 (Vectorized)' })),
        );

        // 主触发词 Tag 编辑器
        const primaryTagEditor = renderTagEditor('primary', draft.key, next => {
            runtime.updateDraftField('key', next);
        }, runtime.revision, false);

        // 二级触发词与逻辑
        const selectiveChk = h('input', { type: 'checkbox', checked: draft.selective });
        selectiveChk.addEventListener('change', () => {
            runtime.updateDraftField('selective', selectiveChk.checked);
        });

        const logicSelect = h('select', { className: 'wie-select', style: 'padding: 4px 8px; font-size: 12px;' });
        for (const opt of SELECTIVE_LOGIC_OPTIONS) {
            logicSelect.append(h('option', { value: String(opt.value), text: opt.label, selected: draft.selectiveLogic === opt.value }));
        }
        logicSelect.addEventListener('change', () => {
            runtime.updateDraftField('selectiveLogic', Number(logicSelect.value));
        });

        const secTagEditor = renderTagEditor('secondary', draft.keysecondary, next => {
            runtime.updateDraftField('keysecondary', next);
        }, runtime.revision, true);

        const secBox = h('div', { style: draft.selective ? 'display: flex; flex-direction: column; gap: 8px;' : 'display: none;' },
            secTagEditor,
            h('div', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ttk-muted);' },
                h('span', { text: '匹配关系：' }),
                logicSelect,
            ),
        );

        const section1 = h('section', { className: `wie-form-section wie-section-basic${view.mobileTab !== 'basic' ? ' wie-tab-hidden' : ''}` },
            h('div', { className: 'wie-section-head' },
                h('div', {},
                    h('div', { className: 'wie-section-title', text: '📌 核心触发设定' }),
                    h('div', { className: 'wie-section-desc', text: '条目标题、触发词与常驻状态' }),
                ),
            ),
            h('div', { className: 'wie-form-row' },
                h('div', { className: 'wie-form-label required', text: '标题 / 注释' }),
                h('div', { className: 'wie-form-control' }, commentInput),
            ),
            h('div', { className: 'wie-form-row' },
                h('div', { className: 'wie-form-label', text: '运行状态' }),
                h('div', { className: 'wie-form-control' }, statusGroup),
            ),
            h('div', { className: 'wie-form-row' },
                h('div', { className: 'wie-form-label required', text: '主要触发词' }),
                h('div', { className: 'wie-form-control' },
                    primaryTagEditor,
                    h('span', { className: 'wie-hint', text: '按回车或逗号成块；支持正则如 /.+/i 自动标识 REG' }),
                ),
            ),
            h('div', { className: 'wie-form-row' },
                h('div', { className: 'wie-form-label', text: '二级条件' }),
                h('div', { className: 'wie-form-control' },
                    h('label', { className: 'wie-checkbox-label' }, selectiveChk, h('span', { text: '启用二级过滤词 (Selective)' })),
                    secBox,
                ),
            ),
        );

        // 模块 2: 正文编辑区
        const textarea = h('textarea', {
            className: 'wie-textarea',
            value: draft.content,
            placeholder: '在此输入条目世界观正文设定...',
        });
        textarea.addEventListener('input', () => {
            runtime.updateDraftField('content', textarea.value);
            scheduleScroll(textarea, { delay: 60 });
        });
        textarea.addEventListener('focus', () => {
            scheduleScroll(textarea);
        });

        // 宏按键与全屏写作共用一套宏；有选区时包裹选区而不是冲掉原文。
        const applyMacro = (value, selection) => {
            textarea.value = value;
            runtime.updateDraftField('content', value);
            textarea.focus();
            textarea.setSelectionRange(selection.start, selection.end);
        };

        const editorWrap = h('div', { className: 'wie-editor-wrap' },
            h('div', { className: 'wie-editor-toolbar' },
                h('div', { className: 'wie-editor-count', text: `字数: ${draft.content.length} · 预估 Token: ${estimateTokens(draft.content)}` }),
                h('div', { className: 'wie-editor-tools' },
                    actionButton('⛶ 全屏写作', () => {
                        view.zenMode = true;
                        render();
                    }, { className: 'secondary' }),
                ),
            ),
            renderMacroBar(textarea, applyMacro),
            textarea,
        );

        const section2 = h('section', { className: `wie-form-section wie-section-basic${view.mobileTab !== 'basic' ? ' wie-tab-hidden' : ''}` },
            h('div', { className: 'wie-section-head' },
                h('div', {},
                    h('div', { className: 'wie-section-title', text: '📝 条目正文内容 (Content)' }),
                    h('div', { className: 'wie-section-desc', text: '被检索激活后送入模型上下文的设定描述' }),
                ),
            ),
            editorWrap,
        );

        // 模块 3: 注入时机与位置
        const posSelect = h('select', { className: 'wie-input-text' });
        for (const p of POSITION_OPTIONS) {
            posSelect.append(h('option', { value: String(p.value), text: p.label, selected: draft.position === p.value }));
        }
        posSelect.addEventListener('change', () => {
            runtime.updateDraftField('position', Number(posSelect.value));
            render();
        });

        const depthInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.depth ?? 4), min: 0 });
        depthInput.addEventListener('input', () => {
            runtime.updateDraftField('depth', Number(depthInput.value));
        });

        const orderInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.order ?? 100), step: 10 });
        orderInput.addEventListener('input', () => {
            runtime.updateDraftField('order', Number(orderInput.value));
        });

        const probInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.probability ?? 100), min: 1, max: 100 });
        probInput.addEventListener('input', () => {
            runtime.updateDraftField('probability', Number(probInput.value));
        });

        const outletInput = h('input', { className: 'wie-input-text', value: draft.outletName ?? '', placeholder: '宿主 Outlet 名称' });
        outletInput.addEventListener('input', () => runtime.updateDraftField('outletName', outletInput.value));
        const roleSelect = h('select', { className: 'wie-input-text' });
        for (const r of ROLE_OPTIONS) {
            roleSelect.append(h('option', { value: String(r.value), text: r.label, selected: draft.role === r.value }));
        }
        roleSelect.addEventListener('change', () => {
            runtime.updateDraftField('role', Number(roleSelect.value));
        });

        const section3 = h('section', { className: `wie-form-section wie-section-timing${view.mobileTab !== 'timing' ? ' wie-tab-hidden' : ''}` },
            h('div', { className: 'wie-section-head' },
                h('div', {},
                    h('div', { className: 'wie-section-title', text: '📍 注入时机与位置 (Placement)' }),
                    h('div', { className: 'wie-section-desc', text: '决定条目拼接在上下文中的位置、深度和先后次序' }),
                ),
            ),
            h('div', { className: 'wie-params-grid' },
                h('div', { className: 'wie-param-item' }, h('label', { text: '插入位置 (Position)' }), posSelect),
                draft.position === 4
                    ? h('div', { className: 'wie-param-item' }, h('label', { text: '注入深度 (Depth)' }), depthInput)
                    : null,
                draft.position === 7
                    ? h('div', { className: 'wie-param-item' }, h('label', { text: 'Outlet 名称' }), outletInput)
                    : null,
                h('div', { className: 'wie-param-item' }, h('label', { text: '顺序 (Order)' }), orderInput),
                h('div', { className: 'wie-param-item' }, h('label', { text: '概率 (%)' }), probInput),
                h('div', { className: 'wie-param-item' }, h('label', { text: '角色 (Role)' }), roleSelect),
            ),
        );

        // 模块 4: 高级控制手风琴
        const accordionBtn = h('button', { type: 'button', className: 'wie-accordion-btn' },
            h('span', { text: '⚙️ 高级触发与递归机制 (防递归、动态时机、互斥分组)' }),
            h('span', { text: view.accordionOpen ? '▾' : '▸' }),
        );
        accordionBtn.addEventListener('click', () => {
            view.accordionOpen = !view.accordionOpen;
            render();
        });

        const excludeRecChk = h('input', { type: 'checkbox', checked: draft.excludeRecursion });
        excludeRecChk.addEventListener('change', () => {
            runtime.updateDraftField('excludeRecursion', excludeRecChk.checked);
        });

        const preventRecChk = h('input', { type: 'checkbox', checked: draft.preventRecursion });
        preventRecChk.addEventListener('change', () => {
            runtime.updateDraftField('preventRecursion', preventRecChk.checked);
        });

        const stickyInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.sticky ?? ''), placeholder: '0' });
        stickyInput.addEventListener('input', () => {
            runtime.updateDraftField('sticky', stickyInput.value ? Number(stickyInput.value) : null);
        });

        const cooldownInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.cooldown ?? ''), placeholder: '0' });
        cooldownInput.addEventListener('input', () => {
            runtime.updateDraftField('cooldown', cooldownInput.value ? Number(cooldownInput.value) : null);
        });

        const delayInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.delay ?? ''), placeholder: '0' });
        delayInput.addEventListener('input', () => {
            runtime.updateDraftField('delay', delayInput.value ? Number(delayInput.value) : null);
        });

        const groupInput = h('input', { type: 'text', className: 'wie-input-text', value: draft.group || '', placeholder: '如: factions' });
        groupInput.addEventListener('input', () => {
            runtime.updateDraftField('group', groupInput.value);
        });

        const groupWeightInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.groupWeight ?? 100) });
        groupWeightInput.addEventListener('input', () => {
            runtime.updateDraftField('groupWeight', Number(groupWeightInput.value));
        });

        const groupOverrideChk = h('input', { type: 'checkbox', checked: draft.groupOverride });
        groupOverrideChk.addEventListener('change', () => {
            runtime.updateDraftField('groupOverride', groupOverrideChk.checked);
        });

        const scanDepthInput = h('input', { type: 'number', className: 'wie-input-text', value: String(draft.scanDepth ?? ''), placeholder: '默认扫描' });
        scanDepthInput.addEventListener('input', () => {
            runtime.updateDraftField('scanDepth', scanDepthInput.value ? Number(scanDepthInput.value) : null);
        });

        const caseChk = h('input', { type: 'checkbox', checked: Boolean(draft.caseSensitive) });
        caseChk.addEventListener('change', () => {
            runtime.updateDraftField('caseSensitive', caseChk.checked);
        });

        const wholeChk = h('input', { type: 'checkbox', checked: Boolean(draft.matchWholeWords) });
        wholeChk.addEventListener('change', () => {
            runtime.updateDraftField('matchWholeWords', wholeChk.checked);
        });

        const accordionContent = h('div', {
            className: 'wie-accordion-content',
            style: view.accordionOpen || view.mobileTab === 'advanced' ? 'display: flex;' : 'display: none;',
        },
            h('div', { className: 'wie-params-grid' },
                h('div', { className: 'wie-param-item' }, h('label', { text: 'Sticky (保持轮数)' }), stickyInput),
                h('div', { className: 'wie-param-item' }, h('label', { text: 'Cooldown (冷却轮数)' }), cooldownInput),
                h('div', { className: 'wie-param-item' }, h('label', { text: 'Delay (延迟轮数)' }), delayInput),
                h('div', { className: 'wie-param-item' }, h('label', { text: '扫描深度 (Scan Depth)' }), scanDepthInput),
            ),
            h('div', { className: 'wie-params-grid' },
                h('div', { className: 'wie-param-item' }, h('label', { text: '互斥分组 (Group)' }), groupInput),
                h('div', { className: 'wie-param-item' }, h('label', { text: '分组权重 (Weight)' }), groupWeightInput),
            ),
            h('div', { className: 'wie-checkbox-group' },
                h('label', { className: 'wie-checkbox-label' }, groupOverrideChk, h('span', { text: '覆盖同组 (Group Override)' })),
                h('label', { className: 'wie-checkbox-label' }, excludeRecChk, h('span', { text: '排除自身扫描 (Exclude Recursion)' })),
                h('label', { className: 'wie-checkbox-label' }, preventRecChk, h('span', { text: '阻止后续条目递归 (Prevent Recursion)' })),
                h('label', { className: 'wie-checkbox-label' }, caseChk, h('span', { text: '区分大小写 (Case Sensitive)' })),
                h('label', { className: 'wie-checkbox-label' }, wholeChk, h('span', { text: '严格全词匹配 (Match Whole Words)' })),
            ),
        );

        const section4 = h('section', { className: `wie-form-section wie-section-advanced${view.mobileTab !== 'advanced' ? ' wie-tab-hidden' : ''}` },
            accordionBtn,
            accordionContent,
        );

        // 底部保存按钮条
        const footer = h('div', { className: 'wie-form-footer' },
            actionButton('还原修改', () => {
                runtime.revertDraft();
                render();
            }, { className: 'secondary' }),
            actionButton('💾 立即保存', () => {
                void saveManually();
            }, { className: 'primary' }),
        );

        form.append(section1, section2, section3, section4, footer);
        return form;
    }

    function renderZenOverlay(draft) {
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

        // 与普通模式同一套宏，并提供成对包裹。
        const applyMacro = (value, selection) => {
            textarea.value = value;
            runtime.updateDraftField('content', value);
            textarea.focus();
            textarea.setSelectionRange(selection.start, selection.end);
        };

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
            renderMacroBar(textarea, applyMacro),
            textarea,
        );
    }

    // 手机输入法没有稳定的失焦时机：返回列表前先把未保存草稿落盘，避免静默丢失。
    async function closeDetailView() {
        if (runtime.state.dirty || runtime.state.saveStatus === 'error') {
            const saved = await saveManually();
            if (!saved)
                return;
        }
        view.mobileSubView = 'list';
        render();
    }

    async function saveManually() {
        try {
            await runtime.saveCurrentDraft({ isAuto: false });
            return true;
        }
        catch (error) {
            // 错误保留在 runtime.state，由顶部提示与状态区持续展示，不阻断查看列表。
            notices.show(errorMessage(error), 'danger');
            render();
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
                    await runtime.refreshWorlds();
                    notices.show('已重新读取世界书。', 'success');
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

        if (draft) {
            view.formUid = draft.uid;
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
            root.append(renderZenOverlay(draft));
        }

        target.append(root);
        // 窄容器吸顶栏的保存状态与详情头部同源，首次渲染后同步一次。
        syncMobileSaveChip();
    }
    render();

    return () => {
        disposed = true;
        unsubscribe();
        target.classList.remove('wie-host');
        void runtime.flush().catch(() => {}); // Retain failed draft for next mount.
    };
}
