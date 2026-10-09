import { errorKind, errorMessage, ToolkitError } from '../../kernel/errors.js';
import { worldInfoContractFailureData } from '../../kernel/world-info.js';
import { LlmPresetStore } from '../../kernel/llm-presets.js';
import { LlmTaskService } from '../../kernel/llm-tasks.js';
import {
    createDefaultWorldInfoAiFeatureSettings,
    detectPromptTemplateEntry,
    isAiModeEligible,
    parseWorldInfoAiConfig,
    parseWorldInfoAiFeatureSettings,
    worldEntryKey,
    worldInfoTriggerType,
} from './schema.js';
import {
    chunkFillEntries,
    collectFillEntries,
    fillDescriptionPrompt,
    fillDescriptionSchema,
    FILL_RESPONSE_LENGTH,
    FILL_SYSTEM_PROMPT,
    FILL_TIMEOUT_MS,
    parseFillResponse,
} from './fill.js';
import { activationJsonSchema, applyActivationDecision, parseActivationResponse } from './routing.js';
import { WorldInfoAiConfigStore } from './storage.js';

const MAX_TRANSCRIPT_CHARS = 30_000;
const FEATURE_SETTINGS_KEY = 'world-info-ai-settings-v1';
const WORLD_INFO_CONTRACT_WARNING = '宿主世界书事件结构无效，本轮 AI 决策已丢弃，未修改临时条目；下次生成会重新校验，持续出现请核对宿主版本。';

function messageRole(message) {
    if (message?.is_user)
        return 'user';
    if (message?.is_system)
        return 'system';
    return 'assistant';
}

function expandAiDescription(host, description) {
    if (typeof host?.macroProcess !== 'function')
        return String(description ?? '');
    return String(host.macroProcess(description) ?? description ?? '');
}

export function buildRoutingTranscript(messages, maxChars = MAX_TRANSCRIPT_CHARS) {
    const output = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const text = typeof message?.mes === 'string' ? message.mes : '';
        const remaining = maxChars - used;
        if (remaining <= 0)
            break;
        const content = text.length > remaining ? text.slice(text.length - remaining) : text;
        output.unshift({ index, role: messageRole(message), content });
        used += content.length;
    }
    return output;
}

function routerPrompt(messages, candidates) {
    return JSON.stringify({
        conversation: buildRoutingTranscript(messages),
        candidates: candidates.map(candidate => ({
            id: candidate.id,
            description: candidate.aiDescription,
            priority: candidate.order,
            group: candidate.group,
        })),
    });
}

const SYSTEM_PROMPT = [
    '你是世界书语义路由器。根据 conversation 判断每个 candidate 的 description 是否适用于下一次回复。',
    '只能选择输入中存在的 id；description 是唯一的条目语义来源，不得推测或索取世界书正文。',
    '',
    '【输出格式（必须逐字遵循）】',
    '输出一个 JSON 对象，只包含一个字段 "activate"，值为选中的 id 字符串数组。',
    '格式：{"activate":["条目id","条目id"]}',
    '没有条目适用时输出：{"activate":[]}',
    '',
    '【示例】',
    'conversation 是用户问"外面下雨了要不要带伞"，候选包含 {"id":"world.2","description":"天气、下雨或降水相关情境时激活"}。',
    '输出：{"activate":["world.2"]}',
    '',
    '【禁止】',
    '不要使用代码块、Markdown 标记或任何解释文字，直接输出上面的 JSON 对象。',
].join('\n');

export class WorldInfoAiRuntime {
    constructor(host, log, options = {}) {
        this.host = host;
        this.log = log;
        this.store = options.store ?? new WorldInfoAiConfigStore(host, log);
        this.presets = options.presets ?? new LlmPresetStore(host);
        this.tasks = options.tasks ?? new LlmTaskService(host, options.taskLog ?? log, { presets: this.presets });
        this.mutable = {
            worldNames: [],
            activeWorlds: [],
            activeWorldsError: '',
            selectedWorld: '',
            worldData: null,
            config: null,
            storageBackend: 'default',
            presetId: null,
            activePresetId: null,
            presetOptions: [],
            presetError: '',
            fillBusy: false,
            fillProgress: { done: 0, total: 0, uid: '' },
            busy: false,
            status: '尚未运行 AI 世界书判定。',
            warning: '',
            error: '',
        };
        this.state = this.mutable;
        this.listeners = new Set();
        this.disposers = [];
        this.active = false;
        this.sequence = 0;
        this.pending = null;
        this.taskController = null;
        this.fillController = null;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners)
            listener(this.state);
    }

    async activate() {
        if (this.active)
            return;
        this.active = true;
        this.disposers = [
            this.host.onHostEvent('GENERATION_STARTED', () => this.beginGeneration()),
            this.host.onHostEvent('GENERATION_AFTER_COMMANDS', (type, params, dryRun) => this.routeGeneration(type, params, dryRun)),
            this.host.subscribeWorldInfoEntriesLoaded(
                payload => this.applyPending(payload),
                error => this.onWorldInfoContractError(error),
            ),
            this.host.onHostEvent('GENERATION_ENDED', () => this.clearPending()),
            this.host.onHostEvent('GENERATION_STOPPED', () => this.clearPending()),
            this.host.onHostEvent('CHAT_CHANGED', () => {
                this.clearPending();
                this.cancelFill();
            }),
        ];
        this.log?.info('activated');
        await this.refreshFeatureSettings();
    }

    async deactivate() {
        this.active = false;
        this.sequence += 1;
        this.pending = null;
        this.cancelTask();
        this.cancelFill();
        for (const dispose of this.disposers.splice(0))
            dispose();
        this.log?.info('deactivated');
    }

    beginGeneration() {
        this.cancelTask();
        this.sequence += 1;
        this.pending = null;
    }

    clearPending() {
        this.cancelTask();
        this.sequence += 1;
        this.pending = null;
    }

    cancelTask() {
        this.taskController?.abort();
        this.taskController = null;
    }

    cancelFill() {
        this.fillController?.abort();
        this.fillController = null;
    }

    async refreshFeatureSettings() {
        try {
            const settings = parseWorldInfoAiFeatureSettings(await this.host.globalGet(FEATURE_SETTINGS_KEY));
            const presets = await this.presets.load();
            this.mutable.presetOptions = presets.presets.map(preset => ({ id: preset.id, name: preset.name, model: preset.model }));
            this.mutable.activePresetId = presets.activePresetId;
            let presetId = settings.presetId;
            if (presetId !== null && !presets.presets.some(preset => preset.id === presetId))
                presetId = null;
            this.mutable.presetId = presetId;
            this.mutable.presetError = '';
        }
        catch (error) {
            this.mutable.presetError = errorMessage(error);
            this.log?.error('preset.settings_load_failed', {
                data: { operation: 'preset.settings.load', ...errorKind(error) },
                sensitive: { error },
            });
        }
        this.notify();
    }

    async selectPreset(presetId) {
        const id = presetId === '' || presetId === null ? null : String(presetId);
        try {
            if (id !== null) {
                const settings = await this.presets.load();
                if (!settings.presets.some(preset => preset.id === id))
                    throw new ToolkitError('LLM_PRESET_MISSING', '模型预设不存在或尚未保存。');
            }
            await this.host.globalSet(FEATURE_SETTINGS_KEY, { ...createDefaultWorldInfoAiFeatureSettings(), presetId: id });
            this.mutable.presetId = id;
            this.mutable.status = id
                ? 'AI 激活与一键填充将使用所选模型预设。'
                : 'AI 激活与一键填充将跟随设置页的当前预设。';
            this.notify();
        }
        catch (error) {
            this.log?.error('preset.select_failed', { data: { operation: 'preset.select', ...errorKind(error) }, sensitive: { error } });
            throw error;
        }
    }

    warn(message, kind, sensitive = {}) {
        this.log?.warn('routing.fallback', { data: { operation: 'routing.fallback', kind }, sensitive });
        this.mutable.warning = message;
        this.mutable.status = message;
        this.notify();
    }

    async collectCandidates() {
        const worldNames = this.host.activeWorldInfoNames();
        const loaded = await Promise.all(worldNames.map(async worldName => ({
            worldName,
            loaded: await this.store.load(worldName),
        })));
        const candidates = [];
        const incompatible = [];
        for (const { worldName, loaded: result } of loaded) {
            if (!result.config.enabled)
                continue;
            for (const entry of Object.values(result.data.entries ?? {})) {
                const configured = result.config.entries[String(entry?.uid)];
                if (configured?.mode !== 'ai')
                    continue;
                const compatibility = detectPromptTemplateEntry(entry);
                if (compatibility.detected) {
                    incompatible.push({ worldName, uid: entry?.uid, reasons: compatibility.reasons });
                    continue;
                }
                if (worldInfoTriggerType(entry) !== 'keyword') {
                    incompatible.push({ worldName, uid: entry?.uid, reasons: ['非关键词触发'] });
                    continue;
                }
                candidates.push({
                    id: worldEntryKey(worldName, entry?.uid),
                    worldName,
                    uid: entry?.uid,
                    aiDescription: expandAiDescription(this.host, configured.aiDescription),
                    order: Number(entry?.order ?? 0),
                    group: String(entry?.group ?? ''),
                });
            }
        }
        if (incompatible.length) {
            this.mutable.warning = `${incompatible.length} 个已配置 AI 条目无法参与 AI 判定（EJS/Prompt Template 或非关键词触发），本轮按原生模式处理。`;
            this.log?.warn('routing.ejs_forced_native', {
                data: { entryCount: incompatible.length },
                sensitive: { entries: incompatible },
            });
            this.notify();
        }
        return candidates;
    }

    async routeGeneration(_type, params, dryRun) {
        if (!this.active || dryRun || params?.skipWIAN === true || params?.signal?.aborted || !this.host.generationWillRequestModel())
            return;
        const generation = this.sequence;
        this.pending = null;
        const controller = new AbortController();
        this.taskController = controller;
        const cancel = () => controller.abort();
        params?.signal?.addEventListener?.('abort', cancel, { once: true });
        try {
            const candidates = await this.collectCandidates();
            if (!candidates.length)
                return;
            const snapshot = await this.host.snapshot();
            const ids = candidates.map(candidate => candidate.id);
            const output = await this.tasks.execute({
                taskId: 'world-info.activation',
                presetId: this.mutable.presetId ?? undefined,
                systemPrompt: SYSTEM_PROMPT,
                prompt: routerPrompt(snapshot.messages, candidates),
                schema: activationJsonSchema(ids),
                responseLength: 300,
                timeoutMs: 30_000,
                signal: controller.signal,
            });
            const selected = parseActivationResponse(output, ids);
            const current = await this.host.identity();
            if (!this.active || generation !== this.sequence || current.stableId !== snapshot.identity.stableId)
                throw new ToolkitError('AI_ROUTER_STALE', 'AI 判定完成前聊天或生成轮次已变化。');
            this.pending = {
                generation,
                stableId: snapshot.identity.stableId,
                managedIds: ids,
                selectedIds: [...selected],
            };
            this.mutable.warning = '';
            this.mutable.status = `AI 判定完成：选择 ${selected.size} / ${ids.length} 个条目，等待宿主世界书扫描。`;
            this.log?.info('routing.decided', { data: { candidateCount: ids.length, selectedCount: selected.size } });
            this.notify();
        }
        catch (error) {
            this.pending = null;
            this.warn('AI 世界书判定失败，本轮已完整回退到原生激活。', error instanceof ToolkitError ? error.code : 'AI_ROUTER_FAILED', { error });
        }
        finally {
            params?.signal?.removeEventListener?.('abort', cancel);
            if (this.taskController === controller)
                this.taskController = null;
        }
    }

    onWorldInfoContractError(error) {
        if (!this.active)
            return;
        this.pending = null;
        this.mutable.warning = WORLD_INFO_CONTRACT_WARNING;
        this.mutable.status = WORLD_INFO_CONTRACT_WARNING;
        this.log?.warn('host.event_contract_failed', {
            data: { operation: 'routing.apply', ...worldInfoContractFailureData(error) },
        });
        this.notify();
    }

    async applyPending(payload) {
        if (this.mutable.warning === WORLD_INFO_CONTRACT_WARNING) {
            this.mutable.warning = '';
            this.mutable.status = '宿主世界书事件已恢复，下一轮生成将重新进行 AI 判定。';
            this.notify();
        }
        const decision = this.pending;
        if (!decision)
            return;
        this.pending = null;
        try {
            const current = await this.host.identity();
            if (current.stableId !== decision.stableId || decision.generation !== this.sequence)
                throw new ToolkitError('AI_ROUTER_STALE', '世界书扫描前聊天或生成轮次已变化。');
            const applied = applyActivationDecision(payload, decision.managedIds, decision.selectedIds);
            if (applied.forceEntries.length)
                await this.host.emitHostEvent('WORLDINFO_FORCE_ACTIVATE', applied.forceEntries);
            this.mutable.status = `本轮 AI 世界书路由已应用：强制激活 ${applied.forceEntries.length} 个，屏蔽 ${applied.suppressedCount} 个。`;
            this.log?.info('routing.applied', {
                data: { activatedCount: applied.forceEntries.length, suppressedCount: applied.suppressedCount },
            });
            this.notify();
        }
        catch (error) {
            this.warn('AI 世界书临时决策未能安全应用，本轮保留宿主原生处理。', error instanceof ToolkitError ? error.code : 'AI_ROUTER_APPLY_FAILED', { error });
        }
    }

    async fillDescriptions(uids) {
        if (!this.mutable.worldData?.entries)
            throw new ToolkitError('WORLD_INFO_NOT_SELECTED', '请先选择世界书。');
        const entries = collectFillEntries(this.mutable.worldData.entries, uids);
        if (!entries.length)
            throw new ToolkitError('WORLD_INFO_NO_ELIGIBLE', '所选条目中没有可生成描述的关键词触发条目。');
        this.cancelFill();
        const controller = new AbortController();
        this.fillController = controller;
        const batches = chunkFillEntries(entries);
        const descriptions = [];
        const failures = [];
        let processed = 0;
        this.mutable.fillBusy = true;
        this.mutable.fillProgress = { done: 0, total: entries.length, uid: '' };
        this.log?.info('fill.started', { data: { entryCount: entries.length, batchCount: batches.length } });
        this.notify();
        try {
            for (const batch of batches) {
                if (controller.signal.aborted)
                    throw new ToolkitError('LLM_TASK_CANCELLED', '描述生成已取消。');
                this.mutable.fillProgress.uid = batch[0].uid;
                this.notify();
                const output = await this.tasks.execute({
                    taskId: 'world-info.fill',
                    presetId: this.mutable.presetId ?? undefined,
                    systemPrompt: FILL_SYSTEM_PROMPT,
                    prompt: fillDescriptionPrompt(batch),
                    schema: fillDescriptionSchema(batch.map(entry => entry.uid)),
                    responseLength: FILL_RESPONSE_LENGTH,
                    timeoutMs: FILL_TIMEOUT_MS,
                    signal: controller.signal,
                });
                const parsed = parseFillResponse(output, batch.map(entry => entry.uid));
                for (const item of parsed.descriptions)
                    descriptions.push(item);
                for (const failure of parsed.failures)
                    failures.push(failure);
                processed += batch.length;
                this.mutable.fillProgress.done = processed;
                this.log?.info('fill.batch_completed', {
                    data: { batchSize: batch.length, okCount: parsed.descriptions.length, failedCount: parsed.failures.length },
                });
                if (controller.signal.aborted)
                    throw new ToolkitError('LLM_TASK_CANCELLED', '描述生成已取消。');
                this.notify();
            }
            this.log?.info('fill.completed', { data: { okCount: descriptions.length, failedCount: failures.length } });
            return { descriptions, failures };
        }
        catch (error) {
            this.log?.warn('fill.failed', {
                data: { operation: 'fill.generate', ...errorKind(error) },
                sensitive: { error },
            });
            throw error;
        }
        finally {
            this.mutable.fillBusy = false;
            if (this.fillController === controller)
                this.fillController = null;
            this.notify();
        }
    }

    async refreshWorlds() {
        this.mutable.busy = true;
        this.mutable.error = '';
        this.notify();
        try {
            await this.refreshFeatureSettings();
            this.mutable.worldNames = this.host.listWorldInfoNames();
            await this.refreshActiveWorlds();
            if (!this.mutable.worldNames.includes(this.mutable.selectedWorld))
                this.mutable.selectedWorld = this.mutable.worldNames[0] ?? '';
            if (this.mutable.selectedWorld)
                await this.selectWorld(this.mutable.selectedWorld);
            else {
                this.mutable.worldData = null;
                this.mutable.config = null;
            }
        }
        catch (error) {
            this.log?.error('config.refresh_failed', {
                data: { operation: 'config.refresh', ...errorKind(error) },
                sensitive: { error },
            });
            this.mutable.error = errorMessage(error);
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }

    async refreshActiveWorlds() {
        this.mutable.activeWorlds = [];
        this.mutable.activeWorldsError = '';
        let bindings;
        try {
            bindings = this.host.activeWorldInfoBindings();
        }
        catch (error) {
            this.mutable.activeWorldsError = errorMessage(error);
            this.log?.warn('active_worlds.resolve_failed', {
                data: { operation: 'active_worlds.resolve', ...errorKind(error) },
                sensitive: { error },
            });
            return;
        }
        this.mutable.activeWorlds = await Promise.all(bindings.map(async binding => {
            try {
                const loaded = await this.store.load(binding.name);
                let configuredAiEntries = 0;
                let eligibleAiEntries = 0;
                for (const entry of Object.values(loaded.data.entries ?? {})) {
                    if (loaded.config.entries[String(entry?.uid)]?.mode !== 'ai')
                        continue;
                    configuredAiEntries += 1;
                    if (isAiModeEligible(entry))
                        eligibleAiEntries += 1;
                }
                return {
                    ...binding,
                    routerEnabled: loaded.config.enabled,
                    configuredAiEntries,
                    eligibleAiEntries,
                    backend: loaded.backend,
                    error: '',
                };
            }
            catch (error) {
                this.log?.error('active_worlds.config_load_failed', {
                    data: { operation: 'active_worlds.config.load', ...errorKind(error) },
                    sensitive: { worldName: binding.name, error },
                });
                return {
                    ...binding,
                    routerEnabled: false,
                    configuredAiEntries: 0,
                    eligibleAiEntries: 0,
                    backend: 'unavailable',
                    error: errorMessage(error),
                };
            }
        }));
    }

    async selectWorld(worldName) {
        this.cancelFill();
        this.mutable.selectedWorld = String(worldName);
        try {
            const loaded = await this.store.load(this.mutable.selectedWorld);
            this.mutable.worldData = loaded.data;
            this.mutable.config = loaded.config;
            this.mutable.storageBackend = loaded.backend;
            this.mutable.error = '';
            this.notify();
        }
        catch (error) {
            this.log?.error('config.load_failed', {
                data: { operation: 'config.load', ...errorKind(error) },
                sensitive: { worldName: this.mutable.selectedWorld, error },
            });
            throw error;
        }
    }

    async saveConfig(config) {
        if (!this.mutable.selectedWorld || !this.mutable.worldData)
            throw new ToolkitError('WORLD_INFO_NOT_SELECTED', '请先选择世界书。');
        const validated = parseWorldInfoAiConfig(config);
        for (const entry of Object.values(this.mutable.worldData.entries ?? {})) {
            const configured = validated.entries[String(entry?.uid)];
            if (configured?.mode === 'ai' && detectPromptTemplateEntry(entry).detected)
                throw new ToolkitError('EJS_AI_MODE_FORBIDDEN', `条目 ${String(entry?.uid)} 包含 EJS 或 Prompt Template 专用语法，只能使用原生模式。`);
        }
        this.mutable.busy = true;
        this.notify();
        try {
            const saved = await this.store.save(this.mutable.selectedWorld, validated, this.mutable.worldData);
            this.mutable.worldData = saved.data;
            this.mutable.config = saved.config;
            this.mutable.storageBackend = saved.backend;
            this.mutable.status = saved.backend === 'world-extension'
                ? '配置已保存到世界书扩展字段。'
                : '世界书扩展字段无法安全往返，配置已自动保存到 TT-Toolkit 扩展存储。';
            this.mutable.error = '';
            await this.refreshActiveWorlds();
        }
        catch (error) {
            this.log?.error('config.save_failed', { data: { operation: 'config.save', ...errorKind(error) }, sensitive: { error } });
            throw error;
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }
}
