import { errorKind, errorMessage, ToolkitError } from '../../kernel/errors.js';
import { sha256Hex } from '../../kernel/hash.js';
import { LlmPresetStore } from '../../kernel/llm-presets.js';
import { LlmTaskService } from '../../kernel/llm-tasks.js';
import { detectPromptTemplateEntry } from './dynamic-template.js';
import { PromptConflictAnalysisService } from './model-analysis.js';
import {
    applyStagedChanges,
    buildOverrideLookup,
    createStagedChange,
    filterWorldInfoPayload,
    overrideRecordKey,
    sameMetadata,
    stageChange,
} from './overrides.js';
import {
    createDefaultPromptConflictChatMetadata,
    createDefaultPromptConflictFeatureSettings,
    FEATURE_SETTINGS_KEY,
    parsePromptConflictChatMetadata,
    parsePromptConflictFeatureSettings,
} from './schema.js';
import {
    chunkSources,
    computeSnapshotFingerprint,
    createPresetSource,
    createWorldInfoSource,
    isConstantWorldInfoEntry,
} from './sources.js';

function isAnalyzable(source) {
    return !source.suppressedForCurrentChat && !source.dynamic;
}

export class PromptConflictRuntime {
    constructor(host, log, options = {}) {
        this.host = host;
        this.log = log;
        this.presets = options.presets ?? new LlmPresetStore(host);
        this.tasks = options.tasks ?? new LlmTaskService(host, options.taskLog ?? log, { presets: this.presets });
        this.analysis = options.analysis ?? new PromptConflictAnalysisService(host, options.taskLog ?? log, { presets: this.presets, tasks: this.tasks });
        this.mutable = {
            phase: 'idle',
            chatIdentity: null,
            snapshot: null,
            selectedSourceIds: new Set(),
            stagedChanges: new Map(),
            report: null,
            reportStale: false,
            activeRun: null,
            selectedModelPresetId: null,
            presetOptions: [],
            activePresetId: null,
            presetError: '',
            metadataError: '',
            error: '',
            status: '',
            applying: false,
        };
        this.state = this.mutable;
        this.listeners = new Set();
        this.disposers = [];
        this.active = false;
        this.runSequence = 0;
        this.taskController = null;
        this.metadataRecords = [];
        this.applyAnchorStableId = null;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners)
            listener(this.state);
    }

    setError(message, logEvent, details = {}) {
        this.mutable.error = message;
        this.mutable.phase = 'idle';
        this.log?.warn(logEvent, { data: { operation: logEvent, ...details } });
        this.notify();
    }

    snapshotSources() {
        return this.mutable.snapshot?.sources ?? [];
    }

    analyzableSources() {
        return this.snapshotSources().filter(isAnalyzable);
    }

    selectedSources() {
        const selected = new Set(this.mutable.selectedSourceIds);
        return this.analyzableSources().filter(source => selected.has(source.sourceId));
    }

    async activate() {
        if (this.active)
            return;
        this.active = true;
        this.disposers = [
            this.host.subscribePromptConflictSourceInvalidation(event => this.onSourceInvalidation(event)),
            this.host.subscribeWorldInfoEntriesLoaded(payload => this.onWorldInfoLoaded(payload)),
        ];
        this.log?.info('activated');
        await this.loadFeatureSettings();
        await this.refresh();
    }

    async deactivate() {
        this.active = false;
        this.runSequence += 1;
        this.cancelRun();
        this.mutable.stagedChanges = new Map();
        this.mutable.applying = false;
        this.mutable.applyAnchorStableId = null;
        for (const dispose of this.disposers.splice(0))
            dispose();
        this.log?.info('deactivated');
    }

    async loadFeatureSettings() {
        try {
            const settings = parsePromptConflictFeatureSettings(await this.host.globalGet(FEATURE_SETTINGS_KEY));
            const presets = await this.presets.load();
            this.mutable.presetOptions = presets.presets.map(preset => ({ id: preset.id, name: preset.name, model: preset.model }));
            this.mutable.activePresetId = presets.activePresetId;
            let presetId = settings.presetId;
            if (presetId !== null && !presets.presets.some(preset => preset.id === presetId))
                presetId = null;
            this.mutable.selectedModelPresetId = presetId;
            this.mutable.presetError = '';
        }
        catch (error) {
            this.mutable.presetError = errorMessage(error);
            this.log?.error('preset.settings_load_failed', {
                data: { operation: 'preset.settings.load', ...errorKind(error) },
                sensitive: { error },
            });
        }
    }

    async selectPreset(presetId) {
        const id = presetId === '' || presetId === null ? null : String(presetId);
        try {
            if (id !== null) {
                const settings = await this.presets.load();
                if (!settings.presets.some(preset => preset.id === id))
                    throw new ToolkitError('LLM_PRESET_MISSING', '模型预设不存在或尚未保存。');
            }
            await this.host.globalSet(FEATURE_SETTINGS_KEY, { ...createDefaultPromptConflictFeatureSettings(), presetId: id });
            this.mutable.selectedModelPresetId = id;
            this.mutable.status = id
                ? '冲突检测将使用所选模型预设。'
                : '冲突检测将跟随设置页的当前预设。';
            this.notify();
        }
        catch (error) {
            this.log?.error('preset.select_failed', { data: { operation: 'preset.select', ...errorKind(error) }, sensitive: { error } });
            throw error;
        }
    }

    async resetChatMetadata() {
        try {
            const identity = await this.host.getCurrentChatIdentity();
            await this.host.setPromptConflictChatMetadata(identity.stableId, createDefaultPromptConflictChatMetadata());
            await this.refresh();
            this.mutable.metadataError = '';
            this.mutable.status = '已重置本聊天的冲突检测屏蔽数据。';
        }
        catch (error) {
            this.log?.error('metadata.reset_failed', { data: { operation: 'metadata.reset', ...errorKind(error) }, sensitive: { error } });
            this.setError(errorMessage(error), 'metadata.reset_failed');
        }
    }

    onSourceInvalidation(event) {
        if (!this.active)
            return;
        if (event.type === 'WORLDINFO_UPDATED') {
            const name = event.args?.[0];
            if (typeof name === 'string' && name && !this.host.activeWorldInfoNames().includes(name))
                return;
        }
        if (event.type === 'CHAT_CHANGED') {
            this.runSequence += 1;
            this.cancelRun();
            this.mutable.stagedChanges = new Map();
            this.mutable.applying = false;
            this.mutable.applyAnchorStableId = null;
            this.mutable.reportStale = true;
            this.log?.info('source.chat_changed');
            void this.refresh();
            return;
        }
        this.mutable.reportStale = true;
        if (this.mutable.phase === 'detecting') {
            this.cancelRun();
            this.mutable.error = '检测期间来源已变化，已取消本次检测；旧报告保留。';
            this.log?.info('detection.cancelled_by_invalidation', { data: { event: event.type } });
            this.notify();
            return;
        }
        if (this.mutable.phase === 'idle')
            void this.refresh();
    }

    async onWorldInfoLoaded(payload) {
        if (!this.active)
            return;
        if (this.mutable.metadataError) {
            this.log?.warn('suppression.skipped_metadata_error', { data: { operation: 'suppression.filter' } });
            return;
        }
        try {
            const removed = await filterWorldInfoPayload(payload, this.metadataRecords);
            if (removed)
                this.log?.info('suppression.applied', { data: { removedCount: removed } });
        }
        catch (error) {
            this.log?.warn('suppression.filter_failed', {
                data: { operation: 'suppression.filter', ...errorKind(error) },
                sensitive: { error },
            });
            this.setError('世界书条目过滤失败，本轮未应用聊天屏蔽。', 'suppression.filter_failed');
        }
    }

    async refresh() {
        if (this.mutable.phase === 'reading' || this.mutable.phase === 'detecting' || this.mutable.applying)
            return;
        this.mutable.phase = 'reading';
        this.mutable.error = '';
        this.notify();
        const previous = new Map(this.snapshotSources().map(source => [source.sourceId, source.enabledForDetection]));
        try {
            const identity = await this.host.getCurrentChatIdentity();
            await this.loadFeatureSettings();
            const rawMetadata = await this.host.getPromptConflictChatMetadata();
            let records = [];
            this.mutable.metadataError = '';
            try {
                records = parsePromptConflictChatMetadata(rawMetadata).disabledWorldEntries;
            }
            catch (error) {
                this.mutable.metadataError = errorMessage(error);
                this.log?.error('metadata.parse_failed', {
                    data: { operation: 'metadata.parse', ...errorKind(error) },
                    sensitive: { error },
                });
            }
            this.metadataRecords = records;

            const sources = [];
            const presetInputs = await this.host.getPromptConflictPresetSources();
            for (const input of presetInputs) {
                const identifierDigest = await sha256Hex(input.identifier);
                const contentDigest = await sha256Hex(input.content);
                const source = createPresetSource({
                    identifierDigest,
                    label: input.label,
                    role: input.role,
                    position: input.position,
                    order: input.order,
                    content: input.content,
                    contentDigest,
                });
                source.dynamic = detectPromptTemplateEntry({ content: input.content, comment: '' }).detected;
                source.suppressedForCurrentChat = false;
                sources.push(source);
            }

            const groups = await this.host.getMountedWorldInfoEntries();
            for (const listName of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
                for (const entry of groups[listName] ?? []) {
                    if (!isConstantWorldInfoEntry(entry))
                        continue;
                    const worldDigest = await sha256Hex(String(entry.world ?? ''));
                    const expanded = await this.host.expandPromptConflictSourceMacros(entry.content);
                    const rawContentDigest = await sha256Hex(String(entry.content ?? ''));
                    const contentDigest = await sha256Hex(expanded);
                    const source = createWorldInfoSource({
                        worldDigest,
                        uid: entry.uid,
                        worldName: String(entry.world ?? ''),
                        label: String(entry.comment ?? `条目 ${String(entry.uid)}`),
                        position: Number(entry.position ?? 0),
                        order: Number(entry.order ?? 0),
                        content: expanded,
                        contentDigest,
                        rawContentDigest,
                    });
                    source.dynamic = detectPromptTemplateEntry(entry).detected;
                    source.suppressedForCurrentChat = records.some(record =>
                        record.worldDigest === worldDigest
                        && typeof record.uid === typeof entry.uid
                        && record.uid === entry.uid
                        && record.contentDigest === rawContentDigest);
                    sources.push(source);
                }
            }

            for (const source of sources)
                source.enabledForDetection = previous.get(source.sourceId) === true && isAnalyzable(source);
            for (const source of sources) {
                if (isAnalyzable(source) && !previous.has(source.sourceId))
                    source.enabledForDetection = true;
            }
            const fingerprint = await computeSnapshotFingerprint(sources);
            this.mutable.snapshot = { fingerprint, identity, sources };
            this.mutable.selectedSourceIds = new Set(sources.filter(source => source.enabledForDetection).map(source => source.sourceId));
            this.mutable.chatIdentity = identity;
            this.mutable.reportStale = this.computeReportStale();
            this.mutable.phase = 'idle';
            const analyzable = sources.filter(isAnalyzable).length;
            const suppressed = sources.filter(source => source.suppressedForCurrentChat).length;
            const unsupported = sources.filter(source => source.dynamic && !source.suppressedForCurrentChat).length;
            this.mutable.status = `已读取当前聊天来源：可检测 ${analyzable}、已屏蔽 ${suppressed}、无法静态检测 ${unsupported}。`;
            this.log?.debug('snapshot.refreshed', { data: { sourceCount: sources.length, analyzable, suppressed, unsupported } });
        }
        catch (error) {
            this.mutable.phase = 'idle';
            this.mutable.error = errorMessage(error);
            this.log?.error('snapshot.refresh_failed', {
                data: { operation: 'snapshot.refresh', ...errorKind(error) },
                sensitive: { error },
            });
        }
        this.notify();
    }

    computeReportStale() {
        const report = this.mutable.report;
        const snapshot = this.mutable.snapshot;
        if (!report || !snapshot)
            return false;
        if (report.snapshotFingerprint !== snapshot.fingerprint)
            return true;
        const current = new Set(this.mutable.selectedSourceIds);
        const recorded = new Set(report.selection.map(item => item.sourceId));
        if (current.size !== recorded.size)
            return true;
        for (const sourceId of current) {
            if (!recorded.has(sourceId))
                return true;
        }
        return false;
    }

    async applySelection(nextIds) {
        const allowed = new Set(this.analyzableSources().map(source => source.sourceId));
        const selected = new Set();
        for (const sourceId of nextIds) {
            if (allowed.has(sourceId))
                selected.add(sourceId);
        }
        this.mutable.selectedSourceIds = selected;
        for (const source of this.snapshotSources())
            source.enabledForDetection = selected.has(source.sourceId);
        this.mutable.snapshot.fingerprint = await computeSnapshotFingerprint(this.snapshotSources());
        this.mutable.reportStale = this.computeReportStale();
        this.notify();
    }

    setSourceSelected(sourceId, selected) {
        const ids = new Set(this.mutable.selectedSourceIds);
        if (selected)
            ids.add(sourceId);
        else
            ids.delete(sourceId);
        return this.applySelection(ids);
    }

    selectAllAnalyzable() {
        return this.applySelection(this.analyzableSources().map(source => source.sourceId));
    }

    clearSelection() {
        return this.applySelection([]);
    }

    stageSuppress(sourceId) {
        const source = this.snapshotSources().find(candidate => candidate.sourceId === sourceId);
        if (!source || source.sourceType !== 'world-info' || source.suppressedForCurrentChat)
            return;
        const change = createStagedChange({
            sourceId,
            worldDigest: source.worldDigest,
            uid: source.uid,
            contentDigest: source.rawContentDigest,
            action: 'suppress',
            dynamic: source.dynamic,
        });
        this.mutable.stagedChanges = stageChange(this.mutable.stagedChanges, change);
        this.log?.debug('staged.suppressed', { data: { changeCount: this.mutable.stagedChanges.size } });
        this.notify();
    }

    stageRestore(sourceId) {
        const source = this.snapshotSources().find(candidate => candidate.sourceId === sourceId);
        if (!source || source.sourceType !== 'world-info' || !source.suppressedForCurrentChat)
            return;
        const change = createStagedChange({
            sourceId,
            worldDigest: source.worldDigest,
            uid: source.uid,
            contentDigest: source.rawContentDigest,
            action: 'restore',
            dynamic: source.dynamic,
        });
        this.mutable.stagedChanges = stageChange(this.mutable.stagedChanges, change);
        this.log?.debug('staged.restored', { data: { changeCount: this.mutable.stagedChanges.size } });
        this.notify();
    }

    stageRestoreRecord(record) {
        const key = overrideRecordKey(record);
        const existing = this.snapshotSources().find(source =>
            source.sourceType === 'world-info'
            && `${source.worldDigest}:${typeof source.uid}:${String(source.uid)}` === key);
        const sourceId = existing?.sourceId ?? `wi:${record.worldDigest}:${String(record.uid)}`;
        const change = createStagedChange({
            sourceId,
            worldDigest: record.worldDigest,
            uid: record.uid,
            contentDigest: record.contentDigest,
            action: 'restore',
            dynamic: false,
        });
        this.mutable.stagedChanges = stageChange(this.mutable.stagedChanges, change);
        this.notify();
    }

    clearStagedChanges() {
        this.mutable.stagedChanges = new Map();
        this.notify();
    }

    async beginApplyReview() {
        if (this.mutable.applying || !this.mutable.stagedChanges.size)
            return;
        try {
            const identity = await this.host.getCurrentChatIdentity();
            this.applyAnchorStableId = identity.stableId;
            this.mutable.applying = true;
            this.mutable.phase = 'applying';
            this.mutable.error = '';
            this.notify();
        }
        catch (error) {
            this.log?.error('apply.review_failed', { data: { operation: 'apply.review', ...errorKind(error) }, sensitive: { error } });
            this.setError(errorMessage(error), 'apply.review_failed');
        }
    }

    cancelApplyReview() {
        this.mutable.applying = false;
        this.mutable.phase = 'idle';
        this.applyAnchorStableId = null;
        this.notify();
    }

    async commitStagedChanges() {
        const plan = this.mutable.stagedChanges;
        if (!this.mutable.applying || !plan.size) {
            this.cancelApplyReview();
            return;
        }
        let suppressedCount = 0;
        let restoredCount = 0;
        try {
            const identity = await this.host.getCurrentChatIdentity();
            if (identity.stableId !== this.applyAnchorStableId)
                throw new ToolkitError('CHAT_CHANGED', '应用前聊天已切换，未写入任何变更，请重新检查。');
            const metadata = parsePromptConflictChatMetadata(await this.host.getPromptConflictChatMetadata());
            const groups = await this.host.getMountedWorldInfoEntries();
            const lookup = await buildOverrideLookup(groups);
            for (const change of plan.values()) {
                const key = overrideRecordKey(change);
                if (change.action === 'suppress') {
                    const entryInfo = lookup.get(key);
                    if (!entryInfo || entryInfo.contentDigest !== change.contentDigest)
                        throw new ToolkitError('PROMPT_CONFLICT_ENTRY_CHANGED', '目标世界书条目已删除、已修改或已变为非常驻，未写入任何变更，请重新检查暂存计划。');
                }
                else if (!metadata.disabledWorldEntries.some(record => overrideRecordKey(record) === key)) {
                    throw new ToolkitError('PROMPT_CONFLICT_OVERRIDE_STALE', '待恢复的屏蔽记录已不存在，未写入任何变更，请重新检查暂存计划。');
                }
            }
            const next = applyStagedChanges(metadata, plan);
            if (!sameMetadata(metadata, next))
                await this.host.setPromptConflictChatMetadata(identity.stableId, next);
            suppressedCount = [...plan.values()].filter(change => change.action === 'suppress').length;
            restoredCount = [...plan.values()].filter(change => change.action === 'restore').length;
            this.mutable.stagedChanges = new Map();
            this.mutable.applying = false;
            this.mutable.applyAnchorStableId = null;
            await this.refresh();
            this.mutable.status = `已写入当前聊天：屏蔽 ${suppressedCount} 项，恢复 ${restoredCount} 项。`;
            this.log?.info('overrides.committed', { data: { suppressedCount, restoredCount } });
        }
        catch (error) {
            this.mutable.applying = false;
            this.mutable.applyAnchorStableId = null;
            this.log?.error('overrides.commit_failed', {
                data: { operation: 'overrides.commit', ...errorKind(error) },
                sensitive: { error },
            });
            this.setError(errorMessage(error), 'overrides.commit_failed');
        }
    }

    async runDetection() {
        if (this.mutable.phase === 'detecting' || this.mutable.phase === 'reading')
            return;
        if (this.mutable.applying) {
            this.mutable.error = '正在应用屏蔽变更，请稍后再试。';
            this.notify();
            return;
        }
        const selected = this.selectedSources();
        if (!selected.length) {
            this.setError('未选择任何可分析来源。', 'detection.no_sources');
            return;
        }
        const presetId = this.mutable.selectedModelPresetId;
        try {
            if (presetId)
                await this.presets.byId(presetId);
            else
                await this.presets.active();
        }
        catch {
            this.setError('未选择模型服务预设，请先在“设置 / 模型服务”中配置并启用预设。', 'detection.no_preset');
            return;
        }
        const runSequence = ++this.runSequence;
        const runId = crypto.randomUUID();
        const controller = new AbortController();
        this.taskController = controller;
        const startedAt = Date.now();
        const snapshot = this.mutable.snapshot;
        const batchCount = chunkSources(selected).length;
        this.mutable.activeRun = { runId, stage: 'extracting', done: 0, total: batchCount };
        this.mutable.phase = 'detecting';
        this.mutable.error = '';
        this.notify();
        this.log?.info('detection.started', { data: { sourceCount: selected.length } });
        try {
            const result = await this.analysis.run({
                presetId: presetId ?? undefined,
                sources: selected,
                signal: controller.signal,
                onProgress: progress => {
                    this.mutable.activeRun = { runId, ...progress };
                    this.notify();
                },
            });
            const current = await this.host.getCurrentChatIdentity();
            if (controller.signal.aborted || runSequence !== this.runSequence)
                throw new ToolkitError('PROMPT_CONFLICT_CANCELLED', '检测已取消。');
            if (current.stableId !== snapshot.identity.stableId)
                throw new ToolkitError('CHAT_CHANGED', '检测完成前聊天已变化，已丢弃本次结果。');
            const report = {
                reportId: runId,
                snapshotFingerprint: snapshot.fingerprint,
                selection: selected.map(source => ({ sourceId: source.sourceId, contentDigest: source.contentDigest })),
                startedAt,
                finishedAt: Date.now(),
                sourceIds: selected.map(source => source.sourceId),
                batches: result.batches,
                calls: result.calls,
                directives: result.directives,
                conflicts: result.conflicts,
                counts: { high: 0, medium: 0, low: 0 },
            };
            for (const conflict of result.conflicts)
                report.counts[conflict.severity] += 1;
            this.mutable.report = report;
            this.mutable.reportStale = false;
            this.mutable.status = `检测完成：纳入 ${selected.length} 个来源，${result.calls} 次模型调用，发现 ${result.conflicts.length} 个冲突。`;
            this.log?.info('detection.completed', {
                data: {
                    sourceCount: selected.length,
                    batchCount: result.batches,
                    callCount: result.calls,
                    directiveCount: result.directives.length,
                    conflictCount: result.conflicts.length,
                    severityCounts: report.counts,
                },
            });
        }
        catch (error) {
            if (error instanceof ToolkitError
                && ['LLM_TASK_CANCELLED', 'PROMPT_CONFLICT_CANCELLED'].includes(error.code)) {
                this.mutable.status = '检测已取消，未生成新报告；旧报告保留。';
                this.log?.info('detection.cancelled');
            }
            else {
                this.mutable.error = errorMessage(error);
                this.log?.warn('detection.failed', {
                    data: { operation: 'detection.run', ...errorKind(error) },
                    sensitive: { error },
                });
            }
        }
        finally {
            this.mutable.activeRun = null;
            if (this.taskController === controller)
                this.taskController = null;
            this.mutable.phase = 'idle';
            this.notify();
        }
    }

    cancelRun() {
        this.taskController?.abort();
        this.taskController = null;
        this.runSequence += 1;
        if (this.mutable.activeRun) {
            this.mutable.activeRun = null;
            this.mutable.status = '检测已取消，未生成新报告；旧报告保留。';
            this.notify();
        }
    }
}
