import { actionButton, callout, h } from '../../ui/dom.js';
import { detectPromptTemplateEntry, isAiModeEligible, worldInfoTriggerType } from './schema.js';

const SOURCE_LABELS = {
    global: '全局世界书',
    character: '角色世界书',
    chat: '聊天世界书',
    persona: 'Persona 世界书',
};
const SOURCE_ORDER = ['global', 'character', 'chat', 'persona'];
const TRIGGER_LABELS = { keyword: '关键词触发', constant: '常驻触发', vectorized: '向量触发' };

function sortedEntries(data) {
    return Object.values(data?.entries ?? {}).sort((left, right) =>
        Number(left?.displayIndex ?? 0) - Number(right?.displayIndex ?? 0)
        || Number(right?.order ?? 0) - Number(left?.order ?? 0));
}

function summarizeFailures(failures) {
    const labels = { EMPTY_DESCRIPTION: '空描述', DESCRIPTION_TOO_LONG: '描述过长', MISSING_RESPONSE: '未返回' };
    const counts = {};
    for (const failure of failures)
        counts[failure.code] = (counts[failure.code] ?? 0) + 1;
    return Object.entries(counts).map(([code, count]) => `${labels[code] ?? code} ${count}`).join('、');
}

export function mountWorldInfoAiPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled,
        draft: null,
        draftWorld: '',
        notice: '',
        noticeKind: '',
        filter: '',
        selection: new Set(),
        fillConfirm: false,
        fillUids: [],
    };
    let disposed = false;

    function syncDraft() {
        const previousWorld = view.draftWorld;
        view.draft = runtime.state.config ? structuredClone(runtime.state.config) : null;
        view.draftWorld = runtime.state.selectedWorld;
        if (previousWorld !== runtime.state.selectedWorld)
            view.selection.clear();
        if (!view.draft)
            return;
        for (const entry of sortedEntries(runtime.state.worldData)) {
            const uid = String(entry.uid);
            view.draft.entries[uid] ??= { mode: 'native', aiDescription: '' };
            if (!isAiModeEligible(entry))
                view.draft.entries[uid].mode = 'native';
        }
    }

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

    function renderEntry(entry) {
        const uid = String(entry.uid);
        const configured = view.draft.entries[uid];
        const compatibility = detectPromptTemplateEntry(entry);
        const trigger = worldInfoTriggerType(entry);
        const eligible = isAiModeEligible(entry);
        const check = h('input', { type: 'checkbox', className: 'world-ai-entry-check', checked: view.selection.has(uid), disabled: !eligible });
        check.addEventListener('change', () => {
            if (check.checked)
                view.selection.add(uid);
            else
                view.selection.delete(uid);
            render();
        });
        const mode = h('select');
        mode.append(
            h('option', { value: 'native', text: '原生激活' }),
            h('option', { value: 'ai', text: 'AI 判断' }),
        );
        mode.value = eligible ? configured.mode : 'native';
        mode.disabled = !eligible;
        mode.addEventListener('change', () => {
            configured.mode = mode.value;
            render();
        });
        const description = h('textarea', {
            value: configured.aiDescription,
            placeholder: '只描述该条目在什么情况下应该激活；不会把世界书正文发送给模型。',
            rows: 3,
            disabled: !eligible,
        });
        description.addEventListener('input', () => { configured.aiDescription = description.value; });
        const showDescription = configured.mode === 'ai' || configured.aiDescription.trim() !== '';
        return h('article', { className: 'world-ai-entry' },
            h('div', { className: 'world-ai-entry-heading' },
                h('label', { className: 'world-ai-entry-select' },
                    check,
                    h('div', {},
                        h('strong', { text: entry.comment || `条目 ${uid}` }),
                        h('small', { text: `UID ${uid} · 顺序 ${String(entry.order ?? 0)}${entry.group ? ` · 分组 ${entry.group}` : ''} · ${TRIGGER_LABELS[trigger] ?? trigger}` }),
                    ),
                ),
                mode,
            ),
            !eligible && !compatibility.detected
                ? callout(`该条目为${TRIGGER_LABELS[trigger] ?? trigger}，本功能暂不处理，保持原生。`, 'warning')
                : null,
            compatibility.detected
                ? callout(`检测到 ${compatibility.reasons.join('、')}，该条目固定交给 Prompt Template / 宿主原生链路。`, 'warning')
                : null,
            showDescription && eligible ? description : null,
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
                ? `${world.configuredAiEntries} 个 AI 配置均因模板语法或非关键词触发固定走原生链路`
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

    function presetSection() {
        const activeName = runtime.state.presetOptions.find(preset => preset.id === runtime.state.activePresetId)?.name;
        const select = h('select');
        select.append(h('option', { value: '', text: activeName ? `跟随当前预设（${activeName}）` : '跟随当前预设（未设置）' }));
        for (const preset of runtime.state.presetOptions)
            select.append(h('option', { value: preset.id, text: `${preset.name}（${preset.model}）` }));
        select.value = runtime.state.presetId ?? '';
        select.addEventListener('change', () => {
            void run(async () => { await runtime.selectPreset(select.value); });
        });
        const section = h('section', { className: 'world-ai-model' },
            h('div', { className: 'world-ai-section-heading' },
                h('div', {},
                    h('h3', { text: '模型预设' }),
                    h('p', { text: 'AI 激活判定与一键填充共用所选预设；密钥仍由“设置 / 模型服务”管理。' }),
                ),
            ),
            h('label', { className: 'world-ai-preset-select' }, h('span', { text: '预设' }), select),
        );
        if (runtime.state.presetError)
            section.append(callout(`模型预设读取失败：${runtime.state.presetError}`, 'warning'));
        return section;
    }

    function visibleEligibleUids() {
        const needle = view.filter.trim().toLowerCase();
        return sortedEntries(runtime.state.worldData)
            .filter(entry => isAiModeEligible(entry))
            .filter(entry => !needle
                || String(entry.comment ?? '').toLowerCase().includes(needle)
                || String(entry.uid).toLowerCase().includes(needle))
            .map(entry => String(entry.uid));
    }

    function selectAllEligible() {
        for (const uid of visibleEligibleUids())
            view.selection.add(uid);
        render();
    }

    function invertSelection() {
        for (const uid of visibleEligibleUids()) {
            if (view.selection.has(uid))
                view.selection.delete(uid);
            else
                view.selection.add(uid);
        }
        render();
    }

    function batchSetAi() {
        let converted = 0;
        let skipped = 0;
        for (const uid of view.selection) {
            const entry = runtime.state.worldData.entries[uid];
            const configured = view.draft.entries[uid];
            if (!entry || !configured || !isAiModeEligible(entry) || !configured.aiDescription.trim()) {
                skipped += 1;
                continue;
            }
            configured.mode = 'ai';
            converted += 1;
        }
        view.notice = `已设为 AI 判断 ${converted} 个。${skipped ? `跳过 ${skipped} 个（无描述或不符合批量条件）。` : ''}`;
        view.noticeKind = converted ? '' : 'warning';
        render();
    }

    function batchSetNative() {
        let count = 0;
        for (const uid of view.selection) {
            const configured = view.draft.entries[uid];
            if (!configured)
                continue;
            configured.mode = 'native';
            configured.aiDescription = '';
            count += 1;
        }
        view.notice = count ? `已将 ${count} 个条目重置为原生激活。` : '没有可重置的条目。';
        view.noticeKind = count ? '' : 'warning';
        render();
    }

    function beginFill() {
        view.fillUids = [...view.selection];
        if (!view.fillUids.length)
            return;
        view.fillConfirm = true;
        render();
    }

    function cancelFillConfirm() {
        view.fillConfirm = false;
        render();
    }

    async function runFill() {
        const uids = view.fillUids;
        view.fillConfirm = false;
        view.notice = '';
        view.noticeKind = '';
        render();
        try {
            const result = await runtime.fillDescriptions(uids);
            for (const item of result.descriptions) {
                const configured = view.draft.entries[item.uid];
                if (configured)
                    configured.aiDescription = item.description;
            }
            view.notice = result.failures.length
                ? `已为 ${result.descriptions.length} 个条目生成描述；${result.failures.length} 个失败（${summarizeFailures(result.failures)}）已跳过。`
                : `已为 ${result.descriptions.length} 个条目生成描述。`;
            view.noticeKind = result.failures.length ? 'warning' : '';
        }
        catch (error) {
            view.notice = error instanceof Error ? error.message : String(error);
            view.noticeKind = 'danger';
        }
        render();
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
                    h('p', { text: '只处理关键词触发条目；AI 判断直接替代关键词触发，常驻与向量触发条目保持原生。' }),
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
            root.append(callout(view.notice, view.noticeKind));
        root.append(callout(runtime.state.status));
        root.append(activeWorldsSection());
        root.append(presetSection());

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
            root.append(h('div', { className: 'world-ai-batch-bar' },
                h('span', { className: 'world-ai-batch-count', text: `已选 ${view.selection.size} 项` }),
                h('div', { className: 'world-ai-batch-actions' },
                    actionButton('全选', selectAllEligible, { className: 'secondary' }),
                    actionButton('反选', invertSelection, { className: 'secondary' }),
                    actionButton('清空选择', () => { view.selection.clear(); render(); }, { className: 'secondary', disabled: !view.selection.size }),
                    actionButton('设为 AI 判断', batchSetAi, { className: 'secondary', disabled: !view.selection.size }),
                    actionButton('设为原生激活', batchSetNative, { className: 'secondary', disabled: !view.selection.size }),
                    actionButton('一键填充描述', beginFill, { className: 'primary', disabled: !view.selection.size }),
                ),
            ));
            if (view.fillConfirm)
                root.append(callout(`将把 ${view.fillUids.length} 个关键词触发条目的标题、关键词与正文发送给所选模型以生成激活描述。正文不会写入 TT-Toolkit 日志；生成后保留当前模式。`, 'warning'));
            if (runtime.state.fillBusy) {
                const progress = runtime.state.fillProgress;
                root.append(callout(`正在为第 ${progress.done}/${progress.total} 个条目生成激活描述（当前 UID ${progress.uid}）…`));
                root.append(h('div', { className: 'actions' },
                    actionButton('取消生成', () => runtime.cancelFill(), { className: 'secondary' }),
                ));
            }
            root.append(h('div', { className: 'world-ai-entries' }, entries.map(renderEntry)));
            root.append(h('div', { className: 'actions' },
                view.fillConfirm
                    ? actionButton('开始生成', () => { void runFill(); }, { className: 'primary' })
                    : null,
                view.fillConfirm
                    ? actionButton('取消', cancelFillConfirm, { className: 'secondary' })
                    : null,
                actionButton('保存世界书 AI 配置', () => {
                    void run(async () => {
                        await runtime.saveConfig(structuredClone(view.draft));
                        syncDraft();
                    });
                }, { className: 'primary', disabled: runtime.state.busy || runtime.state.fillBusy }),
            ));
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