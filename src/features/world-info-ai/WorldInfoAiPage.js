import { actionButton, callout, h } from '../../ui/dom.js';
import { detectPromptTemplateEntry } from './schema.js';

const SOURCE_LABELS = {
    global: '全局世界书',
    character: '角色世界书',
    chat: '聊天世界书',
    persona: 'Persona 世界书',
};
const SOURCE_ORDER = ['global', 'character', 'chat', 'persona'];

function sortedEntries(data) {
    return Object.values(data?.entries ?? {}).sort((left, right) =>
        Number(left?.displayIndex ?? 0) - Number(right?.displayIndex ?? 0)
        || Number(right?.order ?? 0) - Number(left?.order ?? 0));
}

export function mountWorldInfoAiPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        draft: null,
        draftWorld: '',
        notice: '',
        filter: '',
    };
    let disposed = false;

    function syncDraft() {
        view.draft = runtime.state.config ? structuredClone(runtime.state.config) : null;
        view.draftWorld = runtime.state.selectedWorld;
        if (!view.draft)
            return;
        for (const entry of sortedEntries(runtime.state.worldData)) {
            const uid = String(entry.uid);
            view.draft.entries[uid] ??= { mode: 'native', aiDescription: '' };
            if (detectPromptTemplateEntry(entry).detected)
                view.draft.entries[uid].mode = 'native';
        }
    }

    const run = async task => {
        try {
            await task();
            view.notice = '';
        }
        catch (error) {
            view.notice = error instanceof Error ? error.message : String(error);
        }
        render();
    };

    function renderEntry(entry) {
        const uid = String(entry.uid);
        const configured = view.draft.entries[uid];
        const compatibility = detectPromptTemplateEntry(entry);
        const mode = h('select');
        mode.append(
            h('option', { value: 'native', text: '原生激活' }),
            h('option', { value: 'ai', text: 'AI 判断' }),
        );
        mode.value = compatibility.detected ? 'native' : configured.mode;
        mode.disabled = compatibility.detected;
        mode.addEventListener('change', () => {
            configured.mode = mode.value;
            render();
        });
        const description = h('textarea', {
            value: configured.aiDescription,
            placeholder: '只描述该条目在什么情况下应该激活；不会把世界书正文发送给模型。',
            rows: 3,
            disabled: configured.mode !== 'ai' || compatibility.detected,
        });
        description.addEventListener('input', () => { configured.aiDescription = description.value; });
        return h('article', { className: 'world-ai-entry' },
            h('div', { className: 'world-ai-entry-heading' },
                h('div', {},
                    h('strong', { text: entry.comment || `条目 ${uid}` }),
                    h('small', { text: `UID ${uid} · 顺序 ${String(entry.order ?? 0)}${entry.group ? ` · 分组 ${entry.group}` : ''}` }),
                ),
                mode,
            ),
            compatibility.detected
                ? callout(`检测到 ${compatibility.reasons.join('、')}，该条目固定交给 Prompt Template / 宿主原生链路。`, 'warning')
                : null,
            configured.mode === 'ai' && !compatibility.detected ? description : null,
        );
    }

    function renderActiveWorld(world) {
        let status;
        let kind = '';
        if (world.error) {
            status = `配置读取失败：${world.error}`;
            kind = 'error';
        }
        else if (!world.routerEnabled) {
            status = world.configuredAiEntries
                ? `AI 接管未开启；${world.configuredAiEntries} 个 AI 配置当前不生效`
                : '未配置生效中的 AI 激活条目';
        }
        else if (!world.eligibleAiEntries) {
            status = world.configuredAiEntries
                ? `${world.configuredAiEntries} 个 AI 配置均因模板语法固定走原生链路`
                : 'AI 接管已开启，但没有 AI 激活条目';
            kind = 'warning';
        }
        else {
            status = `AI 接管生效：${world.eligibleAiEntries} 个 AI 激活条目`;
            if (world.configuredAiEntries > world.eligibleAiEntries)
                status += `；另有 ${world.configuredAiEntries - world.eligibleAiEntries} 个固定走原生链路`;
            kind = 'active';
        }
        return h('article', {
            className: `world-ai-active-card${kind ? ` ${kind}` : ''}`,
            dataset: { activeWorld: world.name },
        },
        h('div', {},
            h('span', { className: 'world-ai-source', text: SOURCE_LABELS[world.source] ?? world.source }),
            h('strong', { text: world.name }),
        ),
        h('small', { text: status }));
    }

    function activeWorldsSection() {
        const worlds = [...(runtime.state.activeWorlds ?? [])].sort((left, right) =>
            SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source));
        const section = h('section', { className: 'world-ai-active' },
            h('div', { className: 'world-ai-section-heading' },
                h('div', {},
                    h('h3', { text: '当前聊天正在生效的世界书' }),
                    h('p', { text: '按宿主实际挂载优先级显示全局、角色、聊天与 Persona 世界书，以及其中可参与 AI 判断的条目。' }),
                ),
            ),
        );
        if (runtime.state.activeWorldsError)
            section.append(callout(`无法读取当前挂载关系：${runtime.state.activeWorldsError}`, 'warning'));
        else if (!worlds.length)
            section.append(h('p', { className: 'empty-state', text: '当前聊天没有正在生效的世界书。' }));
        else
            section.append(h('div', { className: 'world-ai-active-grid' }, worlds.map(renderActiveWorld)));
        return section;
    }

    function render() {
        if (disposed)
            return;
        const toggle = h('input', { type: 'checkbox', checked: view.enabled });
        toggle.addEventListener('change', () => {
            const next = toggle.checked;
            void run(async () => {
                await props.setEnabled(next);
                view.enabled = next;
            });
        });
        const root = h('section', { className: 'feature-page' },
            h('header', { className: 'feature-header' },
                h('div', {},
                    h('p', { className: 'eyebrow', text: '世界书' }),
                    h('h2', { text: 'AI 激活' }),
                    h('p', { text: 'AI 条目只由独立描述判断，选中后仍走宿主排序、预算、位置与正则流程。' }),
                ),
                h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '已启用' : '未启用' })),
            ),
        );
        if (!view.enabled)
            root.append(callout('功能未启用；可以预先配置世界书，但生成时不会发送模型请求或改动激活流程。', 'warning'));
        if (runtime.state.warning)
            root.append(callout(runtime.state.warning, 'warning'));
        if (runtime.state.error)
            root.append(callout(runtime.state.error, 'danger'));
        if (view.notice)
            root.append(callout(view.notice, 'danger'));
        root.append(callout(runtime.state.status));
        root.append(activeWorldsSection());

        const worldSelect = h('select');
        for (const name of runtime.state.worldNames)
            worldSelect.append(h('option', { value: name, text: name }));
        worldSelect.value = runtime.state.selectedWorld;
        worldSelect.addEventListener('change', () => {
            void run(async () => {
                await runtime.selectWorld(worldSelect.value);
                syncDraft();
            });
        });
        root.append(h('div', { className: 'world-ai-toolbar' },
            h('label', {}, h('span', { text: '世界书' }), worldSelect),
            actionButton('刷新列表', () => { void run(async () => { await runtime.refreshWorlds(); syncDraft(); }); }, { className: 'secondary' }),
        ));

        if (view.draft && runtime.state.worldData) {
            const takeover = h('input', { type: 'checkbox', checked: view.draft.enabled });
            takeover.addEventListener('change', () => { view.draft.enabled = takeover.checked; render(); });
            const search = h('input', { value: view.filter, placeholder: '按标题或 UID 筛选条目' });
            search.addEventListener('input', () => { view.filter = search.value; render(); });
            root.append(h('div', { className: 'setting-row' },
                h('div', {}, h('strong', { text: '接管此世界书的 AI 条目' }), h('small', { text: '关闭时，该世界书所有条目均按原生方式运行。' })),
                takeover,
            ));
            root.append(h('div', { className: 'world-ai-meta' },
                h('span', { text: `配置存储：${runtime.state.storageBackend}` }),
                search,
            ));
            const needle = view.filter.trim().toLowerCase();
            const entries = sortedEntries(runtime.state.worldData).filter(entry => !needle
                || String(entry.comment ?? '').toLowerCase().includes(needle)
                || String(entry.uid).toLowerCase().includes(needle));
            root.append(h('div', { className: 'world-ai-entries' }, entries.map(renderEntry)));
            root.append(h('div', { className: 'actions' }, actionButton('保存世界书 AI 配置', () => {
                void run(async () => {
                    await runtime.saveConfig(structuredClone(view.draft));
                    syncDraft();
                });
            }, { className: 'primary', disabled: runtime.state.busy }))); 
        }
        else if (!runtime.state.busy) {
            root.append(callout('没有可配置的世界书。'));
        }
        target.replaceChildren(root);
    }

    const unsubscribe = runtime.subscribe(() => {
        if (view.draftWorld !== runtime.state.selectedWorld)
            syncDraft();
        render();
    });
    render();
    void runtime.refreshWorlds().then(() => { syncDraft(); render(); });
    return () => {
        disposed = true;
        unsubscribe();
        target.replaceChildren();
    };
}
