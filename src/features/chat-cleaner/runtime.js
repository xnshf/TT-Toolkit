import { ToolkitError, errorMessage } from '../../kernel/errors.js';
import { logCleanerFailure } from './diagnostics.js';
import { sameConversationIdentity } from '../../kernel/chat-projection.js';
import { rulesFingerprint } from './rules.js';
import { buildOperationPlan, classifyMessage } from './plan.js';
import { createDefaultProgress, createDefaultSettings, parseProgress, parseSettings } from './schema.js';
import { commitOperation } from './transaction.js';
const SETTINGS_KEY = 'chat-cleaner-settings-v1';
const PROGRESS_NAMESPACE = 'tt-toolkit.chat-cleaner';
export class ChatCleanerRuntime {
    host;
    log;
    mutable = {
        settings: createDefaultSettings(),
        progress: null,
        currentPlan: null,
        busy: false,
        active: false,
        status: '尚无运行记录。',
        error: '',
    };
    state = this.mutable;
    listeners = new Set();
    notifyScheduled = false;
    unsubscribe = null;
    queue = Promise.resolve();
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
            this.mutable.settings = parseSettings(await this.host.globalGet(SETTINGS_KEY));
            this.log.debug('settings.loaded', { data: { assistantRules: this.mutable.settings.assistant.rules.length, userRules: this.mutable.settings.user.rules.length, autoEnabled: this.mutable.settings.auto.enabled } });
        }
        catch (error) {
            logCleanerFailure(this.log, 'settings.load_failed', 'settings.load', error);
            this.mutable.settings = createDefaultSettings();
            this.mutable.error = errorMessage(error);
            this.mutable.status = `清洗配置读取失败，功能保持安全默认值并停止自动运行：${errorMessage(error)}`;
        }
        this.notify();
    }
    async activate() {
        this.mutable.active = true;
        this.log.info('activated', { data: { autoEnabled: this.mutable.settings.auto.enabled } });
        this.syncAutoSubscription();
        this.notify();
    }
    async deactivate() {
        this.mutable.active = false;
        this.log.info('deactivated');
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.mutable.currentPlan = null;
        this.notify();
    }
    async saveSettings(settings) {
        try {
            const validated = parseSettings(settings);
            await this.host.globalSet(SETTINGS_KEY, validated);
            this.mutable.settings = validated;
            this.mutable.currentPlan = null;
            this.syncAutoSubscription();
            this.log.info('settings.saved', {
                data: { assistantRules: validated.assistant.rules.length, userRules: validated.user.rules.length, autoEnabled: validated.auto.enabled, deleteNativeReasoning: validated.deleteNativeReasoning, clearSwipes: validated.clearSwipes },
                sensitive: { settings: validated },
            });
            this.notify();
        }
        catch (error) {
            logCleanerFailure(this.log, 'settings.save_failed', 'settings.save', error);
            throw error;
        }
    }
    async resetSettings() {
        try {
            await this.host.globalDelete(SETTINGS_KEY);
            this.mutable.settings = createDefaultSettings();
            this.mutable.currentPlan = null;
            this.mutable.error = '';
            this.mutable.status = '聊天清洗设置已重置。';
            this.log.warn('settings.reset');
            this.syncAutoSubscription();
            this.notify();
        }
        catch (error) {
            logCleanerFailure(this.log, 'settings.reset_failed', 'settings.reset', error);
            throw error;
        }
    }
    async loadProgress() {
        const identity = await this.host.identity();
        const progress = parseProgress(await this.host.chatExtensionGet(PROGRESS_NAMESPACE));
        if (progress.stableChatId !== null && progress.stableChatId !== identity.stableId) {
            throw new ToolkitError('PROGRESS_CHAT_MISMATCH', '当前聊天中的清洗进度身份不匹配。');
        }
        this.mutable.progress = progress;
        this.log.debug('progress.loaded', { data: { assistantThrough: progress.assistantThrough, userThrough: progress.userThrough } });
        this.notify();
        return progress;
    }
    async resetProgress() {
        try {
            const identity = await this.host.identity();
            await this.host.chatExtensionSet(identity.stableId, PROGRESS_NAMESPACE, null);
            this.mutable.progress = createDefaultProgress();
            this.log.warn('progress.reset', { data: { chatAlias: this.host.chatAlias(identity.stableId) }, sensitive: { stableChatId: identity.stableId } });
            this.notify();
        }
        catch (error) {
            logCleanerFailure(this.log, 'progress.reset_failed', 'progress.reset', error);
            throw error;
        }
    }
    async buildPlan(snapshot, options) {
        const settings = structuredClone(this.mutable.settings);
        let plan = buildOperationPlan(snapshot, settings, options);
        const coldIndexes = plan.targetIndexes.filter(index => snapshot.messages[index]?.tt_swipe_cold);
        const loadFailures = [];
        for (const messageIndex of coldIndexes) {
            try {
                await this.host.hydrateChatSwipes(snapshot.identity, messageIndex);
            }
            catch (error) {
                if (error instanceof ToolkitError && ['CHAT_CHANGED', 'COMMIT_CONFLICT'].includes(error.code))
                    throw error;
                loadFailures.push(messageIndex);
            }
        }
        if (coldIndexes.length) {
            const refreshed = await this.host.snapshot();
            if (!sameConversationIdentity(refreshed.identity, snapshot.identity))
                throw new ToolkitError('CHAT_CHANGED', '候选读回期间聊天已切换，请重新预览。');
            snapshot = refreshed;
            plan = buildOperationPlan(refreshed, settings, options);
        }
        for (const messageIndex of loadFailures) {
            const role = classifyMessage(snapshot.messages[messageIndex], messageIndex);
            if (role === 'assistant' || role === 'user') {
                const key = role === 'assistant' ? 'assistantThrough' : 'userThrough';
                plan.nextProgress[key] = Math.min(plan.nextProgress[key], messageIndex - 1);
            }
            plan.issues.push({ messageIndex, field: 'tt_swipe_cold', expected: 'hydrated-swipes', actualType: 'object',
                reason: 'cold-swipes-load-failed', stage: 'cleaner.hydration', sourceLocation: 'chat-cleaner/runtime.js:buildPlan',
                outcome: 'unloaded-fields-preserved', nextAction: 'reload-and-rebuild' });
            plan.warnings.push(`楼层 ${messageIndex}：冷候选读回失败，未加载正文/信息保持不变，不能清除其它候选。请重载聊天后重试。`);
        }
        if (rulesFingerprint(settings) !== rulesFingerprint(this.mutable.settings))
            throw new ToolkitError('STALE_PLAN', '候选读回期间设置已变化，请重新预览。');
        plan.stats.degradedMessages = new Set(plan.issues.map(issue => issue.messageIndex)).size;
        for (const issue of plan.issues)
            this.log.warn('message.degraded', { data: { operation: `cleaner.${options.mode}`, stage: 'cleaner.planning', ...issue } });
        return plan;
    }
    async previewManual(keep) {
        return this.runBusy('cleaner.preview', async () => {
            this.mutable.currentPlan = null;
            const snapshot = await this.host.snapshot();
            const progress = await this.loadProgress();
            await this.host.assertIdentity(snapshot.identity.stableId, snapshot.identity.ref);
            const plan = await this.buildPlan(snapshot, { mode: 'manual', keep, progress });
            this.mutable.currentPlan = plan;
            this.mutable.status = `预览完成：共 ${plan.stats.totalMessages} 层，排除明确 system ${plan.stats.excludedSystemMessages} 层、tool ${plan.stats.excludedToolMessages} 层，扫描 ${plan.stats.scannedMessages} 层，计划修改 ${plan.stats.changedMessages} 层，清除 ${plan.stats.removedSwipes} 个其它候选。${plan.issues.length ? ` ${plan.stats.degradedMessages} 层存在局部异常，详见预览警告。` : ''}`;
            this.log.info('manual.preview_created', { data: { chatAlias: this.host.chatAlias(plan.identity.stableId), keep, ...plan.stats, warningCount: plan.warnings.length }, sensitive: { chatIdentity: plan.identity } });
            return plan;
        });
    }
    async commitManual(allowEmpty, expectedPlan = this.mutable.currentPlan) {
        await this.runBusy('cleaner.commit', async () => {
            const plan = this.mutable.currentPlan;
            if (plan !== expectedPlan)
                throw new ToolkitError('STALE_PLAN', '确认期间清洗计划已改变，请重新预览并确认。');
            if (!plan || plan.mode !== 'manual')
                throw new ToolkitError('NO_PLAN', '没有可提交的手动清洗计划。');
            if (!allowEmpty && plan.changes.some(change => change.emptySwipeIndexes.length > 0)) {
                throw new ToolkitError('EMPTY_CONFIRM_REQUIRED', '计划包含将变为空的 swipe，需要额外确认。');
            }
            if (plan.changes.length > 0)
                await commitOperation(this.host, plan, this.log);
            try {
                await this.host.assertIdentity(plan.identity.stableId, plan.identity.ref);
                await this.host.chatExtensionSet(plan.identity.stableId, PROGRESS_NAMESPACE, plan.nextProgress);
                this.mutable.progress = plan.nextProgress;
            }
            catch (error) {
                throw new ToolkitError('PROGRESS_SAVE_FAILED', `聊天可能已保存，但增量进度保存失败：${errorMessage(error)}`);
            }
            this.mutable.status = `手动清洗完成：修改 ${plan.stats.changedMessages} 层，删除 ${plan.stats.removedChars} 个字符，清除 ${plan.stats.removedSwipes} 个其它候选。${plan.warnings.length ? ` 局部警告：${plan.warnings.join('；')}` : ''}`;
            this.log.info('manual.committed', { data: { chatAlias: this.host.chatAlias(plan.identity.stableId), allowEmpty, ...plan.stats }, sensitive: { chatIdentity: plan.identity } });
            this.mutable.currentPlan = null;
        });
    }
    syncAutoSubscription() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (!this.mutable.active || !this.mutable.settings.auto.enabled)
            return;
        this.log.debug('auto.subscribed');
        this.unsubscribe = this.host.onGenerationEnded(messageIndex => {
            this.queue = this.queue.then(() => this.runAutomatic(messageIndex), () => this.runAutomatic(messageIndex));
        });
    }
    async runAutomatic(messageIndex) {
        if (this.mutable.busy || !this.mutable.active || !this.mutable.settings.auto.enabled)
            return;
        this.mutable.busy = true;
        this.mutable.error = '';
        this.notify();
        try {
            const snapshot = await this.host.snapshot();
            // TauriTavern 在消息入列后才于 hideStopButton() 发出 GENERATION_ENDED，负载是 chat.length
            // （比新消息索引大 1）；legacy 契约则约定为“最后一条消息的索引”。两种语义都落到同一目标。
            const raw = snapshot.messages[messageIndex] ?? snapshot.messages[messageIndex - 1];
            if (!raw || classifyMessage(raw, messageIndex) !== 'assistant') {
                this.log.debug('auto.skipped', { data: { messageIndex } });
                return;
            }
            this.log.debug('auto.triggered', { data: { messageIndex } });
            const progress = await this.loadProgress();
            await this.host.assertIdentity(snapshot.identity.stableId, snapshot.identity.ref);
            const plan = await this.buildPlan(snapshot, { mode: 'auto', progress });
            if (!this.mutable.active || !this.mutable.settings.auto.enabled)
                return;
            if (plan.baselineOnly) {
                await this.host.chatExtensionSet(plan.identity.stableId, PROGRESS_NAMESPACE, plan.nextProgress);
                this.mutable.progress = plan.nextProgress;
                this.mutable.status = '自动清洗已建立新基线，未回扫旧楼层。';
                this.log.info('auto.baseline_created', { data: { chatAlias: this.host.chatAlias(plan.identity.stableId), messageIndex }, sensitive: { chatIdentity: plan.identity } });
                return;
            }
            if (plan.changes.some(change => change.emptySwipeIndexes.length > 0)) {
                throw new ToolkitError('AUTO_EMPTY_REJECTED', '自动清洗会产生空 swipe，整批已拒绝；请使用手动预览处理。');
            }
            if (plan.changes.length > 0)
                await commitOperation(this.host, plan, this.log);
            await this.host.assertIdentity(plan.identity.stableId, plan.identity.ref);
            const rolledBack = plan.rollback.assistant || plan.rollback.user;
            if (rolledBack) {
                this.log.warn('auto.watermark_rolled_back', {
                    data: { chatAlias: this.host.chatAlias(plan.identity.stableId), messageIndex, assistant: plan.rollback.assistant, user: plan.rollback.user },
                    sensitive: { chatIdentity: plan.identity },
                });
            }
            await this.host.chatExtensionSet(plan.identity.stableId, PROGRESS_NAMESPACE, plan.nextProgress);
            this.mutable.progress = plan.nextProgress;
            this.mutable.status = `自动清洗完成：修改 ${plan.stats.changedMessages} 层，删除 ${plan.stats.removedChars} 个字符，清除 ${plan.stats.removedSwipes} 个其它候选。${rolledBack ? '检测到楼层删除，已回滚越界清洗断点。' : ''}${plan.warnings.length ? ` 局部警告：${plan.warnings.join('；')}` : ''}`;
            this.log.info('auto.committed', { data: { chatAlias: this.host.chatAlias(plan.identity.stableId), messageIndex, ...plan.stats }, sensitive: { chatIdentity: plan.identity } });
        }
        catch (error) {
            logCleanerFailure(this.log, 'auto.failed', 'cleaner.auto', error);
            this.mutable.error = errorMessage(error);
            this.mutable.status = `自动清洗失败：${errorMessage(error)}`;
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }
    async runBusy(operation, task) {
        if (this.mutable.busy)
            throw new ToolkitError('BUSY', '聊天清洗正在执行其它操作。');
        this.mutable.busy = true;
        this.mutable.error = '';
        this.notify();
        try {
            return await task();
        }
        catch (error) {
            logCleanerFailure(this.log, 'operation.failed', operation, error);
            this.mutable.error = errorMessage(error);
            throw error;
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }
}
