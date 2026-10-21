import { actionButton, h } from '../../ui/dom.js';
import { renderMacroBar } from './macro-bar.js';
import { estimateTokens, POSITION_OPTIONS, ROLE_OPTIONS, SELECTIVE_LOGIC_OPTIONS } from './schema.js';

// 数字参数输入：空值或非法值不进入草稿（Number('') 是 0，直接写会把条目静默改成 0），
// 保留上一次合法值并标记输入框，等用户修正后再写入。
export function bindNumberInput(runtime, input, field, { min = null, max = null, nullable = false } = {}) {
    input.dataset.field = field;
    const restore = () => {
        const current = runtime.state.currentDraft?.[field];
        input.value = current === null || current === undefined ? '' : String(current);
        input.classList.remove('wie-input-invalid');
        input.removeAttribute('title');
    };
    input.addEventListener('input', () => {
        const raw = input.value.trim();
        if (raw === '') {
            input.classList.remove('wie-input-invalid');
            input.removeAttribute('title');
            // 允许为空的字段（sticky/cooldown/delay/scanDepth）清空即退回“不设置”。
            if (nullable)
                runtime.updateDraftField(field, null);
            return;
        }
        const value = Number(raw);
        const invalid = !Number.isInteger(value)
            || (min !== null && value < min)
            || (max !== null && value > max);
        input.classList.toggle('wie-input-invalid', invalid);
        if (invalid) {
            input.title = `需要 ${min ?? '不限'} 到 ${max ?? '不限'} 之间的整数；未写入世界书。`;
            return;
        }
        input.removeAttribute('title');
        runtime.updateDraftField(field, value);
    });
    input.addEventListener('blur', () => {
        if (input.classList.contains('wie-input-invalid') || (input.value.trim() === '' && !nullable))
            restore();
    });
}

function sectionHeader(title, description) {
    return h('div', { className: 'wie-section-head' },
        h('div', {},
            h('div', { className: 'wie-section-title', text: title }),
            h('div', { className: 'wie-section-desc', text: description }),
        ),
    );
}

function checkbox(read, write) {
    const input = h('input', { type: 'checkbox', checked: read });
    input.addEventListener('change', () => write(input.checked));
    return input;
}

function labelledCheckbox(label, read, write, className = 'wie-checkbox-label') {
    return h('label', { className }, checkbox(read, write), h('span', { text: label }));
}

// 参数项用 <label> 包裹标题与控件：标题即控件的可访问名称，点击标题也能聚焦控件。
function paramItem(caption, control) {
    return h('label', { className: 'wie-param-item' }, h('span', { text: caption }), control);
}

// 右侧详情表单：按条目字段分组拆成四个区块，每个区块只依赖自己的控件与 runtime。
export function createDetailForm({ runtime, view, render, saveManually, scheduleScroll, renderTagEditor }) {
    const bind = (field, options) => input => {
        bindNumberInput(runtime, input, field, options);
        return input;
    };
    const tabClass = tab => `wie-form-section wie-section-${tab}${view.mobileTab !== tab ? ' wie-tab-hidden' : ''}`;

    // 模块 1: 核心触发设定
    function basicSection(draft) {
        const commentInput = h('input', {
            type: 'text',
            className: 'wie-input-text',
            value: draft.comment,
            placeholder: '用于辨识条目的注释标题',
            attrs: { 'aria-label': '标题 / 注释' },
        });
        commentInput.addEventListener('input', () => {
            runtime.updateDraftField('comment', commentInput.value);
        });

        const statusGroup = h('div', { className: 'wie-checkbox-group' },
            labelledCheckbox('启用条目 (Active)', !draft.disable, checked => runtime.updateDraftField('disable', !checked)),
            labelledCheckbox('常驻激活 (Constant)', draft.constant, checked => runtime.updateDraftField('constant', checked), 'wie-checkbox-label gold'),
            labelledCheckbox('向量检索 (Vectorized)', draft.vectorized, checked => runtime.updateDraftField('vectorized', checked)),
        );

        // 主触发词 Tag 编辑器
        const primaryTagEditor = renderTagEditor('primary', draft.key, next => {
            runtime.updateDraftField('key', next);
        }, runtime.revision, false);

        // 二级触发词与逻辑
        const selectiveChk = checkbox(draft.selective, checked => runtime.updateDraftField('selective', checked));
        const logicSelect = h('select', { className: 'wie-select', style: 'padding: 4px 8px; font-size: 12px;', attrs: { 'aria-label': '二级过滤词匹配关系' } });
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

        return h('section', { className: tabClass('basic') },
            sectionHeader('📌 核心触发设定', '条目标题、触发词与常驻状态'),
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
    }

    // 模块 2: 正文编辑区
    function contentSection(draft) {
        const textarea = h('textarea', {
            className: 'wie-textarea',
            value: draft.content,
            placeholder: '在此输入条目世界观正文设定…',
            attrs: { 'aria-label': '条目正文内容' },
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

        return h('section', { className: tabClass('basic') },
            sectionHeader('📝 条目正文内容 (Content)', '被检索激活后送入模型上下文的设定描述'),
            editorWrap,
        );
    }

    // 模块 3: 注入时机与位置
    function timingSection(draft) {
        const posSelect = h('select', { className: 'wie-input-text' });
        for (const p of POSITION_OPTIONS) {
            posSelect.append(h('option', { value: String(p.value), text: p.label, selected: draft.position === p.value }));
        }
        posSelect.addEventListener('change', () => {
            runtime.updateDraftField('position', Number(posSelect.value));
            render();
        });

        const depthInput = bind('depth', { min: 0 })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.depth ?? 4), min: 0 }));
        const orderInput = bind('order')(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.order ?? 100), step: 10 }));
        const probInput = bind('probability', { min: 1, max: 100 })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.probability ?? 100), min: 1, max: 100 }));

        const outletInput = h('input', { className: 'wie-input-text', value: draft.outletName ?? '', placeholder: '宿主 Outlet 名称', attrs: { 'aria-label': 'Outlet 名称' } });
        outletInput.addEventListener('input', () => runtime.updateDraftField('outletName', outletInput.value));
        const roleSelect = h('select', { className: 'wie-input-text' });
        for (const r of ROLE_OPTIONS) {
            roleSelect.append(h('option', { value: String(r.value), text: r.label, selected: draft.role === r.value }));
        }
        roleSelect.addEventListener('change', () => {
            runtime.updateDraftField('role', Number(roleSelect.value));
        });

        return h('section', { className: tabClass('timing') },
            sectionHeader('📍 注入时机与位置 (Placement)', '决定条目拼接在上下文中的位置、深度和先后次序'),
            h('div', { className: 'wie-params-grid' },
                paramItem('插入位置 (Position)', posSelect),
                draft.position === 4
                    ? paramItem('注入深度 (Depth)', depthInput)
                    : null,
                draft.position === 7
                    ? paramItem('Outlet 名称', outletInput)
                    : null,
                paramItem('顺序 (Order)', orderInput),
                paramItem('概率 (%)', probInput),
                paramItem('角色 (Role)', roleSelect),
            ),
        );
    }

    // 模块 4: 高级控制手风琴
    function advancedSection(draft) {
        const accordionBtn = h('button', { type: 'button', className: 'wie-accordion-btn' },
            h('span', { text: '⚙️ 高级触发与递归机制 (防递归、动态时机、互斥分组)' }),
            h('span', { text: view.accordionOpen ? '▾' : '▸' }),
        );
        accordionBtn.addEventListener('click', () => {
            view.accordionOpen = !view.accordionOpen;
            render();
        });

        const stickyInput = bind('sticky', { min: 0, nullable: true })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.sticky ?? ''), placeholder: '0' }));
        const cooldownInput = bind('cooldown', { min: 0, nullable: true })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.cooldown ?? ''), placeholder: '0' }));
        const delayInput = bind('delay', { min: 0, nullable: true })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.delay ?? ''), placeholder: '0' }));
        const scanDepthInput = bind('scanDepth', { min: 0, nullable: true })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.scanDepth ?? ''), placeholder: '默认扫描' }));
        const groupWeightInput = bind('groupWeight', { min: 0 })(h('input', { type: 'number', className: 'wie-input-text', value: String(draft.groupWeight ?? 100) }));

        const groupInput = h('input', { type: 'text', className: 'wie-input-text', value: draft.group || '', placeholder: '如: factions', attrs: { 'aria-label': '互斥分组 (Group)' } });
        groupInput.addEventListener('input', () => {
            runtime.updateDraftField('group', groupInput.value);
        });

        const accordionContent = h('div', {
            className: 'wie-accordion-content',
            style: view.accordionOpen || view.mobileTab === 'advanced' ? 'display: flex;' : 'display: none;',
        },
            h('div', { className: 'wie-params-grid' },
                paramItem('Sticky (保持轮数)', stickyInput),
                paramItem('Cooldown (冷却轮数)', cooldownInput),
                paramItem('Delay (延迟轮数)', delayInput),
                paramItem('扫描深度 (Scan Depth)', scanDepthInput),
            ),
            h('div', { className: 'wie-params-grid' },
                paramItem('互斥分组 (Group)', groupInput),
                paramItem('分组权重 (Weight)', groupWeightInput),
            ),
            h('div', { className: 'wie-checkbox-group' },
                labelledCheckbox('覆盖同组 (Group Override)', draft.groupOverride, checked => runtime.updateDraftField('groupOverride', checked)),
                labelledCheckbox('排除自身扫描 (Exclude Recursion)', draft.excludeRecursion, checked => runtime.updateDraftField('excludeRecursion', checked)),
                labelledCheckbox('阻止后续条目递归 (Prevent Recursion)', draft.preventRecursion, checked => runtime.updateDraftField('preventRecursion', checked)),
                labelledCheckbox('区分大小写 (Case Sensitive)', Boolean(draft.caseSensitive), checked => runtime.updateDraftField('caseSensitive', checked)),
                labelledCheckbox('严格全词匹配 (Match Whole Words)', Boolean(draft.matchWholeWords), checked => runtime.updateDraftField('matchWholeWords', checked)),
            ),
        );

        return h('section', { className: tabClass('advanced') }, accordionBtn, accordionContent);
    }

    function footer() {
        return h('div', { className: 'wie-form-footer' },
            actionButton('还原修改', () => {
                runtime.revertDraft();
                render();
            }, { className: 'secondary' }),
            actionButton('💾 立即保存', () => {
                void saveManually();
            }, { className: 'primary' }),
        );
    }

    return function renderDetailForm(draft) {
        return h('div', { className: 'wie-form-body' },
            basicSection(draft),
            contentSection(draft),
            timingSection(draft),
            advancedSection(draft),
            footer(),
        );
    };
}
