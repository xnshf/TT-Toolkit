import { matchesProjectedMessageTarget, projectConversationSnapshot } from '../../kernel/chat-projection.js';
import { ToolkitError, errorKind, errorMessage } from '../../kernel/errors.js';
import { parseSettings as parseCleanerSettings } from '../chat-cleaner/schema.js';
import { buildChatExportPlan } from './model.js';
import { chatDocumentFilename, serializeChatDocument } from './serialize.js';
import { createDefaultExportSettings, parseExportSettings } from './schema.js';

const SETTINGS_KEY = 'chat-exporter-settings-v1';
const CLEANER_SETTINGS_KEY = 'chat-cleaner-settings-v1';

export class ChatExporterRuntime {
    mutable = {
        active: false,
        busy: false,
        stale: false,
        settings: createDefaultExportSettings(),
        model: null,
        currentPlan: null,
        status: '尚未读取当前聊天。',
        error: '',
    };
    state = this.mutable;
    listeners = new Set();
    unsubscribe = null;
    notifyScheduled = false;

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
            this.mutable.settings = parseExportSettings(await this.host.globalGet(SETTINGS_KEY));
            this.log.debug('settings.loaded', { data: this.settingsSummary(this.mutable.settings) });
        }
        catch (error) {
            this.mutable.settings = createDefaultExportSettings();
            this.mutable.error = errorMessage(error);
            this.mutable.status = `导出配置读取失败，已使用安全默认值：${errorMessage(error)}`;
            this.log.error('settings.load_failed', { data: { operation: 'settings.load', ...errorKind(error) }, sensitive: { error } });
        }
        this.notify();
    }

    async activate() {
        this.unsubscribe?.();
        this.unsubscribe = this.host.onChatMutated(event => {
            this.mutable.stale = true;
            this.mutable.status = '当前聊天已发生变化，原预览不可下载。';
            this.log.debug('preview.marked_stale', { data: { eventType: event.type } });
            this.notify();
        });
        this.mutable.active = true;
        this.log.info('activated');
        this.notify();
    }

    async deactivate() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.mutable.active = false;
        this.mutable.stale = false;
        this.mutable.model = null;
        this.mutable.currentPlan = null;
        this.mutable.error = '';
        this.mutable.status = '功能已停用。';
        this.log.info('deactivated');
        this.notify();
    }

    async refresh() {
        return this.runBusy('chat.snapshot', async () => {
            const model = projectConversationSnapshot(await this.host.snapshot());
            this.mutable.model = model;
            this.mutable.currentPlan = null;
            this.mutable.stale = false;
            this.mutable.status = `已读取 ${model.stats.conversationMessages} 个对话楼层。`;
            this.log.info('snapshot.loaded', {
                data: { chatAlias: this.host.chatAlias(model.identity.stableId), ...model.stats },
                sensitive: { stableChatId: model.identity.stableId },
            });
            return model;
        });
    }

    async saveSettings(value) {
        return this.runBusy('settings.save', async () => {
            const settings = parseExportSettings(value);
            await this.host.globalSet(SETTINGS_KEY, settings);
            this.mutable.settings = settings;
            this.mutable.currentPlan = null;
            this.mutable.stale = false;
            this.mutable.status = '聊天导出设置已保存，请生成新预览。';
            this.log.info('settings.saved', { data: this.settingsSummary(settings) });
            return settings;
        });
    }

    async copyCleanerRules() {
        return this.runBusy('rules.copy_cleaner', async () => {
            const cleaner = parseCleanerSettings(await this.host.globalGet(CLEANER_SETTINGS_KEY));
            const next = structuredClone(this.mutable.settings);
            next.assistant.excludeRules = structuredClone(cleaner.assistant.rules);
            next.user.excludeRules = structuredClone(cleaner.user.rules);
            const settings = parseExportSettings(next);
            await this.host.globalSet(SETTINGS_KEY, settings);
            this.mutable.settings = settings;
            this.mutable.currentPlan = null;
            this.mutable.stale = false;
            this.mutable.status = '已复制聊天清洗的反选规则；处理策略未改变。';
            this.log.info('rules.copied_from_cleaner', {
                data: { assistantRules: settings.assistant.excludeRules.length, userRules: settings.user.excludeRules.length },
            });
            return settings;
        });
    }

    async preview(start, end) {
        return this.runBusy('export.preview', async () => {
            const snapshot = await this.host.snapshot();
            const plan = buildChatExportPlan(snapshot, this.mutable.settings, { start, end });
            this.mutable.model = projectConversationSnapshot(snapshot);
            this.mutable.currentPlan = plan;
            this.mutable.stale = false;
            this.mutable.status = `预览完成：输出 ${plan.stats.exportedMessages} 条，跳过 ${plan.stats.skippedMessages} 条。`;
            this.log.info('preview.created', {
                data: { chatAlias: this.host.chatAlias(plan.identity.stableId), ...plan.stats, format: plan.settings.format },
                sensitive: { stableChatId: plan.identity.stableId },
            });
            return plan;
        });
    }

    async prepareDownload(title, confirmedWarnings = false) {
        return this.runBusy('export.prepare', async () => {
            const plan = this.mutable.currentPlan;
            if (!plan)
                throw new ToolkitError('NO_PLAN', '请先生成导出预览');
            if (this.mutable.stale)
                throw new ToolkitError('STALE_PLAN', '当前聊天或设置已变化，请重新生成预览');
            if (plan.requiresConfirmation && !confirmedWarnings)
                throw new ToolkitError('EXPORT_CONFIRM_REQUIRED', '预览包含会跳过消息或标记不完整的警告，需要手动确认');
            const snapshot = await this.host.snapshot();
            const refreshed = projectConversationSnapshot(snapshot);
            if (refreshed.identity.stableId !== plan.identity.stableId || refreshed.items.length !== plan.projectionStats.conversationMessages) {
                this.mutable.stale = true;
                throw new ToolkitError('CHAT_CHANGED', '当前聊天已切换或楼层结构已变化，请重新生成预览');
            }
            for (const item of plan.sourceItems) {
                const current = refreshed.items[item.conversationIndex - 1];
                if (!current || current.absoluteIndex !== item.absoluteIndex || !matchesProjectedMessageTarget(snapshot.messages[item.absoluteIndex], item)) {
                    this.mutable.stale = true;
                    throw new ToolkitError('MESSAGE_CHANGED', `对话楼层 ${item.conversationIndex} 已变化，请重新生成预览`);
                }
            }
            const format = plan.settings.format;
            return {
                content: serializeChatDocument(plan, { title, format }),
                filename: chatDocumentFilename(title, format),
                format,
                stats: plan.stats,
            };
        });
    }

    downloadSuggestion(title) {
        const plan = this.mutable.currentPlan;
        if (!plan)
            throw new ToolkitError('NO_PLAN', '请先生成导出预览');
        if (this.mutable.stale)
            throw new ToolkitError('STALE_PLAN', '当前聊天或设置已变化，请重新生成预览');
        return {
            filename: chatDocumentFilename(title, plan.settings.format),
            format: plan.settings.format,
        };
    }

    downloaded(payload) {
        this.mutable.status = `已导出 ${payload.stats.exportedMessages} 条消息。`;
        this.log.info('document.saved', { data: { format: payload.format, ...payload.stats } });
        this.notify();
    }

    fileFailed(error) {
        this.log.error('document.save_failed', { data: { operation: 'export.file', ...errorKind(error) } });
    }

    settingsSummary(settings) {
        return {
            format: settings.format,
            anonymous: settings.anonymous,
            roleFilter: settings.roleFilter,
            assistantStrategy: settings.assistant.strategy,
            assistantIncludeRules: settings.assistant.includeRules.length,
            assistantExcludeRules: settings.assistant.excludeRules.length,
            userStrategy: settings.user.strategy,
            userIncludeRules: settings.user.includeRules.length,
            userExcludeRules: settings.user.excludeRules.length,
        };
    }

    async runBusy(operation, task) {
        if (this.mutable.busy)
            throw new ToolkitError('BUSY', '聊天导出正在执行其它操作');
        this.mutable.busy = true;
        this.mutable.error = '';
        this.notify();
        try {
            return await task();
        }
        catch (error) {
            this.mutable.error = errorMessage(error);
            this.log.error('operation.failed', { data: { operation, ...errorKind(error) }, sensitive: { error } });
            throw error;
        }
        finally {
            this.mutable.busy = false;
            this.notify();
        }
    }
}
