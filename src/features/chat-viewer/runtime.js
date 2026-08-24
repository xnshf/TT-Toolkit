import { ToolkitError, errorKind, errorMessage } from '../../kernel/errors.js';
import { buildChatViewModel, matchesMessageTarget, searchChatMessages, selectChatRange } from './model.js';

export class ChatViewerRuntime {
    mutable = {
        active: false,
        busy: false,
        stale: false,
        model: null,
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

    async activate() {
        this.unsubscribe?.();
        const unsubscribe = this.host.onChatMutated(event => {
            this.mutable.stale = true;
            this.mutable.status = '当前聊天已发生变化，将在下次操作时重新读取。';
            this.log.debug('snapshot.marked_stale', { data: { eventType: event.type } });
            this.notify();
        });
        this.unsubscribe = unsubscribe;
        this.mutable.active = true;
        this.log.info('activated');
        this.notify();
    }

    async deactivate() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.mutable.active = false;
        this.mutable.model = null;
        this.mutable.stale = false;
        this.mutable.error = '';
        this.mutable.status = '功能已停用。';
        this.log.info('deactivated');
        this.notify();
    }

    async refresh() {
        return this.runBusy('chat.snapshot', async () => {
            const model = buildChatViewModel(await this.host.snapshot());
            this.mutable.model = model;
            this.mutable.stale = false;
            this.mutable.status = `已读取 ${model.stats.conversationMessages} 个对话楼层。`;
            this.log.info('snapshot.loaded', {
                data: {
                    chatAlias: this.host.chatAlias(model.identity.stableId),
                    ...model.stats,
                },
                sensitive: { stableChatId: model.identity.stableId },
            });
            return model;
        });
    }

    async ensureFresh() {
        return !this.mutable.model || this.mutable.stale ? this.refresh() : this.mutable.model;
    }

    async range(start, end) {
        return this.runBusy('chat.range', async () => {
            const model = await this.ensureFresh();
            return { model, items: selectChatRange(model, start, end) };
        });
    }

    async search(query) {
        return this.runBusy('chat.search', async () => {
            const model = await this.ensureFresh();
            return { model, items: searchChatMessages(model, query) };
        });
    }

    async jump(item) {
        return this.runBusy('chat.jump', async () => {
            const previousModel = this.mutable.model;
            if (!previousModel)
                throw new ToolkitError('NO_SNAPSHOT', '请先读取当前聊天。');
            const snapshot = await this.host.snapshot();
            const refreshed = buildChatViewModel(snapshot);
            this.mutable.model = refreshed;
            this.mutable.stale = false;
            if (refreshed.identity.stableId !== previousModel.identity.stableId) {
                this.mutable.status = '当前聊天已切换，请重新选择目标楼层。';
                throw new ToolkitError('CHAT_CHANGED', this.mutable.status);
            }
            const refreshedItem = refreshed.items[item.conversationIndex - 1];
            if (!refreshedItem
                || refreshedItem.absoluteIndex !== item.absoluteIndex
                || !matchesMessageTarget(snapshot.messages[item.absoluteIndex], item)) {
                this.mutable.status = '目标楼层在聊天变化后已移动或修改，请重新选择。';
                throw new ToolkitError('MESSAGE_CHANGED', this.mutable.status);
            }
            await this.host.jumpToMessage(refreshed.identity.stableId, item.absoluteIndex);
            this.mutable.status = `已跳转到对话楼层 ${item.conversationIndex}。`;
            this.log.info('message.jumped', {
                data: {
                    chatAlias: this.host.chatAlias(refreshed.identity.stableId),
                    conversationIndex: item.conversationIndex,
                    absoluteIndex: item.absoluteIndex,
                },
                sensitive: { stableChatId: refreshed.identity.stableId },
            });
            return refreshedItem;
        });
    }

    async runBusy(operation, task) {
        const nested = this.mutable.busy;
        if (!nested) {
            this.mutable.busy = true;
            this.mutable.error = '';
            this.notify();
        }
        try {
            return await task();
        }
        catch (error) {
            if (!nested) {
                this.log.error('operation.failed', { data: { operation, ...errorKind(error) }, sensitive: { error } });
                this.mutable.error = errorMessage(error);
            }
            throw error;
        }
        finally {
            if (!nested) {
                this.mutable.busy = false;
                this.notify();
            }
        }
    }
}
