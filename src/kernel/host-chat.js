import { ToolkitError } from './errors.js';
import { sameConversationIdentity } from './chat-projection.js';
import { identityLabel } from './host-abi.js';

function noChat() {
    return new ToolkitError('NO_CHAT', '无法读取当前聊天身份，请打开或重载聊天后重试。');
}

function currentHandle(current) {
    if (typeof current?.handle !== 'function' || typeof current?.ref !== 'function')
        throw new ToolkitError('HOST_ABI_MISSING', '宿主缺少当前聊天身份接口。');
    try {
        return current.handle();
    }
    catch {
        throw noChat();
    }
}

async function handleIdentity(handle) {
    const ref = handle?.ref;
    if (typeof handle?.stableId !== 'function' || !ref)
        throw new ToolkitError('HOST_ABI_MISSING', '宿主聊天 handle 缺少身份接口。');
    let stableId;
    try {
        stableId = await handle.stableId();
    }
    catch {
        throw noChat();
    }
    if (typeof stableId !== 'string' || !stableId.trim())
        throw noChat();
    return { stableId, label: identityLabel(ref), ref };
}

function matchesCurrentRef(current, identity) {
    try {
        return sameConversationIdentity(identity, { stableId: identity.stableId, ref: current.ref() });
    }
    catch {
        return false;
    }
}

function chatChanged() {
    return new ToolkitError('CHAT_CHANGED', '操作期间当前聊天已切换。');
}

function matchesLiveMetadata(host, current, identity, metadata) {
    return matchesCurrentRef(current, identity) && host.context.chatMetadata === metadata;
}

function mirrorMetadataExtension(metadata, namespace, value) {
    const extensions = metadata.extensions;
    if (extensions !== undefined && (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)))
        return false;
    if (value === null) {
        if (extensions)
            delete extensions[namespace];
    }
    else if (extensions) {
        extensions[namespace] = value;
    }
    else {
        metadata.extensions = { [namespace]: value };
    }
    return true;
}

export const chatMethods = {
    async identity() {
        const current = this.abi.api.chat.current;
        const identity = await handleIdentity(currentHandle(current));
        if (!matchesCurrentRef(current, identity))
            throw chatChanged();
        const { stableId } = identity;
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
            throw chatChanged();
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
    onGenerationEnded(handler, onSkipped = () => {}) {
        const current = this.abi.api.chat.current;
        const disposers = [];
        let round;
        let revision = 0;
        let groupStopped = false;
        const finish = async candidate => {
            let unavailable = false;
            try {
                await this.generationIdlePromise();
            }
            catch {
                // A missing export throws synchronously; report it outside the event dispatch.
                await Promise.resolve();
                unavailable = true;
            }
            if (candidate !== round)
                return;
            round = undefined;
            if (candidate.stopped || !candidate.sameChat())
                return;
            if (unavailable) {
                onSkipped('HOST_GENERATION_IDLE_UNAVAILABLE');
                return;
            }
            const stillCurrent = () => candidate.revision === revision && candidate.sameChat()
                && this.context.chat?.length === candidate.length && this.context.chat?.[candidate.length - 1] === candidate.tail;
            if (candidate.length === undefined || !stillCurrent() || !candidate.replyChanged(candidate.tail)) {
                onSkipped('CLEANER_GENERATION_END_UNCONFIRMED');
                return;
            }
            handler(candidate.length, stillCurrent);
        };
        const add = (name, listener, options) => disposers.push(this.onHostEvent(name, listener, options));
        const dispose = () => {
            revision++;
            round = undefined;
            groupStopped = false;
            for (const unsubscribe of disposers.splice(0))
                unsubscribe();
        };
        try {
            add('GENERATION_STARTED', (type, _options, dryRun) => {
                if (dryRun === true)
                    return;
                revision++;
                round = undefined;
                if (dryRun !== false || !['normal', 'regenerate', 'swipe', 'continue'].includes(type))
                    return;
                let ref;
                try {
                    ref = current.ref();
                }
                catch {
                    return;
                }
                const { chat, chatMetadata } = this.context;
                if (!Array.isArray(chat))
                    return;
                const oldLength = chat.length;
                const previous = chat[oldLength - 1];
                const { mes, swipe_id, gen_finished } = previous ?? {};
                const oldFinish = gen_finished instanceof Date ? gen_finished.getTime() : gen_finished;
                round = {
                    revision,
                    group: this.groupModule.is_group_generating,
                    stopped: groupStopped,
                    sameChat: () => matchesCurrentRef(current, { ref }) && this.context.chatMetadata === chatMetadata,
                    replyChanged: tail => this.context.chat.length !== oldLength || tail !== previous
                        || tail?.mes !== mes || tail?.swipe_id !== swipe_id
                        || (tail?.gen_finished instanceof Date ? tail.gen_finished.getTime() : tail?.gen_finished) !== oldFinish,
                };
                // The emitter awaits listeners; awaiting idle here would deadlock Generate().
                if (!round.group)
                    void finish(round);
            }, { first: true });
            add('GENERATION_STOPPED', () => {
                revision++;
                if (round)
                    round.stopped = true;
                if (this.groupModule.is_group_generating)
                    groupStopped = true;
            }, { first: true });
            add('GENERATION_ENDED', length => {
                const chat = this.context.chat;
                if (!round || round.stopped || !Number.isSafeInteger(length) || length <= 0 || length !== chat?.length)
                    return;
                round.length = length;
                round.tail = chat[length - 1];
            }, { first: true });
            add('GROUP_WRAPPER_FINISHED', () => {
                if (round?.group && !this.groupModule.is_group_generating)
                    void finish(round);
                groupStopped = false;
            });
            add('CHAT_CHANGED', () => {
                revision++;
                round = undefined;
                groupStopped = false;
            });
        }
        catch (error) {
            dispose();
            throw error;
        }
        this.log?.debug('event.generation_ended_subscribed');
        return dispose;
    },
    async chatExtensionGet(namespace) {
        const metadata = await this.abi.api.chat.current.handle().metadata.get();
        const extensions = metadata.extensions;
        return extensions && typeof extensions === 'object' && !Array.isArray(extensions)
            ? extensions[namespace]
            : undefined;
    },
    async chatExtensionSet(expectedStableId, namespace, value, { expectedRef, beforeWrite } = {}) {
        const cloned = structuredClone(value);
        const current = this.abi.api.chat.current;
        const handle = currentHandle(current);
        const metadata = this.context.chatMetadata;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
            throw new ToolkitError('HOST_CHAT_METADATA_UNAVAILABLE', '当前聊天 metadata 不可用，请重载聊天后重试。');
        if (typeof handle?.metadata?.setExtension !== 'function')
            throw new ToolkitError('HOST_ABI_MISSING', '宿主缺少聊天 metadata 写入接口。');
        const identity = await handleIdentity(handle);
        if (!sameConversationIdentity(identity, { stableId: expectedStableId, ref: expectedRef ?? identity.ref })
            || !matchesLiveMetadata(this, current, identity, metadata))
            throw chatChanged();
        beforeWrite?.();
        await handle.metadata.setExtension({ namespace, value: cloned });

        // The file commit and the live mirror are separate; a failed recheck cannot undo the commit.
        try {
            if (matchesLiveMetadata(this, current, identity, metadata)
                && await handle.stableId() === expectedStableId
                && matchesLiveMetadata(this, current, identity, metadata)
                && mirrorMetadataExtension(metadata, namespace, cloned)) {
                return { persisted: true, localMirror: true };
            }
        }
        catch {
            // Closed, invalid or unwritable local context must not be reported as a failed file commit.
        }
        this.log?.warn('chat.metadata_mirror_skipped', { data: {
            operation: 'chat.metadata.setExtension', stage: 'local-mirror', code: 'CHAT_METADATA_MIRROR_SKIPPED',
            sourceLocation: 'host-chat.js:chatExtensionSet', outcome: 'file-commit-succeeded', nextAction: 'reopen-original-chat',
        } });
        return { persisted: true, localMirror: false };
    },
    async getCurrentChatIdentity() {
        return this.identity();
    }
};
