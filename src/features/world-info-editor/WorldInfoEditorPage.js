import { actionButton, callout, h } from '../../ui/dom.js';
import { errorMessage } from '../../kernel/errors.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { confirmDanger } from '../../ui/confirm.js';
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

export function mountWorldInfoEditorPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        mobileSubView: 'list', // 'list' | 'edit'
        mobileTab: 'basic',
        zenMode: false,
        accordionOpen: false,
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

    target.classList.add('wie-host');
    const unsubscribe = runtime.subscribe(() => {
        if (disposed) return;
        const active = target.ownerDocument.activeElement;
        // Never detach a text input, textarea, select or composing IME during typing or autosave.
        if (active && target.contains(active) && active.matches('input:not([type=checkbox]), textarea, select')) {
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
        if (status) {
            status.className = `wie-status-indicator ${saveStatus === 'error' ? 'error' : saveStatus === 'unsaved' ? 'unsaved' : saveStatus === 'saving' ? 'saving' : 'saved'}`;
            status.textContent = `● ${labels[saveStatus] ?? '已同步'}`;
        }
        const heading = target.querySelector('.wie-detail-name');
        if (heading && currentDraft) heading.textContent = currentDraft.comment || '(未命名条目)';
        const counter = target.querySelector('.wie-editor-count');
        if (counter && currentDraft) counter.textContent = `字数: ${currentDraft.content.length} · 预估 Token: ${estimateTokens(currentDraft.content)}`;
        const warning = target.querySelector('.wie-save-error');
        if (warning) warning.textContent = error ?? '';
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
        });

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

    function renderTagEditor(tags, onAdd, onRemove, isSecondary = false) {
        const box = h('div', { className: 'wie-tag-box' });
        for (const [idx, tag] of tags.entries()) {
            const isReg = isRegexKey(tag);
            const tagEl = h('span', { className: `wie-tag${isSecondary ? ' secondary' : ''}${isReg ? ' regex' : ''}` },
                tag,
                isReg ? h('span', { className: 'wie-tag-regex-badge', text: 'REG' }) : null,
            );
            const removeBtn = h('span', { className: 'wie-tag-remove', text: '×' });
            removeBtn.addEventListener('click', e => {
                e.stopPropagation();
                onRemove(idx);
            });
            tagEl.append(removeBtn);
            box.append(tagEl);
        }

        const input = h('input', {
            type: 'text',
            className: 'wie-tag-input',
            placeholder: tags.length === 0 ? '键入词按回车或逗号添加...' : '+ 添加...',
        });

        input.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === ',' && input.value.startsWith('/') && !isRegexKey(input.value)) return;
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                event.preventDefault();
                const val = input.value.trim().replace(/^,+|[，,]+$/g, '');
                if (val) {
                    onAdd(val);
                    render();
                    target.querySelectorAll('.wie-tag-input')[isSecondary ? 1 : 0]?.focus();
                }
            }
        });

        box.append(input);
        return box;
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
            void run(async () => {
                await runtime.saveCurrentDraft({ isAuto: false });
            });
        }, { className: 'primary' });

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
        const primaryTagEditor = renderTagEditor(
            draft.key || [],
            val => {
                const next = [...(draft.key || []), val];
                runtime.updateDraftField('key', next);
            },
            idx => {
                const next = [...(draft.key || [])];
                next.splice(idx, 1);
                runtime.updateDraftField('key', next);
            },
            false,
        );

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

        const secTagEditor = renderTagEditor(
            draft.keysecondary || [],
            val => {
                const next = [...(draft.keysecondary || []), val];
                runtime.updateDraftField('keysecondary', next);
            },
            idx => {
                const next = [...(draft.keysecondary || [])];
                next.splice(idx, 1);
                runtime.updateDraftField('keysecondary', next);
            },
            true,
        );

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
        });

        const insertMacro = macro => {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const val = textarea.value;
            const next = val.substring(0, start) + macro + val.substring(end);
            textarea.value = next;
            runtime.updateDraftField('content', next);
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = start + macro.length;
        };

        const editorWrap = h('div', { className: 'wie-editor-wrap' },
            h('div', { className: 'wie-editor-toolbar' },
                h('div', { className: 'wie-editor-count', text: `字数: ${draft.content.length} · 预估 Token: ${estimateTokens(draft.content)}` }),
                h('div', { className: 'wie-editor-tools' },
                    actionButton('+ {{char}}', () => insertMacro('{{char}}'), { className: 'secondary' }),
                    actionButton('+ {{user}}', () => insertMacro('{{user}}'), { className: 'secondary' }),
                    actionButton('⛶ 全屏写作', () => {
                        view.zenMode = true;
                        render();
                    }, { className: 'secondary' }),
                ),
            ),
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
            }, { className: 'secondary' }),
            actionButton('💾 立即保存', () => {
                void run(async () => {
                    await runtime.saveCurrentDraft({ isAuto: false });
                });
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
        });

        const insertMacro = val => {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            const next = text.substring(0, start) + val + text.substring(end);
            textarea.value = next;
            runtime.updateDraftField('content', next);
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = start + val.length;
        };

        const macros = ['{{char}}', '{{user}}', '[[', ']]', '*动作*', '"对话"'].map(macro => {
            const keyEl = h('span', { className: 'wie-macro-key', text: macro });
            keyEl.addEventListener('click', () => insertMacro(macro));
            return keyEl;
        });

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

        return h('div', { className: 'wie-zen-overlay' },
            header,
            textarea,
            h('div', { className: 'wie-zen-macro-bar' }, macros),
        );
    }

    function render() {
        if (disposed)
            return;

        target.replaceChildren();
        const root = h('div', { className: `wie-root${view.mobileSubView === 'edit' ? ' wie-edit-view' : ''}` });
        renderHeader(root);
        root.append(h('div', { className: 'wie-save-error', attrs: { role: 'alert' }, text: runtime.state.error ?? '' }));

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

        // 右侧详情区
        const detailPane = h('main', { className: 'wie-detail-pane' });
        const draft = runtime.state.currentDraft;

        if (draft) {
            // 移动端返回栏
            const mobileBackBar = h('div', { className: 'wie-mobile-view-header' },
                actionButton('‹ 返回列表', () => {
                    view.mobileSubView = 'list';
                    render();
                }, { className: 'secondary' }),
                h('strong', { style: 'font-size: 13px;', text: `#${draft.uid} ${draft.comment || ''}` }),
                actionButton('保存', () => {
                    void run(async () => {
                        await runtime.saveCurrentDraft({ isAuto: false });
                    });
                }, { className: 'primary' }),
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
    }

    render();

    return () => {
        disposed = true;
        unsubscribe();
        target.classList.remove('wie-host');
        void runtime.flush().catch(() => {}); // Retain failed draft for next mount.
    };
}
