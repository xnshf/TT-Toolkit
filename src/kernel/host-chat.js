import { ToolkitError } from './errors.js';
import { sameConversationIdentity } from './chat-projection.js';
import { identityLabel } from './host-abi.js';

// chatMethods: 由 host.js 按宿主能力拆分，方法体与拆分前一致。
export const chatMethods = {
    async identity() {
        const ref = this.abi.api.chat.current.ref();
        const stableId = await this.abi.api.chat.current.handle().stableId();
        if (!stableId)
            throw new ToolkitError('NO_CHAT', '当前聊天缺少稳定身份。');
        const identity = { stableId, label: identityLabel(ref), ref };
        this.log?.debug('chat.identity_resolved', { data: { chatAlias: this.chatAlias(stableId) }, sensitive: identity });
        return identity;
    },
    async snapshot() {
        const identity = await this.identity();
        const messages = this.context.chat;
        this.log?.debug('chat.snapshot_created', { data: { chatAlias: this.chatAlias(identity.stableId), messageCount: messages.length }, sensitive: { stableChatId: identity.stableId } });
        return { identity, messages: structuredClone(messages) };
    },
    async hydrateChatSwipes(identity, messageIndex) {
        await this.assertIdentity(identity.stableId, identity.ref);
        const message = this.context.chat[messageIndex];
        if (!message?.tt_swipe_cold)
            return;
        if (typeof this.scriptModule.hydrateChatMessageSwipes !== 'function')
            throw new ToolkitError('HOST_SWIPE_EXPORT_MISSING', '宿主缺少候选读回接口，未加载候选已保留。');
        let loaded;
        try {
            loaded = await this.scriptModule.hydrateChatMessageSwipes(messageIndex);
        }
        catch {
            await this.assertIdentity(identity.stableId, identity.ref);
            if (this.context.chat[messageIndex] !== message)
                throw new ToolkitError('COMMIT_CONFLICT', '候选读回期间楼层已改变，请重新预览。', { messageIndex });
            throw new ToolkitError('SWIPE_LOAD_FAILED', '候选读回失败，未加载候选已保留。', { messageIndex });
        }
        await this.assertIdentity(identity.stableId, identity.ref);
        if (!loaded || this.context.chat[messageIndex] !== message)
            throw new ToolkitError('COMMIT_CONFLICT', '候选读回期间楼层已改变，请重新预览。', { messageIndex });
    },
    async assertIdentity(expectedStableId, expectedRef) {
        const current = await this.identity();
        if (current.stableId !== expectedStableId || (expectedRef !== undefined
            && !sameConversationIdentity(current, { stableId: expectedStableId, ref: expectedRef })))
            throw new ToolkitError('CHAT_CHANGED', '操作期间当前聊天已切换。');
    },
    async saveCurrentChat() {
        this.log?.info('chat.save_started', { data: { kind: this.groupModule.selected_group ? 'group' : 'character' } });
        if (this.groupModule.selected_group) {
            await this.groupModule.saveGroupChat(this.groupModule.selected_group, true);
        }
        else {
            await this.scriptModule.saveChat();
        }
        this.log?.info('chat.save_completed');
    },
    async reloadCurrentChat() {
        await this.scriptModule.reloadCurrentChat();
        this.log?.info('chat.reloaded');
    },
    onChatMutated(handler) {
        const context = this.context;
        const eventNames = [
            'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED',
            'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED',
        ];
        if (!context.eventSource?.on || (!context.eventSource?.off && !context.eventSource?.removeListener)) {
            throw new ToolkitError('HOST_EVENT_MISSING', 'TauriTavern 缺少聊天事件源。');
        }
        const remove = typeof context.eventSource.off === 'function'
            ? context.eventSource.off.bind(context.eventSource)
            : context.eventSource.removeListener.bind(context.eventSource);
        const events = eventNames.map(name => {
            const event = context.eventTypes[name];
            if (!event)
                throw new ToolkitError('HOST_EVENT_MISSING', `TauriTavern 缺少 ${name} 事件。`);
            return event;
        });
        const subscriptions = events.map(event => {
            const wrapped = (...args) => handler({ type: event, args });
            context.eventSource.on(event, wrapped);
            return { event, wrapped };
        });
        this.log?.debug('event.chat_mutations_subscribed', { data: { eventCount: subscriptions.length } });
        return () => {
            for (const { event, wrapped } of subscriptions)
                remove(event, wrapped);
            this.log?.debug('event.chat_mutations_unsubscribed');
        };
    },
    async jumpToMessage(expectedStableId, messageIndex) {
        await this.assertIdentity(expectedStableId);
        const context = this.context;
        if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex >= context.chat.length) {
            throw new ToolkitError('INVALID_MESSAGE_INDEX', `跳转楼层必须在 0 到 ${Math.max(0, context.chat.length - 1)} 之间。`, { messageIndex });
        }
        if (typeof context.executeSlashCommandsWithOptions !== 'function') {
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 缺少聊天跳转命令执行器。');
        }
        const result = await context.executeSlashCommandsWithOptions(`/chat-jump ${messageIndex}`, {
            handleParserErrors: false,
            handleExecutionErrors: false,
        });
        if (result?.isError)
            throw new ToolkitError('CHAT_JUMP_FAILED', result.errorMessage || 'TauriTavern 聊天跳转失败。', { messageIndex });
        this.log?.info('chat.message_jumped', { data: { chatAlias: this.chatAlias(expectedStableId), messageIndex }, sensitive: { stableChatId: expectedStableId } });
    },
    onGenerationEnded(handler) {
        const context = this.context;
        const event = context.eventTypes.GENERATION_ENDED;
        if (!event)
            throw new ToolkitError('HOST_EVENT_MISSING', 'TauriTavern 缺少 GENERATION_ENDED 事件。');
        const wrapped = (messageIndex) => handler(Number(messageIndex));
        context.eventSource.on(event, wrapped);
        this.log?.debug('event.generation_ended_subscribed');
        const remove = typeof context.eventSource.off === 'function'
            ? context.eventSource.off.bind(context.eventSource)
            : context.eventSource.removeListener?.bind(context.eventSource);
        if (!remove)
            throw new ToolkitError('HOST_EVENT_MISSING', 'TauriTavern 缺少事件移除方法。');
        return () => {
            remove(event, wrapped);
            this.log?.debug('event.generation_ended_unsubscribed');
        };
    },
    async chatExtensionGet(namespace) {
        const metadata = await this.abi.api.chat.current.handle().metadata.get();
        const extensions = metadata.extensions;
        return extensions && typeof extensions === 'object' && !Array.isArray(extensions)
            ? extensions[namespace]
            : undefined;
    },
    async chatExtensionSet(expectedStableId, namespace, value) {
        await this.assertIdentity(expectedStableId);
        const cloned = structuredClone(value);
        await this.abi.api.chat.current.handle().metadata.setExtension({ namespace, value: cloned });
        const metadata = this.context.chatMetadata;
        if (!metadata.extensions || typeof metadata.extensions !== 'object' || Array.isArray(metadata.extensions))
            metadata.extensions = {};
        if (cloned === null)
            delete metadata.extensions[namespace];
        else
            metadata.extensions[namespace] = cloned;
    },
    async getCurrentChatIdentity() {
        return this.identity();
    }
};
