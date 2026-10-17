import { actionButton, callout, h } from '../../ui/dom.js';
import { confirmDanger } from '../../ui/confirm.js';
import {
    detectPromptTemplateEntry, isAiModeEligible, parseConfigExchange,
    parseWorldInfoAiConfig, parseWorldInfoAiFeatureSettings, worldInfoTriggerType,
} from './schema.js';

const SOURCE_LABELS = { global: '全局', character: '角色', chat: '聊天', persona: 'Persona' };
const TRIGGER_LABELS = { keyword: '关键词', constant: '常驻', vectorized: '向量' };
const clone = value => structuredClone(value);
const snapshot = value => JSON.stringify(value);
const textError = error => error instanceof Error ? error.message : '操作失败，请重试。';
const entryTitle = entry => entry.comment || `条目 ${entry.uid}`;
function sortedEntries(data) {
    return Object.values(data?.entries ?? {}).filter(entry => entry && typeof entry === 'object')
        .sort((a, b) => Number(a.displayIndex ?? 0) - Number(b.displayIndex ?? 0)
            || Number(b.order ?? 0) - Number(a.order ?? 0));
}

export function mountWorldInfoAiPage(target, props) {
    const runtime = props.runtime;
    const view = {
        enabled: props.enabled, draft: null, draftWorld: '', data: null, saved: '',
        settings: null, savedSettings: '', filter: '', scope: 'mounted', selection: new Set(),
        notice: '', noticeKind: '', preview: null, batchThreshold: '0.7',
        working: false, switching: false, entryErrors: {}, settingsErrors: {},
    };
    let disposed = false;
    let pendingFocus = null;
    const dirty = () => Boolean(view.draft && snapshot(view.draft) !== view.saved);
    const settingsDirty = () => Boolean(view.settings && snapshot(view.settings) !== view.savedSettings);
    function updateDirtyIndicators() {
        const configStatus = target.querySelector('[data-draft-status="config"]');
        const settingsStatus = target.querySelector('[data-draft-status="settings"]');
        if (configStatus) configStatus.textContent = dirty() ? '条目配置未保存' : '条目配置已保存 · 下轮生效';
        if (settingsStatus) settingsStatus.textContent = settingsDirty() ? '设置未保存' : '设置已保存 · 下轮生效';
    }
    const locked = () => view.working || runtime.state.busy;
    const confirm = options => confirmDanger(target.ownerDocument, options);
    const button = (label, task, options = {}) => actionButton(label, () => { void run(task); }, {
        className: 'secondary', disabled: locked(), dataset: { control: `button-${label}` }, ...options,
    });
    const field = (label, node, error = '') => h('label', { className: 'world-ai-field' },
        h('span', { text: label }), node,
        error ? h('small', { className: 'world-ai-field-error', text: error, attrs: { role: 'alert' } }) : null);
    const control = (tag, key, properties = {}) => h(tag, { ...properties, dataset: { control: key } });
    const notice = (message, kind = '') => { view.notice = message; view.noticeKind = kind; };

    function loadDraft() {
        const state = runtime.state;
        view.draft = state.config ? clone(state.config) : null;
        view.draftWorld = state.selectedWorld;
        view.data = state.worldData ? clone(state.worldData) : null;
        view.selection.clear();
        view.preview = null;
        view.entryErrors = {};
        if (view.draft) {
            view.draft.entries = Object.assign(Object.create(null), view.draft.entries);
            for (const entry of sortedEntries(view.data)) {
                const uid = String(entry.uid);
                view.draft.entries[uid] ??= { mode: 'native', aiDescription: '', threshold: null };
                if (!isAiModeEligible(entry)) view.draft.entries[uid].mode = 'native';
            }
        }
        view.saved = snapshot(view.draft);
    }
    function loadSettings() {
        view.settings = runtime.state.settings ? clone(runtime.state.settings) : null;
        view.savedSettings = snapshot(view.settings);
        view.settingsErrors = {};
    }
    async function run(task) {
        if (disposed) return;
        try { await task(); }
        catch (error) { notice(textError(error), 'warning'); }
        if (!disposed) render();
    }
    async function commit(task) {
        if (disposed || locked()) return;
        view.working = true;
        render();
        try { await task(); }
        finally { view.working = false; }
    }
    async function switchWorld(name) {
        if (name === view.draftWorld && name === runtime.state.selectedWorld) return;
        if (dirty() && !await confirm({ title: '放弃未保存的条目配置？',
            message: `切换世界书将放弃“${view.draftWorld}”的草稿。已保存配置不受影响。`, confirmLabel: '放弃并切换' })) return;
        await commit(async () => {
            view.switching = true;
            try {
                await runtime.selectWorld(name);
                loadDraft();
                view.filter = '';
            }
            finally { view.switching = false; }
        });
    }
    function visibleEntries() {
        const needle = view.filter.trim().toLowerCase();
        return sortedEntries(view.data).filter(entry => !needle
            || String(entryTitle(entry)).toLowerCase().includes(needle)
            || String(view.draft?.entries[String(entry.uid)]?.aiDescription ?? '').toLowerCase().includes(needle));
    }
    function validateEntries() {
        view.entryErrors = {};
        for (const entry of sortedEntries(view.data)) {
            const uid = String(entry.uid);
            const config = view.draft.entries[uid];
            const errors = {};
            if (config.mode === 'ai' && !config.aiDescription.trim()) errors.condition = '接管条件不能为空。';
            if (config.threshold !== null && (typeof config.threshold !== 'number'
                || !Number.isFinite(config.threshold) || config.threshold < 0 || config.threshold > 1))
                errors.threshold = '独立阈值须为 0–1；选择继承可清除。';
            if (Object.keys(errors).length) view.entryErrors[uid] = errors;
        }
        if (Object.keys(view.entryErrors).length) throw new Error('请修正条目字段；草稿已保留，尚未保存。');
        return parseWorldInfoAiConfig(view.draft);
    }
    function requireCurrentWorld() {
        if (view.draftWorld !== runtime.state.selectedWorld)
            throw new Error('编辑目标已变化，请重新选择世界书后操作；草稿已保留。');
    }
    async function saveConfig() {
        requireCurrentWorld();
        const config = validateEntries();
        const submitted = snapshot(view.draft);
        await commit(async () => {
            await runtime.saveConfig(clone(config));
            if (snapshot(view.draft) === submitted) view.draft = config;
            view.saved = snapshot(config);
            notice('世界书配置已保存，下轮生效。');
        });
    }
    async function saveSettings() {
        view.settingsErrors = {};
        const settings = view.settings;
        if (typeof settings.threshold !== 'number' || !Number.isFinite(settings.threshold) || settings.threshold < 0 || settings.threshold > 1)
            view.settingsErrors.threshold = '全局阈值须为 0–1。';
        if (!Number.isSafeInteger(settings.historyRounds) || settings.historyRounds < 1 || settings.historyRounds > 100)
            view.settingsErrors.historyRounds = '最近轮数须为 1–100 的整数。';
        if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 120000)
            view.settingsErrors.timeoutMs = '超时须为 1000–120000 毫秒的整数。';
        if (Object.keys(view.settingsErrors).length) throw new Error('请修正设置字段；输入已保留。');
        const parsed = parseWorldInfoAiFeatureSettings(settings);
        await commit(async () => {
            await runtime.saveSettings(clone(parsed));
            view.savedSettings = snapshot(parsed);
            notice('全局设置已保存，下轮生效。');
        });
    }
    async function test(draft = false) {
        if (runtime.state.testBusy) return;
        if (draft) requireCurrentWorld();
        const config = draft ? clone(validateEntries()) : undefined;
        const selectedPreset = runtime.state.settings?.presetId ?? runtime.state.activePresetId;
        const preset = runtime.state.presetOptions?.find(item => item.id === selectedPreset);
        if (!await confirm({ title: draft ? '测试未保存草稿？' : '测试已保存配置？',
            message: `将发送当前聊天的最近上下文、常驻背景正文及接管条件到所选模型服务 URL（在“设置 / 模型服务”查看），模型：${preset?.model ?? '未选择'}。可能产生费用；测试不注入正文，不自动保存，不在后台重复测试。${draft ? `仅“${view.draftWorld}”使用本次未保存草稿。` : '按当前聊天已挂载世界书的已保存配置测试；未保存输入不参与。'}`,
            confirmLabel: '确认发送并测试', confirmClass: 'primary' })) return;
        if (disposed) return;
        notice(draft ? '正在测试未保存草稿（不保存、不注入）。' : '正在测试已保存配置（不注入）。');
        render();
        if (draft) requireCurrentWorld();
        if (draft) await runtime.testConditions(config);
        else await runtime.testConditions();
        notice(draft ? '未保存草稿测试已结束；请查看最近判定。' : '已保存配置测试已结束；请查看最近判定。');
    }
    function batchMode(mode) {
        let skipped = 0;
        for (const uid of view.selection) {
            const item = view.draft.entries[uid];
            if (mode === 'ai' && !item.aiDescription.trim()) { skipped++; continue; }
            item.mode = mode;
        }
        notice(`已更新 ${view.selection.size - skipped} 项草稿；条件保留。${skipped ? `跳过 ${skipped} 项空条件。` : ''}`);
    }
    function batchThreshold(clear) {
        const value = clear ? null : view.batchThreshold.trim() === '' ? NaN : Number(view.batchThreshold);
        if (!clear && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error('批量阈值须为 0–1。');
        for (const uid of view.selection) view.draft.entries[uid].threshold = value;
        notice(`已更新 ${view.selection.size} 项草稿阈值，尚未保存。`);
    }
    async function importFile(file) {
        if (!file) return;
        const world = view.draftWorld;
        const text = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('文件读取失败，请重选。'));
            reader.readAsText(file);
        });
        const config = parseConfigExchange(text);
        if (world !== view.draftWorld) throw new Error('世界书已切换，请重新导入。');
        const eligible = new Set(sortedEntries(view.data).filter(isAiModeEligible).map(entry => String(entry.uid)));
        const matches = Object.entries(config.entries).filter(([uid]) => eligible.has(uid));
        view.preview = { world, matches, skipped: Object.keys(config.entries).length - matches.length };
        notice('导入已解析；请核对 UID 对应的条目与条件，再应用到草稿。');
    }

    function settingsSection() {
        const section = h('section', { className: 'world-ai-panel' }, h('h3', { text: '全局设置' }));
        if (runtime.state.settingsError) section.append(callout(`设置不可用：${runtime.state.settingsError}。请显式重置后重新配置。`, 'warning'));
        if (!view.settings || runtime.state.settingsError) {
            section.append(button('重置全局设置', resetSettings));
            return section;
        }
        const settings = view.settings;
        const activeName = runtime.state.presetOptions?.find(item => item.id === runtime.state.activePresetId)?.name;
        const preset = control('select', 'preset', { disabled: locked() });
        preset.append(h('option', { value: '', text: `跟随当前 System One 预设（${activeName ?? '未设置'}）` }));
        for (const item of runtime.state.presetOptions ?? []) preset.append(h('option', { value: item.id, text: `${item.name}（${item.model}）` }));
        if (settings.presetId && !runtime.state.presetOptions?.some(item => item.id === settings.presetId))
            preset.append(h('option', { value: settings.presetId, text: '已选预设不可用，请重新选择' }));
        preset.value = settings.presetId ?? '';
        preset.addEventListener('change', () => { settings.presetId = preset.value || null; render(); });
        section.append(h('div', { className: 'world-ai-savebar' },
            button(view.working ? '处理中…' : '保存全局设置', saveSettings, { className: 'primary' }),
            h('span', { dataset: { draftStatus: 'settings' }, text: settingsDirty() ? '设置未保存' : '设置已保存 · 下轮生效' }),
            button('重置全局设置', resetSettings),
        ), field('System One 兼容预设', preset));
        const numberFields = [
            ['threshold', '全局概率阈值（0–1）', 0, 1, 'any'],
            ['historyRounds', '最近聊天轮数（1–100）', 1, 100, '1'],
            ['timeoutMs', '请求超时（毫秒）', 1000, 120000, '1'],
        ];
        section.append(h('div', { className: 'world-ai-grid' }, numberFields.map(([key, label, min, max, step]) => {
            const input = control('input', `setting-${key}`, { type: 'number', value: settings[key], min, max, step, disabled: locked(),
                attrs: { 'aria-invalid': Boolean(view.settingsErrors[key]) } });
            input.addEventListener('input', () => { settings[key] = input.value === '' ? '' : Number(input.value); updateDirtyIndicators(); });
            return field(label, input, view.settingsErrors[key]);
        })));
        section.append(h('p', { className: 'world-ai-help', text: '只选择 Jev / System One 兼容决策服务。连接地址与密钥在“设置 / 模型服务”管理；密钥不进入导出文件。' }));
        if (runtime.state.presetError) section.append(callout(`预设不可用：${runtime.state.presetError}`, 'warning'));
        return section;
    }
    async function resetSettings() {
        if (!await confirm({ title: '重置全局决策设置？', message: '将清除决策激活的预设选择、阈值、轮数和超时设置，恢复默认值。不会删除模型服务预设或世界书配置；此操作无法撤销。', confirmLabel: '重置设置' })) return;
        await commit(async () => { await runtime.resetSettings(); loadSettings(); notice('全局设置已重置。'); });
    }
    async function resetConfig() {
        requireCurrentWorld();
        if (!await confirm({ title: `清除“${view.draftWorld || runtime.state.selectedWorld}”的决策配置？`,
            message: '仅清除该世界书的工具箱决策激活配置与本页草稿，条目正文和宿主原生字段不变。条件与独立阈值无法撤销，建议先自行导出备份。', confirmLabel: '清除决策配置' })) return;
        requireCurrentWorld();
        await commit(async () => { await runtime.resetConfig(); loadDraft(); notice('世界书决策配置已重置。'); });
    }
    function activeSection() {
        const section = h('section', { className: 'world-ai-panel' }, h('h3', { text: '当前聊天挂载世界书' }));
        if (runtime.state.activeWorldsError) section.append(callout(`挂载关系读取失败：${runtime.state.activeWorldsError}。可切换“全部世界书”独立配置。`, 'warning'));
        const worlds = runtime.state.activeWorlds ?? [];
        if (!worlds.length && !runtime.state.activeWorldsError) section.append(h('p', { className: 'empty-state', text: '当前聊天没有挂载世界书。可切换全部世界书配置；未挂载的书不会参与当前聊天判定。' }));
        section.append(h('div', { className: 'world-ai-grid' }, worlds.map(world => h('article', { className: 'world-ai-active-card' },
            h('strong', { text: `${SOURCE_LABELS[world.source] ?? world.source ?? ''} · ${world.name}` }),
            h('small', { text: world.error ? `读取失败：${world.error}` : `${world.routerEnabled ? '接管已启用' : '接管已暂停'} · 可判定 ${world.eligibleAiEntries ?? 0} / 已配置 ${world.configuredAiEntries ?? 0} 项` }),
        ))));
        return section;
    }
    function worldToolbar() {
        const scope = control('select', 'scope', { disabled: locked() });
        scope.append(h('option', { value: 'mounted', text: '当前聊天挂载世界书' }), h('option', { value: 'all', text: '全部世界书' }));
        scope.value = view.scope;
        scope.addEventListener('change', () => { view.scope = scope.value; render(); });
        const names = view.scope === 'all' ? runtime.state.worldNames : [...new Set((runtime.state.activeWorlds ?? []).map(world => world.name))];
        const world = control('select', 'world', { disabled: locked() });
        world.append(h('option', { value: '', text: names?.length ? '请选择世界书' : '此范围没有世界书' }));
        for (const name of names ?? []) world.append(h('option', { value: name, text: name }));
        // A filtered-out draft remains visible until the user explicitly switches.
        if (view.draftWorld && !names?.includes(view.draftWorld)) world.append(h('option', { value: view.draftWorld, text: `${view.draftWorld}（当前编辑，不在此范围）` }));
        world.value = view.draftWorld || runtime.state.selectedWorld || '';
        world.addEventListener('change', () => { const name = world.value; if (name) void run(() => switchWorld(name)); else render(); });
        return h('div', { className: 'world-ai-toolbar' }, field('显示范围', scope), field('编辑世界书', world),
            button('刷新世界书', async () => { await runtime.refreshWorlds(); notice('世界书列表已刷新；本页草稿保留。'); }));
    }
    function renderEntry(entry) {
        const uid = String(entry.uid);
        const config = view.draft.entries[uid];
        const eligible = isAiModeEligible(entry);
        const errors = view.entryErrors[uid] ?? {};
        const check = control('input', `select-${uid}`, { type: 'checkbox', checked: view.selection.has(uid), disabled: !eligible || locked() });
        check.addEventListener('change', () => { if (check.checked) view.selection.add(uid); else view.selection.delete(uid); render(); });
        const mode = control('select', `mode-${uid}`, { disabled: !eligible || locked() });
        mode.append(h('option', { value: 'native', text: '原生激活 / 暂停接管' }), h('option', { value: 'ai', text: '决策接管' }));
        mode.value = eligible ? config.mode : 'native';
        mode.addEventListener('change', () => { config.mode = mode.value; render(); });
        const condition = control('textarea', `condition-${uid}`, { value: config.aiDescription, rows: 3, disabled: !eligible || locked(),
            placeholder: '例如：当前话题涉及天气、下雨或降水。条件由你填写，不会自动生成。', attrs: { 'aria-invalid': Boolean(errors.condition) } });
        condition.addEventListener('input', () => { config.aiDescription = condition.value; updateDirtyIndicators(); });
        const inherit = control('input', `inherit-${uid}`, { type: 'checkbox', checked: config.threshold === null, disabled: !eligible || locked() });
        inherit.addEventListener('change', () => { config.threshold = inherit.checked ? null : view.settings?.threshold ?? 0.7; render(); });
        const threshold = control('input', `threshold-${uid}`, { type: 'number', min: 0, max: 1, step: 'any', value: config.threshold ?? '',
            disabled: !eligible || locked(), attrs: { 'aria-invalid': Boolean(errors.threshold) } });
        threshold.addEventListener('input', () => { config.threshold = threshold.value === '' ? '' : Number(threshold.value); updateDirtyIndicators(); });
        const template = detectPromptTemplateEntry(entry);
        const card = h('article', { className: 'world-ai-entry', dataset: { uid } },
            h('div', { className: 'world-ai-entry-heading' },
                h('label', { className: 'world-ai-entry-select' }, check,
                    h('div', {}, h('strong', { text: entryTitle(entry) }), h('small', { text: `UID ${uid} · ${TRIGGER_LABELS[worldInfoTriggerType(entry)]} · ${eligible && config.mode === 'ai' ? '决策接管（草稿）' : '原生激活'}` }))),
                field('激活方式', mode)),
            !eligible ? callout(template.detected ? 'Prompt Template 模板条目固定走原生链路，不参与决策接管。' : '条目包含 dont_activate 或必要字段无效，保持原生；可查看正文。', 'warning') : null,
            field('接管条件', condition, errors.condition),
            h('div', { className: 'world-ai-threshold' }, h('label', {}, inherit, h('span', { text: `继承已保存全局阈值（${runtime.state.settings?.threshold ?? '不可用'}）` })),
                config.threshold !== null ? field('独立概率阈值（0–1）', threshold, errors.threshold) : null),
            h('details', { dataset: { detail: `body-${uid}` } }, h('summary', { text: '原正文（只读）' }),
                h('pre', { className: 'world-ai-body', text: typeof entry.content === 'string' ? entry.content : '正文不可读取：字段不是字符串。' })),
        );
        return card;
    }
    function importPreview() {
        const preview = view.preview;
        if (!preview) return null;
        return h('section', { className: 'world-ai-import' }, h('h4', { text: '导入预览 · 尚未应用' }),
            h('p', { text: `仅按 UID 合并到“${preview.world}”草稿：匹配 ${preview.matches.length} 项，跳过 ${preview.skipped} 项未知 UID 或不可接管条目。UID 相同不代表内容相同，请核对名称与条件。不会改变世界书启用开关，不会自动保存。` }),
            h('div', { className: 'world-ai-preview-list' }, preview.matches.map(([uid, config]) => h('article', {},
                h('strong', { text: `UID ${uid} · ${entryTitle(sortedEntries(view.data).find(entry => String(entry.uid) === uid))}` }),
                h('p', { text: config.aiDescription || '（空条件）' }),
                h('small', { text: `${config.mode === 'ai' ? '决策接管' : '原生激活'} · 阈值 ${config.threshold ?? '继承全局'}` })))),
            h('div', { className: 'actions' }, button('应用匹配项到草稿', () => {
                if (preview.world !== view.draftWorld) throw new Error('导入目标已变化，请重新导入。');
                for (const [uid, config] of preview.matches) view.draft.entries[uid] = clone(config);
                view.preview = null;
                notice('导入已合并到草稿，尚未保存。请检查后保存。');
            }, { disabled: locked() || !preview.matches.length, className: 'primary' }), button('取消导入', () => { view.preview = null; })),
        );
    }
    function entriesSection() {
        const section = h('section', { className: 'world-ai-management' }, h('h3', { text: '条目管理' }), worldToolbar());
        if (!view.draft || !view.data) {
            section.append(callout(runtime.state.busy ? '正在读取世界书…' : runtime.state.error ? '世界书配置无法读取。可重试，或显式重置该书决策配置；原正文不会被修改。' : '请选择世界书开始配置。'));
            if (runtime.state.selectedWorld) section.append(button('重置当前世界书决策配置', resetConfig));
            return section;
        }
        const enabled = control('input', 'world-enabled', { type: 'checkbox', checked: view.draft.enabled, disabled: locked() });
        enabled.addEventListener('change', () => { view.draft.enabled = enabled.checked; render(); });
        const search = control('input', 'search', { type: 'search', value: view.filter, placeholder: '搜索标题 / 接管条件' });
        search.addEventListener('input', () => { view.filter = search.value; render(); });
        const file = control('input', 'import', { type: 'file', accept: '.json,application/json', disabled: locked() });
        file.addEventListener('change', () => { const selected = file.files?.[0]; void run(() => importFile(selected)); });
        const entries = visibleEntries();
        const visibleSelected = entries.filter(entry => view.selection.has(String(entry.uid))).length;
        const batch = control('input', 'batch-threshold', { type: 'number', min: 0, max: 1, step: 'any', value: view.batchThreshold, disabled: locked() });
        batch.addEventListener('input', () => { view.batchThreshold = batch.value; });
        section.append(h('div', { className: 'world-ai-savebar' },
            button(view.working ? '处理中…' : '保存世界书配置', saveConfig, { className: 'primary' }),
            h('span', { dataset: { draftStatus: 'config' }, text: dirty() ? '条目配置未保存' : '条目配置已保存 · 下轮生效' }),
            h('label', {}, enabled, h('span', { text: '此书接管启用（草稿）' }))),
        h('p', { className: 'world-ai-help', text: `配置存储：${runtime.state.storageBackend ?? '未知'}。常驻、向量、关键词条目均可配置；暂停接管保留条件。实际注入仍由宿主约束决定。` }),
        h('div', { className: 'world-ai-toolbar' }, field('搜索条目', search),
            button('导出当前草稿配置', async () => { const config = validateEntries(); await runtime.exportConfig(clone(config)); notice('已导出决策配置，不包含模型密钥。'); }),
            field('导入配置文件', file), button('重置当前世界书决策配置', resetConfig)),
        importPreview() ?? '',
        h('div', { className: 'world-ai-batch' },
            h('strong', { text: `已选 ${view.selection.size} 项${view.selection.size > visibleSelected ? `（${view.selection.size - visibleSelected} 项被筛选隐藏，批量操作仍包含）` : ''}` }),
            h('div', { className: 'actions' },
                button('全选筛选结果', () => { for (const entry of entries.filter(isAiModeEligible)) view.selection.add(String(entry.uid)); }),
                button('清空选择', () => { view.selection.clear(); }, { disabled: locked() || !view.selection.size }),
                button('批量启用接管', () => batchMode('ai'), { disabled: locked() || !view.selection.size }),
                button('批量暂停接管', () => batchMode('native'), { disabled: locked() || !view.selection.size })),
            h('div', { className: 'world-ai-toolbar' }, field('批量独立阈值（0–1）', batch),
                button('设置所选阈值', () => batchThreshold(false), { disabled: locked() || !view.selection.size }),
                button('清除所选阈值（继承）', () => batchThreshold(true), { disabled: locked() || !view.selection.size }))),
        h('p', { className: 'world-ai-help', text: `显示 ${entries.length} / ${sortedEntries(view.data).length} 项；批量操作只更新草稿，不覆盖条件。` }),
        h('div', { className: 'world-ai-entries' }, entries.length ? entries.map(renderEntry)
            : h('p', { className: 'empty-state', text: sortedEntries(view.data).length ? '没有匹配标题或条件的条目。' : '该世界书没有条目。' })));
        return section;
    }
    function roundsSection() {
        const section = h('section', { className: 'world-ai-panel' }, h('h3', { text: '最近判定（有界内存）' }),
            h('p', { className: 'world-ai-help', text: '仅显示本次运行的最近轮次，不持久化聊天正文。概率通过不保证最终注入；宿主预算、分组等约束仍会影响结果。' }),
            h('div', { className: 'actions' },
                button('测试已保存配置', () => test(), { disabled: locked() || runtime.state.testBusy || Boolean(runtime.state.settingsError) }),
                button('测试本书未保存草稿', () => test(true), { disabled: locked() || runtime.state.testBusy || !view.draft || Boolean(runtime.state.settingsError) }),
                runtime.state.testBusy ? actionButton('取消测试', () => { void run(() => runtime.cancelTest()); }, { className: 'secondary' }) : null,
                button('清除判定缓存', async () => { await runtime.clearCache(); notice('判定缓存已清除。'); }, { disabled: locked() || runtime.state.testBusy }),
                button('清除最近判定', () => runtime.clearRounds())),
        );
        if (runtime.state.testBusy) section.append(callout('测试请求进行中，可取消；不会注入正文。'));
        const rounds = (runtime.state.rounds ?? []).slice(-50).reverse();
        const list = h('div', { className: 'world-ai-round-list' });
        if (!rounds.length) section.append(h('p', { className: 'empty-state', text: '尚无判定记录。只有生成或明确确认的手动测试会请求模型。' }));
        for (const [index, round] of rounds.entries()) {
            const details = h('details', { dataset: { detail: `round-${round.createdAt}-${index}` } },
                h('summary', { text: `${round.type === 'test' ? '手动测试（不注入）' : '生成判定'} · ${round.createdAt ? new Date(round.createdAt).toLocaleString() : ''} · 候选 ${round.candidateCount ?? 0} / 通过 ${round.selectedCount ?? 0} · 请求 ${round.requestCount ?? 0}${round.cached ? ' · 缓存命中' : ''} · ${round.outcome ?? ''}` }));
            if (round.usage) details.append(h('p', { className: 'world-ai-help', text: `用量：输入 ${round.usage.input_tokens ?? round.usage.inputTokens ?? round.usage.prompt_tokens ?? '—'} / 输出 ${round.usage.output_tokens ?? round.usage.outputTokens ?? round.usage.completion_tokens ?? '—'}` }));
            details.append(h('div', { className: 'world-ai-results' }, (round.results ?? []).map(result => h('article', {},
                h('strong', { text: `${result.worldName} · ${result.title || `UID ${result.uid}`}` }),
                h('span', { text: `概率 ${typeof result.probability === 'number' ? result.probability.toFixed(3) : '未知'} / 阈值 ${result.threshold ?? '未知'} · ${result.passed ? '通过' : '未通过'}` }),
                h('span', { text: result.injected === true ? '最终已注入' : result.injected === false ? '最终未注入' : round.type === 'test' ? '测试：不注入' : '最终注入状态未知' }),
            ))));
            list.append(details);
        }
        section.append(list);
        return section;
    }

    function render() {
        if (disposed) return;
        // Stable keys restore focus, caret, scroll and disclosures across runtime updates.
        const focused = target.contains(target.ownerDocument.activeElement) ? target.ownerDocument.activeElement : null;
        const focusedKey = focused?.dataset.control;
        if (focusedKey) pendingFocus = { key: focusedKey,
            caret: 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null };
        const canRestore = focused || target.ownerDocument.activeElement === target.ownerDocument.body;
        const { key, caret } = canRestore && pendingFocus ? pendingFocus : {};
        const openDetails = new Set([...target.querySelectorAll('details[open]')].map(node => node.dataset.detail));
        const entryScroll = target.querySelector('.world-ai-entries')?.scrollTop ?? 0;
        const roundScroll = target.querySelector('.world-ai-round-list')?.scrollTop ?? 0;
        const pageScroll = target.parentElement?.scrollTop;
        const master = control('input', 'master', { type: 'checkbox', checked: view.enabled, disabled: locked() });
        master.addEventListener('change', () => { const next = master.checked; void run(() => commit(async () => { await props.setEnabled(next); view.enabled = next; notice(next ? '决策激活已启用。' : '决策激活已暂停。'); })); });
        const root = h('section', { className: 'feature-page world-ai-page' },
            h('header', { className: 'feature-header' }, h('div', {}, h('p', { className: 'eyebrow', text: '世界书' }),
                h('h2', { text: '决策激活' }), h('p', { text: '使用 Jev / System One 兼容模型判断接管条件的概率；不改写世界书正文。' })),
                h('label', { className: 'master-toggle' }, master, h('span', { text: view.enabled ? '功能已启用' : '功能已暂停' }))),
            !view.enabled ? callout('功能已暂停：生成时不会请求决策模型；仍可编辑配置，手动测试需单独确认。') : null,
            runtime.state.warning ? callout(runtime.state.warning, 'warning') : null,
            runtime.state.error ? callout(runtime.state.error, 'warning') : null,
            view.notice ? h('div', { className: `callout ${view.noticeKind}`, text: view.notice, attrs: { role: 'status' } }) : null,
            runtime.state.status ? h('p', { className: 'world-ai-help', text: runtime.state.status }) : null,
            dirty() && runtime.state.selectedWorld !== view.draftWorld ? callout(`宿主选择已改变；保留“${view.draftWorld}”草稿。请重新选择世界书，确认放弃草稿后继续。`, 'warning') : null,
            activeSection(), settingsSection(), roundsSection(), entriesSection(),
        );
        target.replaceChildren(root);
        for (const details of target.querySelectorAll('details')) details.open = openDetails.has(details.dataset.detail);
        const scroller = target.querySelector('.world-ai-entries');
        if (scroller) scroller.scrollTop = entryScroll;
        const roundScroller = target.querySelector('.world-ai-round-list');
        if (roundScroller) roundScroller.scrollTop = roundScroll;
        if (key) {
            const next = [...target.querySelectorAll('[data-control]')].find(node => node.dataset.control === key);
            if (next && !next.disabled) {
                next.focus({ preventScroll: true });
                if (caret && caret[0] !== null && next.setSelectionRange && ['textarea', 'input'].includes(next.localName)) {
                    try { next.setSelectionRange(...caret); } catch { /* Number fields have no text selection. */ }
                }
                pendingFocus = null;
            }
        }
        if (pageScroll !== undefined) target.parentElement.scrollTop = pageScroll;
    }
    function update() {
        if (disposed) return;
        if (!view.switching && !runtime.state.busy && (!view.draftWorld || !view.draft
            || (view.draftWorld !== runtime.state.selectedWorld && !dirty()))) loadDraft();
        if (!view.settings && runtime.state.settings && !runtime.state.settingsError) loadSettings();
        render();
    }
    loadDraft();
    loadSettings();
    const unsubscribe = runtime.subscribe(update);
    render();
    void run(async () => { await runtime.refreshWorlds(); update(); });
    return () => { disposed = true; unsubscribe(); target.replaceChildren(); };
}
