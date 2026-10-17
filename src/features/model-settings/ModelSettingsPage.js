import { actionButton, callout, h } from '../../ui/dom.js';

function input(value, onInput, options = {}) {
    const element = h('input', { value, ...options });
    element.addEventListener('input', () => onInput(element.value));
    return element;
}

export function mountModelSettingsPage(target, props) {
    const runtime = props.runtime;
    const view = {
        draft: structuredClone(runtime.state.settings),
        revealed: new Set(),
        modelOptions: new Map(),
        loadingModels: new Set(),
        testingConnections: new Set(),
        notice: '',
        noticeKind: '',
        confirmingReset: false,
    };
    let disposed = false;

    const run = async task => {
        try {
            await task();
            view.notice = '';
            view.noticeKind = '';
        }
        catch (error) {
            view.notice = error instanceof Error ? error.message : String(error);
            view.noticeKind = 'danger';
        }
        render();
    };

    function addPreset() {
        const id = crypto.randomUUID();
        view.draft.presets.push({ id, name: '新模型预设', protocol: 'openai', apiUrl: '', model: '', apiKey: '' });
        view.draft.activePresetId ??= id;
        render();
    }

    function removePreset(id) {
        view.draft.presets = view.draft.presets.filter(item => item.id !== id);
        if (view.draft.activePresetId === id)
            view.draft.activePresetId = view.draft.presets[0]?.id ?? null;
        view.revealed.delete(id);
        view.modelOptions.delete(id);
        view.loadingModels.delete(id);
        view.testingConnections.delete(id);
        render();
    }

    async function loadModels(preset) {
        view.loadingModels.add(preset.id);
        view.notice = '';
        view.noticeKind = '';
        render();
        try {
            runtime.protectDraft(view.draft);
            const models = await runtime.fetchModels(structuredClone(preset));
            view.modelOptions.set(preset.id, models);
            view.notice = models.length
                ? `已从服务端获取 ${models.length} 个模型名称。`
                : '服务端返回了空模型列表。';
            view.noticeKind = '';
        }
        catch (error) {
            view.notice = error instanceof Error ? error.message : String(error);
            view.noticeKind = 'danger';
        }
        finally {
            view.loadingModels.delete(preset.id);
            render();
        }
    }

    async function testConnection(preset) {
        view.testingConnections.add(preset.id);
        view.notice = '';
        view.noticeKind = '';
        render();
        try {
            runtime.protectDraft(view.draft);
            const result = await runtime.testConnection(structuredClone(preset));
            view.notice = `连接成功；服务端返回 ${result.modelCount} 个模型。`;
            view.noticeKind = '';
        }
        catch (error) {
            view.notice = error instanceof Error ? error.message : String(error);
            view.noticeKind = 'danger';
        }
        finally {
            view.testingConnections.delete(preset.id);
            render();
        }
    }

    function renderPreset(preset) {
        const models = view.modelOptions.get(preset.id) ?? [];
        const modelListId = `ttk-model-list-${preset.id}`;
        const checking = view.loadingModels.has(preset.id) || view.testingConnections.has(preset.id);
        const active = h('input', { type: 'radio', name: 'active-llm-preset', checked: view.draft.activePresetId === preset.id });
        active.addEventListener('change', () => { view.draft.activePresetId = preset.id; render(); });
        const protocol = h('select', { disabled: checking || runtime.state.busy, attrs: { 'aria-label': '服务协议' } },
            h('option', { value: 'openai', text: 'OpenAI-compatible（文本生成）' }),
            h('option', { value: 'systemone', text: 'System One / Jev（概率决策）' }),
        );
        protocol.value = preset.protocol ?? 'openai';
        protocol.addEventListener('change', () => {
            preset.protocol = protocol.value;
            view.modelOptions.delete(preset.id);
            render();
        });
        const key = input(preset.apiKey, value => { preset.apiKey = value; }, {
            type: view.revealed.has(preset.id) ? 'text' : 'password',
            autocomplete: 'new-password',
            spellcheck: false,
            placeholder: 'API Key（本地无鉴权服务可留空）',
        });
        return h('section', { className: 'model-preset-card' },
            h('div', { className: 'model-preset-heading' },
                h('label', {}, active, h('strong', { text: '设为当前预设' })),
                actionButton('删除', () => removePreset(preset.id), { className: 'secondary' }),
            ),
            h('label', {}, h('span', { text: '预设名称' }), input(preset.name, value => { preset.name = value; }, { placeholder: '例如：本地模型' })),
            h('label', {}, h('span', { text: '服务协议' }), protocol),
            h('label', {}, h('span', { text: 'API URL' }), input(preset.apiUrl, value => { preset.apiUrl = value; }, { placeholder: preset.protocol === 'systemone' ? 'https://example.invalid/v1/systemone' : 'https://example.invalid/v1', spellcheck: false })),
            preset.protocol === 'systemone' ? h('p', { className: 'model-protocol-note', text: '直连 System One：填写基础 URL 或完整 /systemone；服务需允许跨域。测试连接仅获取模型列表，不发送付费判断，也不后台探测 JSON 能力。' }) : null,
            h('label', {}, h('span', { text: '模型' }), h('div', { className: 'model-control' },
                input(preset.model, value => { preset.model = value; }, { placeholder: 'model-name', spellcheck: false, attrs: { list: modelListId } }),
                actionButton(view.loadingModels.has(preset.id) ? '获取中…' : '获取模型', () => { void loadModels(preset); }, {
                    className: 'secondary',
                    disabled: checking,
                }),
                actionButton(view.testingConnections.has(preset.id) ? '检测中…' : '测试连接', () => { void testConnection(preset); }, {
                    className: 'secondary',
                    disabled: checking,
                }),
                h('datalist', { id: modelListId }, models.map(model => h('option', { value: model }))),
            )),
            h('label', {}, h('span', { text: '访问密钥' }), h('div', { className: 'key-control' },
                key,
                actionButton(view.revealed.has(preset.id) ? '隐藏' : '显示', () => {
                    if (view.revealed.has(preset.id)) view.revealed.delete(preset.id);
                    else view.revealed.add(preset.id);
                    render();
                }, { className: 'secondary' }),
            )),
        );
    }

    function render() {
        if (disposed)
            return;
        const root = h('section', { className: 'feature-page' },
            h('header', { className: 'feature-header' }, h('div', {},
                h('p', { className: 'eyebrow', text: '设置' }),
                h('h2', { text: '模型服务' }),
                h('p', { text: '管理 OpenAI-compatible 文本生成与 System One / Jev 概率决策预设。' }),
            )),
            callout('API URL、模型和访问密钥作为一组预设保存在 tt-toolkit 扩展存储中。密钥不会写入日志或导出；界面默认遮蔽。', 'warning'),
        );
        if (runtime.state.error)
            root.append(callout(runtime.state.error, 'danger'));
        if (view.notice)
            root.append(callout(view.notice, view.noticeKind));
        if (runtime.state.status)
            root.append(callout(runtime.state.status));
        root.append(h('div', { className: 'actions model-settings-actions' },
            actionButton('添加预设', addPreset, { className: 'secondary', disabled: runtime.state.busy || runtime.state.damaged }),
            actionButton('保存模型预设', () => {
                void run(async () => {
                    runtime.protectDraft(view.draft);
                    await runtime.save(structuredClone(view.draft));
                    view.draft = structuredClone(runtime.state.settings);
                });
            }, { className: 'primary', disabled: runtime.state.busy || runtime.state.damaged }),
            actionButton(runtime.state.damaged ? '重置损坏的模型预设' : '重置模型预设', () => {
                view.confirmingReset = true;
                render();
            }, { className: 'secondary', disabled: runtime.state.busy }),
        ));
        if (view.confirmingReset) {
            root.append(callout('重置将清除所有模型预设及访问密钥，不影响聊天或其它设置。插件不保留备份，无法撤销；需要保留时请先自行备份。', 'warning'));
            root.append(h('div', { className: 'actions' },
                actionButton('确认清除模型预设', () => {
                    void run(async () => {
                        await runtime.reset();
                        view.draft = structuredClone(runtime.state.settings);
                        view.modelOptions.clear();
                        view.revealed.clear();
                        view.confirmingReset = false;
                    });
                }, { className: 'primary', disabled: runtime.state.busy }),
                actionButton('取消重置', () => { view.confirmingReset = false; render(); }, { className: 'secondary', disabled: runtime.state.busy }),
            ));
        }
        root.append(h('div', { className: 'model-presets' }, view.draft.presets.map(renderPreset)));
        if (!view.draft.presets.length)
            root.append(callout('尚无模型预设。添加并保存匹配功能协议的预设后即可使用模型服务。'));
        target.replaceChildren(root);
    }

    const unsubscribe = runtime.subscribe(() => {
        if (!runtime.state.busy && !runtime.state.error)
            view.draft = structuredClone(runtime.state.settings);
        render();
    });
    render();
    void runtime.load().then(() => {
        view.draft = structuredClone(runtime.state.settings);
        render();
    });
    return () => {
        disposed = true;
        unsubscribe();
        target.replaceChildren();
    };
}
