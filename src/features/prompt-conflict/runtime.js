import { errorKind, errorMessage, ToolkitError } from '../../kernel/errors.js';
import { worldInfoContractFailureData } from '../../kernel/world-info.js';
import { LlmPresetStore } from '../../kernel/llm-presets.js';
import { LlmTaskService } from '../../kernel/llm-tasks.js';
import { PromptConflictAnalysisService } from './model-analysis.js';
import { applyPreviousSelection, collectSources, recordSnapshotReadFailure, summarizeSources } from './collect.js';
import { filterWorldInfoPayload } from './overrides.js';
import {
    createDefaultPromptConflictChatMetadata,
    createDefaultPromptConflictFeatureSettings,
    FEATURE_SETTINGS_KEY,
    parsePromptConflictChatMetadata,
    parsePromptConflictFeatureSettings,
} from './schema.js';
import { chunkSources, computeSnapshotFingerprint, isAnalyzable } from './sources.js';
import {
    beginApplyReview,
    cancelApplyReview,
    clearStagedChanges,
    commitStagedChanges,
    stageRestore,
    stageRestoreRecord,
    stageSuppress,
} from './staging.js';

const WORLD_INFO_CONTRACT_WARNING = '宿主世界书事件结构无效，本轮未应用聊天屏蔽；下次生成会重新校验，持续出现请核对宿主版本。';

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
        this.applyAnchorIdentity = null;
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
            this.host.subscribeWorldInfoEntriesLoaded(
                payload => this.onWorldInfoLoaded(payload),
                error => this.onWorldInfoContractError(error),
            ),
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
        this.applyAnchorIdentity = null;
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
            const result = await this.host.setPromptConflictChatMetadata(identity.stableId, createDefaultPromptConflictChatMetadata(), identity.ref);
            await this.refresh();
            this.mutable.status = result.localMirror
                ? '已重置本聊天的冲突检测屏蔽数据。'
                : '已重置原聊天的屏蔽数据，但未同步当前界面。请重新打开原聊天核对。';
            this.notify();
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
            this.applyAnchorIdentity = null;
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

    onWorldInfoContractError(error) {
        if (!this.active)
            return;
        this.mutable.error = WORLD_INFO_CONTRACT_WARNING;
        this.log?.warn('host.event_contract_failed', {
            data: { operation: 'suppression.filter', ...worldInfoContractFailureData(error) },
        });
        this.notify();
    }

    async onWorldInfoLoaded(payload) {
        if (!this.active)
            return;
        if (this.mutable.error === WORLD_INFO_CONTRACT_WARNING) {
            this.mutable.error = '';
            this.notify();
        }
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

    // 只把「已读到但 schema 不合法」降级为可继续的 metadataError；宿主读取本身失败照常上抛，由 refresh 统一报错。
    async readChatMetadataRecords() {
        const raw = await this.host.getPromptConflictChatMetadata();
        this.mutable.metadataError = '';
        try {
            return parsePromptConflictChatMetadata(raw).disabledWorldEntries;
        }
        catch (error) {
            this.mutable.metadataError = errorMessage(error);
            this.log?.error('metadata.parse_failed', {
                data: { operation: 'metadata.parse', ...errorKind(error) },
                sensitive: { error },
            });
            return [];
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
            this.metadataRecords = await this.readChatMetadataRecords();
            const sources = await collectSources(this.host, this.metadataRecords);
            applyPreviousSelection(sources, previous);
            const fingerprint = await computeSnapshotFingerprint(sources);
            this.mutable.snapshot = { fingerprint, identity, sources };
            this.mutable.selectedSourceIds = new Set(sources.filter(source => source.enabledForDetection).map(source => source.sourceId));
            this.mutable.chatIdentity = identity;
            this.mutable.reportStale = this.computeReportStale();
            this.mutable.phase = 'idle';
            const counts = summarizeSources(sources);
            this.mutable.status = `已读取当前聊天来源：可检测 ${counts.analyzable}、已屏蔽 ${counts.suppressed}、无法静态检测 ${counts.unsupported}。`;
            this.log?.debug('snapshot.refreshed', { data: { sourceCount: sources.length, ...counts } });
        }
        catch (error) {
            this.mutable.phase = 'idle';
            recordSnapshotReadFailure(this, error);
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
        const snapshot = this.mutable.snapshot;
        if (!snapshot)
            return;
        const allowed = new Set(this.analyzableSources().map(source => source.sourceId));
        const selected = new Set();
        for (const sourceId of nextIds) {
            if (allowed.has(sourceId))
                selected.add(sourceId);
        }
        this.mutable.selectedSourceIds = selected;
        for (const source of snapshot.sources)
            source.enabledForDetection = selected.has(source.sourceId);
        const fingerprint = await computeSnapshotFingerprint(snapshot.sources);
        if (this.mutable.snapshot !== snapshot)
            return;
        snapshot.fingerprint = fingerprint;
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
        return stageSuppress(this, sourceId);
    }

    stageRestore(sourceId) {
        return stageRestore(this, sourceId);
    }

    stageRestoreRecord(record) {
        return stageRestoreRecord(this, record);
    }

    clearStagedChanges() {
        return clearStagedChanges(this);
    }

    beginApplyReview() {
        return beginApplyReview(this);
    }

    cancelApplyReview() {
        return cancelApplyReview(this);
    }

    commitStagedChanges() {
        return commitStagedChanges(this);
    }

    async runDetection() {
        if (this.mutable.phase === 'detecting' || this.mutable.phase === 'reading')
            return;
        if (this.mutable.applying) {
            this.mutable.error = '正在应用屏蔽变更，请稍后再试。';
            this.notify();
            return;
        }
        if (!this.mutable.snapshot && this.mutable.error)
            return;
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
