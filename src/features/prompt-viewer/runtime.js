import { ToolkitError, errorKind, errorMessage } from '../../kernel/errors.js';
import {
    attachWorldEntryRefs,
    buildPromptItemView,
    projectWorldEntries,
    rebuildChatMessages,
    serializePromptItems,
    sumTokens,
} from './model.js';
import { assertPromptSnapshot, createDefaultPromptViewerSettings, parsePromptViewerSettings } from './schema.js';

const SETTINGS_KEY = 'prompt-viewer-settings-v1';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

export class PromptViewerRuntime {
    mutable = {
        active: false,
        busy: false,
        info: null,
        snapshot: null,
        prediction: null,
        pendingUpdate: false,
        settings: createDefaultPromptViewerSettings(),
        status: '尚未捕获正文轮次。',
        error: '',
    };
    state = this.mutable;
    listeners = new Set();
    notifyScheduled = false;
    unsubscribeEvents = null;
    generation = null;
    roundWorldEntries = [];
    predictionInFlight = false;
    predictionBuffer = null;

    constructor(host, log) {
        this.host = host;
        this.log = log;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        if (this.notifyScheduled)
            return;
        this.notifyScheduled = true;
        queueMicrotask(() => {
            this.notifyScheduled = false;
            for (const listener of this.listeners)
                listener(this.state);
        });
    }

    async initialize() {
        try {
            this.mutable.settings = parsePromptViewerSettings(await this.host.globalGet(SETTINGS_KEY));
            this.log.debug('settings.loaded', { data: { defaultCollapsed: this.mutable.settings.defaultCollapsed } });
        }
        catch (error) {
            this.mutable.settings = createDefaultPromptViewerSettings();
            this.mutable.error = errorMessage(error);
            this.log.error('settings.load_failed', {
                data: { operation: 'settings.load', ...errorKind(error) },
                sensitive: { error },
            });
        }
        this.notify();
    }

    async activate() {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = this.host.subscribePromptViewerEvents({
            onGenerationStart: event => this.onGenerationStart(event),
            onPromptReady: event => this.onPromptReady(event),
            onWorldInfoActivated: entries => this.onWorldInfoActivated(entries),
            onWorldInfoScan: event => this.onWorldInfoScan(event),
            onGenerationStopped: () => this.onGenerationEnd(),
            onGenerationEnded: () => this.onGenerationEnd(),
            onChatChanged: () => this.onChatChanged(),
            onContractError: error => this.log.error('host.event_contract_failed', {
                data: { operation: 'host.event', ...errorKind(error) },
                sensitive: { error },
            }),
        });
        this.mutable.active = true;
        await this.refreshInfo();
        this.log.info('activated');
        this.notify();
    }

    async deactivate() {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = null;
        this.generation = null;
        this.roundWorldEntries = [];
        this.predictionInFlight = false;
        this.predictionBuffer = null;
        this.mutable.active = false;
        this.mutable.busy = false;
        this.mutable.snapshot = null;
        this.mutable.prediction = null;
        this.mutable.pendingUpdate = false;
        this.mutable.status = '功能已停用。';
        this.mutable.error = '';
        this.log.info('deactivated');
        this.notify();
    }

    async refreshInfo() {
        try {
            this.mutable.info = await this.host.promptViewerStatus();
        }
        catch (error) {
            this.mutable.info = {
                mainApi: '',
                model: null,
                source: null,
                tokenBudget: null,
                isGroup: false,
                characterName: null,
                promptManagerReady: false,
                reason: 'PROMPT_MANAGER_UNAVAILABLE',
            };
            this.mutable.error = errorMessage(error);
        }
        this.notify();
    }

    onGenerationStart({ type, dryRun }) {
        if (dryRun)
            return;
        if (!ALLOWED_GENERATION_TYPES.has(type)) {
            this.generation = null;
            return;
        }
        this.generation = { type, roundCount: 0 };
        this.roundWorldEntries = [];
    }

    onPromptReady(event) {
        return this.capturePromptReady(event).catch(error => {
            if (this.predictionInFlight && this.predictionBuffer)
                this.predictionBuffer.captureError = error;
            this.log.error('capture.failed', {
                data: { operation: 'prompt.capture', ...errorKind(error) },
                sensitive: { error },
            });
        });
    }

    async capturePromptReady({ dryRun }) {
        if (dryRun) {
            if (!this.predictionInFlight || !this.predictionBuffer)
                return;
            this.predictionBuffer.roundCount += 1;
            const snapshot = await this.createSnapshot({
                kind: 'prediction',
                generationType: 'normal',
                worldEntries: this.predictionBuffer.worldEntries,
            });
            snapshot.assemblyRoundCount = this.predictionBuffer.roundCount;
            this.predictionBuffer.snapshot = snapshot;
            return;
        }
        if (!this.generation)
            return;
        this.generation.roundCount += 1;
        const snapshot = await this.createSnapshot({
            kind: 'sent',
            generationType: this.generation.type,
            worldEntries: this.roundWorldEntries,
        });
        snapshot.assemblyRoundCount = this.generation.roundCount;
        const hadSnapshot = Boolean(this.mutable.snapshot);
        this.mutable.snapshot = snapshot;
        this.mutable.prediction = null;
        this.mutable.pendingUpdate = hadSnapshot;
        this.mutable.status = `已捕获最近一轮（${snapshot.items.length} 条条目）。`;
        this.log.info('snapshot.captured', {
            data: {
                generationType: snapshot.generationType,
                assemblyRoundCount: snapshot.assemblyRoundCount,
                itemCount: snapshot.items.length,
                worldEntryCount: snapshot.worldEntries.length,
                tokenTotal: snapshot.tokenTotal,
                squashSystemMessages: snapshot.squashSystemMessages,
                removedAgentItemCount: snapshot.removedAgentItemCount,
            },
        });
        this.notify();
    }

    onWorldInfoActivated(entries) {
        if (this.predictionInFlight || !this.generation)
            return;
        this.roundWorldEntries = entries;
    }

    onWorldInfoScan({ isFinal, entries }) {
        if (!this.predictionInFlight || !this.predictionBuffer || !isFinal)
            return;
        this.predictionBuffer.worldEntries = entries;
    }

    onGenerationEnd() {
        this.generation = null;
        this.roundWorldEntries = [];
    }

    onChatChanged() {
        this.generation = null;
        this.roundWorldEntries = [];
        this.mutable.snapshot = null;
        this.mutable.prediction = null;
        this.mutable.pendingUpdate = false;
        this.mutable.status = '当前聊天已切换，等待新的正文轮次。';
        this.log.info('chat.changed');
        this.notify();
    }

    async createSnapshot({ kind, generationType, worldEntries }) {
        const raw = await this.host.readPromptViewerSnapshot();
        const projectedWorldEntries = projectWorldEntries(worldEntries);
        const items = attachWorldEntryRefs(buildPromptItemView(raw.messages), projectedWorldEntries);
        const info = this.mutable.info;
        return assertPromptSnapshot({
            schemaVersion: 1,
            kind,
            capturedAtMs: Date.now(),
            generationType,
            groupMemberLabel: info?.isGroup && info?.characterName ? info.characterName : null,
            assemblyRoundCount: 1,
            removedAgentItemCount: raw.removedAgentItemCount ?? 0,
            model: info?.model ? { name: info.model, source: info.source } : null,
            tokenBudget: info?.tokenBudget ?? null,
            squashSystemMessages: Boolean(raw.squashSystemMessages),
            items,
            worldEntries: projectedWorldEntries,
            messages: rebuildChatMessages(items),
            tokenTotal: sumTokens(items),
        });
    }

    async predict(text) {
        if (this.mutable.busy || this.predictionInFlight)
            throw new ToolkitError('PROMPT_VIEWER_BUSY', '已有预测进行中。');
        if (this.generation)
            throw new ToolkitError('PROMPT_VIEWER_BUSY', '宿主正在生成，暂时不能预测。');
        const info = this.mutable.info;
        if (!info || info.mainApi !== 'openai')
            throw new ToolkitError('PROMPT_VIEWER_UNSUPPORTED_API', '当前不是聊天补全接口，无法预测。');
        this.mutable.busy = true;
        this.mutable.error = '';
        this.notify();
        this.predictionInFlight = true;
        this.predictionBuffer = { snapshot: null, worldEntries: [], roundCount: 0, captureError: null };
        const startedAt = Date.now();
        try {
            await this.host.runPromptViewerDryRun(text);
            const buffer = this.predictionBuffer;
            if (!buffer?.snapshot) {
                throw new ToolkitError(
                    'PROMPT_VIEWER_PREDICTION_FAILED',
                    buffer?.captureError ? errorMessage(buffer.captureError) : '预测未产生组装结果。',
                );
            }
            buffer.snapshot.assemblyRoundCount = buffer.roundCount || 1;
            this.mutable.prediction = buffer.snapshot;
            this.mutable.status = `已完成预测（${buffer.snapshot.items.length} 条条目）。`;
            this.log.info('prediction.completed', {
                data: {
                    elapsedMs: Date.now() - startedAt,
                    itemCount: buffer.snapshot.items.length,
                    worldEntryCount: buffer.snapshot.worldEntries.length,
                    tokenTotal: buffer.snapshot.tokenTotal,
                },
            });
            return buffer.snapshot;
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
            this.log.error('prediction.failed', {
                data: { operation: 'prompt.prediction', elapsedMs: Date.now() - startedAt, ...errorKind(error) },
            });
            throw error;
        }
        finally {
            this.predictionInFlight = false;
            this.predictionBuffer = null;
            this.mutable.busy = false;
            this.notify();
        }
    }

    acknowledgeUpdate() {
        if (!this.mutable.pendingUpdate)
            return;
        this.mutable.pendingUpdate = false;
        this.notify();
    }

    async updateSettings(patch) {
        const next = parsePromptViewerSettings({ ...this.mutable.settings, ...patch });
        this.mutable.settings = next;
        try {
            await this.host.globalSet(SETTINGS_KEY, next);
            this.log.info('settings.saved', { data: { defaultCollapsed: next.defaultCollapsed } });
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
            this.log.error('settings.save_failed', {
                data: { operation: 'settings.save', ...errorKind(error) },
                sensitive: { error },
            });
        }
        this.notify();
    }

    exportText(kind) {
        const snapshot = kind === 'prediction' ? this.mutable.prediction : this.mutable.snapshot;
        if (!snapshot)
            throw new ToolkitError('PROMPT_VIEWER_NO_SNAPSHOT', kind === 'prediction' ? '尚未完成预测。' : '尚未捕获正文轮次。');
        return serializePromptItems(snapshot.items);
    }

    logExport(kind, via, itemCount) {
        this.log.info('exported', { data: { format: 'txt', source: via, itemCount, kind } });
    }
}
