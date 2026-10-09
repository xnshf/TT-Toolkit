import { ToolkitError } from './errors.js';
import { sha256Hex } from './hash.js';
import { sameConversationIdentity } from './chat-projection.js';
import { valueType } from './chat-diagnostics.js';
import { WORLD_INFO_LORE_LISTS } from './world-info.js';
const SCRIPT_URL = '/script.js';
const CONTEXT_URL = '/scripts/st-context.js';
const GROUP_URL = '/scripts/group-chats.js';
const WORLD_INFO_URL = '/scripts/world-info.js';
const OPENAI_URL = '/scripts/openai.js';
const EXTENSIONS_URL = '/scripts/extensions.js';
const PROMPT_CONFLICT_CHAT_NAMESPACE = 'tt-toolkit.prompt-conflict';
const PROMPT_CONFLICT_INVALIDATION_EVENTS = [
    'SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER',
    'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'CHAT_CHANGED',
];
const PROMPT_VIEWER_AGENT_ONLY_IDENTIFIERS = new Set(['agentSystemPrompt', 'agentResults', 'agentTask']);
const PROMPT_VIEWER_TEXTAREA_ID = 'send_textarea';
function dynamicImport(url) {
    return import(url);
}
function requireAbi() {
    const abi = window.__TAURITAVERN__;
    if (!abi?.api?.chat || !abi.api.extension?.store || !abi.api.layout
        || typeof abi.invoke?.safeInvoke !== 'function') {
        throw new ToolkitError('HOST_ABI_MISSING', 'TauriTavern 必需 ABI 不可用，TT-Toolkit 已停止初始化。');
    }
    return abi;
}
function identityLabel(ref) {
    if (ref && typeof ref === 'object' && 'kind' in ref) {
        const candidate = ref;
        if (candidate.kind === 'group')
            return `群聊 ${String(candidate.chatId ?? '')}`;
        if (candidate.kind === 'character')
            return `角色聊天 ${String(candidate.characterId ?? '')} / ${String(candidate.fileName ?? '')}`;
    }
    return '当前聊天';
}
export class TauriTavernHost {
    namespace = 'tt-toolkit';
    abi;
    contextModule;
    scriptModule;
    groupModule;
    worldInfoModule;
    extensionsModule;
    log = null;
    chatAliases = new Map();
    setLogger(log) { this.log = log; }
    chatAlias(stableId) {
        let alias = this.chatAliases.get(stableId);
        if (!alias) {
            alias = `chat-${this.chatAliases.size + 1}`;
            this.chatAliases.set(stableId, alias);
        }
        return alias;
    }
    async initialize() {
        this.abi = requireAbi();
        if (this.abi.ready)
            await this.abi.ready;
        [this.contextModule, this.scriptModule, this.groupModule, this.worldInfoModule] = await Promise.all([
            dynamicImport(CONTEXT_URL),
            dynamicImport(SCRIPT_URL),
            dynamicImport(GROUP_URL),
            dynamicImport(WORLD_INFO_URL),
        ]);
        if (typeof this.contextModule.getContext !== 'function'
            || typeof this.scriptModule.saveChat !== 'function'
            || typeof this.scriptModule.reloadCurrentChat !== 'function'
            || typeof this.groupModule.saveGroupChat !== 'function'
            || typeof this.worldInfoModule.loadWorldInfo !== 'function'
            || typeof this.worldInfoModule.saveWorldInfo !== 'function') {
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 必需 legacy 导出不可用，TT-Toolkit 已停止初始化。');
        }
    }
    get context() {
        const context = this.contextModule.getContext();
        if (!Array.isArray(context.chat))
            throw new ToolkitError('NO_CHAT', '当前没有可用聊天。');
        return context;
    }
    async identity() {
        const ref = this.abi.api.chat.current.ref();
        const stableId = await this.abi.api.chat.current.handle().stableId();
        if (!stableId)
            throw new ToolkitError('NO_CHAT', '当前聊天缺少稳定身份。');
        const identity = { stableId, label: identityLabel(ref), ref };
        this.log?.debug('chat.identity_resolved', { data: { chatAlias: this.chatAlias(stableId) }, sensitive: identity });
        return identity;
    }
    async snapshot() {
        const identity = await this.identity();
        const messages = this.context.chat;
        this.log?.debug('chat.snapshot_created', { data: { chatAlias: this.chatAlias(identity.stableId), messageCount: messages.length }, sensitive: { stableChatId: identity.stableId } });
        return { identity, messages: structuredClone(messages) };
    }
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
    }
    async mountToolkitWandEntry(onOpen) {
        this.extensionsModule ??= await dynamicImport(EXTENSIONS_URL);
        const extensions = this.extensionsModule;
        if (typeof extensions.ensureExtensionsUiReady !== 'function'
            || typeof extensions.showHideExtensionsMenu !== 'function') {
            throw new ToolkitError('HOST_WAND_EXPORT_MISSING', '宿主缺少扩展菜单初始化接口。请保留悬浮球入口，重载宿主后重试。');
        }
        await extensions.ensureExtensionsUiReady();
        const menu = document.getElementById('extensionsMenu');
        const focusTarget = document.getElementById('extensionsMenuButton');
        if (!menu || !focusTarget) {
            throw new ToolkitError('HOST_WAND_DOM_MISSING', '宿主扩展菜单挂载点缺失。请保留悬浮球入口，重载宿主后重试。');
        }
        if (document.getElementById('tt-toolkit-wand-entry')) {
            throw new ToolkitError('HOST_WAND_ENTRY_DUPLICATE', 'TT-Toolkit 魔棒入口已存在，请重载宿主后重试。');
        }
        const element = document.createElement('div');
        element.id = 'tt-toolkit-wand-entry';
        element.className = 'list-group-item flex-container flexGap5';
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        element.title = '打开 TT-Toolkit';
        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-toolbox extensionsMenuExtensionButton';
        icon.setAttribute('aria-hidden', 'true');
        element.append(icon, document.createTextNode('TT-Toolkit'));
        const click = () => onOpen(focusTarget);
        const keydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                element.click();
            }
        };
        element.addEventListener('click', click);
        element.addEventListener('keydown', keydown);
        menu.append(element);
        const dispose = () => {
            element.removeEventListener('click', click);
            element.removeEventListener('keydown', keydown);
            element.remove();
            extensions.showHideExtensionsMenu();
        };
        try {
            extensions.showHideExtensionsMenu();
        } catch (error) {
            dispose();
            throw error;
        }
        return { element, focusTarget, dispose };
    }
    async globalGet(key) {
        const result = await this.abi.api.extension.store.tryGetJson({ namespace: this.namespace, key });
        this.log?.debug('store.global_read', { data: { key, found: result.found } });
        return result.found ? result.value : undefined;
    }
    async globalSet(key, value) {
        await this.abi.api.extension.store.setJson({ namespace: this.namespace, key, value: structuredClone(value) });
        this.log?.debug('store.global_written', { data: { key } });
    }
    async globalDelete(key) {
        await this.abi.api.extension.store.deleteJson({ namespace: this.namespace, key });
        this.log?.warn('store.global_deleted', { data: { key } });
    }
    async storeTryGetJson(table, key) {
        const result = await this.abi.api.extension.store.tryGetJson({ namespace: this.namespace, table, key });
        return result.found ? result.value : undefined;
    }
    async storeSetJson(table, key, value) {
        await this.abi.api.extension.store.setJson({ namespace: this.namespace, table, key, value: structuredClone(value) });
    }
    async storeDeleteJson(table, key) {
        await this.abi.api.extension.store.deleteJson({ namespace: this.namespace, table, key });
    }
    async storeSetBlob(table, key, data) {
        await this.abi.api.extension.store.setBlob({ namespace: this.namespace, table, key, data });
    }
    async storeGetBlob(table, key) {
        return this.abi.api.extension.store.getBlob({ namespace: this.namespace, table, key });
    }
    async storeDeleteBlob(table, key) {
        await this.abi.api.extension.store.deleteBlob({ namespace: this.namespace, table, key });
    }
    async storeDeleteTable(table) {
        await this.abi.api.extension.store.deleteTable({ namespace: this.namespace, table });
    }
    async getHostConsoleCaptureEnabled() {
        const frontendLogs = this.assertFrontendLogsCapability();
        let enabled;
        try {
            enabled = await frontendLogs.getConsoleCaptureEnabled();
        }
        catch {
            throw new ToolkitError('HOST_FRONTEND_LOG_STATUS_INVALID', '读取宿主 console 捕获状态失败。');
        }
        if (typeof enabled !== 'boolean')
            throw new ToolkitError('HOST_FRONTEND_LOG_STATUS_INVALID', '宿主 console 捕获状态必须是 boolean。');
        return enabled;
    }
    assertFrontendLogsCapability() {
        const frontendLogs = this.abi?.api?.dev?.frontendLogs;
        const required = { list: 'list', subscribe: 'subscribe', getConsoleCaptureEnabled: 'getConsoleCaptureEnabled' };
        const missing = Object.entries(required)
            .filter(([, name]) => typeof frontendLogs?.[name] !== 'function')
            .map(([, name]) => name);
        if (missing.length)
            throw new ToolkitError('HOST_FRONTEND_LOGS_MISSING', `TauriTavern 前端日志 ABI 缺少必需方法：${missing.join('、')}。`);
        return frontendLogs;
    }
    validateFrontendLogEntry(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志条目必须是对象。');
        const candidate = value;
        if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0)
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志 id 必须是大于零的安全整数。');
        if (!Number.isSafeInteger(candidate.timestampMs) || candidate.timestampMs < 0)
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志时间戳必须是大于等于零的安全整数。');
        if (!['debug', 'info', 'warn', 'error'].includes(candidate.level))
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志级别非法。');
        if (typeof candidate.message !== 'string')
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志 message 必须是字符串。');
        if (candidate.target !== undefined && typeof candidate.target !== 'string')
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志 target 必须是字符串。');
        return {
            id: candidate.id,
            timestampMs: candidate.timestampMs,
            level: candidate.level,
            message: candidate.message,
            ...(candidate.target !== undefined ? { target: candidate.target } : {}),
        };
    }
    async listFrontendLogs() {
        const frontendLogs = this.assertFrontendLogsCapability();
        let value;
        try {
            value = await frontendLogs.list();
        }
        catch {
            throw new ToolkitError('HOST_FRONTEND_LOG_LIST_INVALID', '读取宿主前端日志尾部失败。');
        }
        if (!Array.isArray(value))
            throw new ToolkitError('HOST_FRONTEND_LOG_LIST_INVALID', '宿主前端日志尾部必须是数组。');
        return value.map(entry => this.validateFrontendLogEntry(entry));
    }
    subscribeFrontendLogs(onEntry, onContractError) {
        if (typeof onEntry !== 'function' || typeof onContractError !== 'function')
            throw new TypeError('宿主前端日志订阅需要 onEntry 与 onContractError 回调');
        const frontendLogs = this.assertFrontendLogsCapability();
        let pendingCancel = false;
        let underlying = null;
        let cancelCalled = false;
        let notified = false;
        let stopped = false;
        const cancel = () => {
            if (cancelCalled)
                return;
            cancelCalled = true;
            if (underlying)
                underlying();
            else
                pendingCancel = true;
        };
        const wrapped = entry => {
            if (cancelCalled || stopped)
                return;
            let validated;
            try {
                validated = this.validateFrontendLogEntry(entry);
            }
            catch (error) {
                if (!notified) {
                    notified = true;
                    stopped = true;
                    onContractError(error);
                }
                return;
            }
            if (pendingCancel)
                return;
            onEntry(validated);
        };
        return frontendLogs.subscribe(wrapped).then(unsubscribe => {
            if (typeof unsubscribe !== 'function')
                throw new ToolkitError('HOST_FRONTEND_LOG_SUBSCRIPTION_INVALID', '宿主前端日志订阅返回的取消函数必须是函数。');
            underlying = unsubscribe;
            if (pendingCancel) {
                pendingCancel = false;
                cancel();
            }
            return cancel;
        });
    }
    listWorldInfoNames() {
        return Array.isArray(this.worldInfoModule.world_names)
            ? [...this.worldInfoModule.world_names]
            : [];
    }
    async loadWorldInfo(name) {
        const data = await this.worldInfoModule.loadWorldInfo(String(name));
        return data ? structuredClone(data) : null;
    }
    async loadWorldInfoFresh(name) {
        const context = this.context;
        if (typeof context.getRequestHeaders !== 'function') {
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 缺少世界书读取请求头接口。');
        }
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ name: String(name) }),
            cache: 'no-cache',
        });
        if (!response.ok)
            throw new ToolkitError('WORLD_INFO_READ_FAILED', `世界书读取失败（HTTP ${response.status}）。`);
        return structuredClone(await response.json());
    }
    async saveWorldInfo(name, data) {
        await this.worldInfoModule.saveWorldInfo(String(name), structuredClone(data), true);
    }
    activeWorldInfoNames() {
        return this.activeWorldInfoBindings().map(binding => binding.name);
    }
    activeWorldInfoBindings() {
        const context = this.context;
        const bindings = [];
        const activeNames = new Set();
        const add = (value, source) => {
            if (typeof value === 'string' && value && !activeNames.has(value)) {
                activeNames.add(value);
                bindings.push({ name: value, source });
            }
        };
        for (const name of this.worldInfoModule.selected_world_info ?? [])
            add(name, 'global');
        add(context.chatMetadata?.world_info, 'chat');
        add(context.powerUserSettings?.persona_description_lorebook, 'persona');
        const character = context.characters?.[context.characterId];
        add(character?.data?.extensions?.world, 'character');
        const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
        const fileName = avatar.replace(/\.[^/.]+$/, '');
        const extra = this.worldInfoModule.world_info?.charLore?.find(item => item?.name === fileName);
        for (const name of extra?.extraBooks ?? [])
            add(name, 'character');
        return bindings;
    }
    generationWillRequestModel() {
        const context = this.context;
        if (context.onlineStatus === 'no_connection')
            return false;
        if (this.groupModule.selected_group && !this.groupModule.is_group_generating)
            return false;
        return true;
    }
    onHostEvent(name, handler) {
        const context = this.context;
        const event = context.eventTypes?.[name];
        if (!event || typeof context.eventSource?.on !== 'function')
            throw new ToolkitError('HOST_EVENT_MISSING', `TauriTavern 缺少 ${name} 事件。`);
        context.eventSource.on(event, handler);
        const remove = typeof context.eventSource.off === 'function'
            ? context.eventSource.off.bind(context.eventSource)
            : context.eventSource.removeListener?.bind(context.eventSource);
        if (!remove)
            throw new ToolkitError('HOST_EVENT_MISSING', 'TauriTavern 缺少事件移除方法。');
        return () => remove(event, handler);
    }
    async emitHostEvent(name, ...args) {
        const context = this.context;
        const event = context.eventTypes?.[name];
        if (!event || typeof context.eventSource?.emit !== 'function')
            throw new ToolkitError('HOST_EVENT_MISSING', `TauriTavern 缺少 ${name} 事件。`);
        await context.eventSource.emit(event, ...args);
    }
    async getOpenAiCompatibleStatus(preset) {
        return this.abi.invoke.safeInvoke('get_chat_completions_status', {
            dto: {
                chat_completion_source: 'custom',
                custom_api_format: 'openai_compat',
                custom_url: '',
                reverse_proxy: String(preset.apiUrl),
                proxy_password: String(preset.apiKey),
            },
        });
    }
    async generateOpenAiCompatible(preset, payload, signal) {
        if (signal?.aborted)
            throw new DOMException('aborted', 'AbortError');
        const requestId = crypto.randomUUID();
        let aborted = false;
        const cancel = () => {
            aborted = true;
            void this.abi.invoke.safeInvoke('cancel_chat_completion_generation', { requestId }).catch(() => undefined);
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            const result = await this.abi.invoke.safeInvoke('generate_chat_completion', {
                requestId,
                dto: {
                    ...structuredClone(payload),
                    chat_completion_source: 'custom',
                    custom_api_format: 'openai_compat',
                    custom_url: '',
                    reverse_proxy: String(preset.apiUrl),
                    proxy_password: String(preset.apiKey),
                },
            });
            if (aborted)
                throw new DOMException('aborted', 'AbortError');
            return result;
        }
        finally {
            signal?.removeEventListener('abort', cancel);
        }
    }
    async chatExtensionGet(namespace) {
        const metadata = await this.abi.api.chat.current.handle().metadata.get();
        const extensions = metadata.extensions;
        return extensions && typeof extensions === 'object' && !Array.isArray(extensions)
            ? extensions[namespace]
            : undefined;
    }
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
    }
    async assertIdentity(expectedStableId, expectedRef) {
        const current = await this.identity();
        if (current.stableId !== expectedStableId || (expectedRef !== undefined
            && !sameConversationIdentity(current, { stableId: expectedStableId, ref: expectedRef })))
            throw new ToolkitError('CHAT_CHANGED', '操作期间当前聊天已切换。');
    }
    async saveCurrentChat() {
        this.log?.info('chat.save_started', { data: { kind: this.groupModule.selected_group ? 'group' : 'character' } });
        if (this.groupModule.selected_group) {
            await this.groupModule.saveGroupChat(this.groupModule.selected_group, true);
        }
        else {
            await this.scriptModule.saveChat();
        }
        this.log?.info('chat.save_completed');
    }
    async reloadCurrentChat() {
        await this.scriptModule.reloadCurrentChat();
        this.log?.info('chat.reloaded');
    }
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
    }
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
    }
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
    }
    macroProcess(content) {
        const text = String(content ?? '');
        if (!text)
            return '';
        const substitute = this.scriptModule?.substituteParams;
        if (typeof substitute !== 'function')
            return text;
        try {
            const result = substitute(text);
            return String(result ?? text);
        }
        catch (error) {
            this.log?.warn('host.macro_process_failed', {
                data: { kind: error instanceof Error ? error.name : typeof error },
            });
            return text;
        }
    }
    async getCurrentChatIdentity() {
        return this.identity();
    }
    async getPromptConflictChatMetadata() {
        return this.chatExtensionGet(PROMPT_CONFLICT_CHAT_NAMESPACE);
    }
    async setPromptConflictChatMetadata(expectedStableId, value) {
        await this.chatExtensionSet(expectedStableId, PROMPT_CONFLICT_CHAT_NAMESPACE, value);
    }
    async openAiPromptManager() {
        if (!this.openAiModule) {
            this.openAiModule = await (this.dynamicImport ?? dynamicImport)(OPENAI_URL);
            if (!this.openAiModule || !('promptManager' in this.openAiModule))
                throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 缺少 openai.js 的 promptManager 导出。');
        }
        const promptManager = this.openAiModule.promptManager;
        if (!promptManager)
            throw new ToolkitError('PROMPT_MANAGER_UNAVAILABLE', 'PromptManager 尚未初始化，无法读取当前预设。');
        return promptManager;
    }
    async getPromptConflictPresetSources() {
        const promptManager = await this.openAiPromptManager();
        if (typeof promptManager.getPromptById !== 'function'
            || typeof promptManager.getPromptOrderForCharacter !== 'function'
            || typeof promptManager.shouldTrigger !== 'function'
            || typeof promptManager.preparePrompt !== 'function') {
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern PromptManager 缺少必需方法，冲突检测无法读取预设。');
        }
        const promptOrder = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) ?? [];
        if (!Array.isArray(promptOrder))
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern PromptManager 返回了非法 prompt order。');
        const sources = [];
        for (const entry of promptOrder) {
            const identifier = entry?.identifier;
            const enabled = entry?.enabled === true;
            const prompt = enabled ? promptManager.getPromptById(identifier) : null;
            if (!prompt || prompt.marker === true)
                continue;
            let prepared;
            try {
                prepared = promptManager.preparePrompt(prompt);
            }
            catch (error) {
                this.log?.warn('prompt_conflict.prepare_failed', {
                    data: { kind: error instanceof Error ? error.name : typeof error },
                });
                continue;
            }
            const content = String(prepared?.content ?? '');
            if (!content.trim())
                continue;
            let trigger = true;
            try {
                trigger = promptManager.shouldTrigger(prompt, 'normal');
            }
            catch {
                trigger = true;
            }
            if (!trigger)
                continue;
            sources.push({
                identifier: String(identifier ?? ''),
                label: String(prompt.name || prompt.identifier || identifier || ''),
                role: String(prompt.role ?? 'system'),
                position: Number(prompt.injection_position ?? prompt.position ?? 0),
                order: Number(prompt.injection_order ?? 0),
                content,
            });
        }
        return sources;
    }
    subscribePromptConflictSourceInvalidation(listener) {
        if (typeof listener !== 'function')
            throw new TypeError('冲突检测来源失效订阅需要函数回调');
        const disposers = PROMPT_CONFLICT_INVALIDATION_EVENTS.map(name => {
            const dispose = this.onHostEvent(name, (...args) => listener({ type: name, args }));
            this.log?.debug('prompt_conflict.invalidation_subscribed', { data: { event: name } });
            return dispose;
        });
        return () => {
            for (const dispose of disposers.splice(0))
                dispose();
            this.log?.debug('prompt_conflict.invalidation_unsubscribed');
        };
    }
    validateWorldInfoEntriesPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new ToolkitError('HOST_EVENT_INVALID', 'WORLDINFO_ENTRIES_LOADED 负载必须是对象。', {
                field: 'payload', expected: 'record', actualType: valueType(payload),
            });
        for (const listName of WORLD_INFO_LORE_LISTS) {
            if (!Array.isArray(payload[listName]))
                throw new ToolkitError('HOST_EVENT_INVALID', `WORLDINFO_ENTRIES_LOADED 缺少或包含非法 ${listName} 数组。`, {
                    field: listName, expected: 'array', actualType: valueType(payload[listName]),
                });
        }
        return payload;
    }
    subscribeWorldInfoEntriesLoaded(listener, onContractError) {
        if (typeof listener !== 'function' || typeof onContractError !== 'function')
            throw new TypeError('世界书条目加载订阅需要 listener 与 onContractError 回调');
        return this.onHostEvent('WORLDINFO_ENTRIES_LOADED', payload => {
            let validated;
            try {
                validated = this.validateWorldInfoEntriesPayload(payload);
            }
            catch (error) {
                return onContractError(error);
            }
            // The host awaits this result before scanning the same mutable arrays.
            return listener(validated);
        });
    }
    async getMountedWorldInfoEntries() {
        const cache = this.worldInfoModule?.worldInfoCache;
        if (!cache || typeof cache.get !== 'function')
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 缺少世界书缓存访问接口。');
        const groups = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
        const bySource = { global: 'globalLore', character: 'characterLore', chat: 'chatLore', persona: 'personaLore' };
        for (const binding of this.activeWorldInfoBindings()) {
            const listName = bySource[binding.source];
            if (!listName)
                continue;
            const data = cache.get(binding.name);
            if (!data || !data.entries || typeof data.entries !== 'object')
                continue;
            for (const entry of Object.values(data.entries)) {
                if (!entry || typeof entry !== 'object')
                    continue;
                groups[listName].push({ ...entry, world: binding.name });
            }
        }
        return groups;
    }
    async expandPromptConflictSourceMacros(content) {
        return this.macroProcess(content);
    }
    async promptConflictWorldDigest(worldName) {
        return sha256Hex(worldName);
    }
    async promptViewerStatus() {
        const context = this.context;
        const settings = context.chatCompletionSettings ?? null;
        let model = null;
        if (typeof context.getChatCompletionModel === 'function') {
            try {
                const resolved = context.getChatCompletionModel();
                model = resolved ? String(resolved) : null;
            }
            catch {
                model = null;
            }
        }
        const maxContext = Number(settings?.openai_max_context);
        const maxTokens = Number(settings?.openai_max_tokens);
        let promptManagerReady = false;
        let reason;
        try {
            const promptManager = await this.openAiPromptManager();
            promptManagerReady = typeof promptManager?.getPromptById === 'function'
                && typeof promptManager?.tryGenerate === 'function'
                && promptManager?.messages !== undefined;
            if (!promptManagerReady)
                reason = 'HOST_EXPORT_MISSING';
        }
        catch (error) {
            reason = error instanceof ToolkitError ? error.code : 'PROMPT_MANAGER_UNAVAILABLE';
        }
        return {
            mainApi: String(context.mainApi ?? ''),
            model,
            source: settings?.chat_completion_source ? String(settings.chat_completion_source) : null,
            tokenBudget: Number.isFinite(maxContext) && Number.isFinite(maxTokens)
                ? { maxContext, maxTokens }
                : null,
            isGroup: Boolean(context.groupId),
            characterName: context.name2 ? String(context.name2) : null,
            promptManagerReady,
            reason,
        };
    }
    projectPromptViewerMessage(message, promptName) {
        const identifier = String(message?.identifier ?? '');
        let content = message?.content ?? '';
        if (content && typeof content !== 'string') {
            try {
                content = structuredClone(content);
            }
            catch {
                content = String(content);
            }
        }
        let toolCalls = null;
        if (Array.isArray(message?.tool_calls)) {
            try {
                toolCalls = structuredClone(message.tool_calls);
            }
            catch {
                toolCalls = null;
            }
        }
        const role = String(message?.role ?? 'system');
        return {
            identifier,
            role,
            content,
            name: message?.name ? String(message.name) : null,
            tokens: Number.isFinite(message?.tokens) ? Number(message.tokens) : null,
            promptName: promptName(identifier),
            toolCalls,
            toolCallId: role === 'tool' ? identifier : null,
            signature: message?.signature ? String(message.signature) : null,
            reasoning: message?.reasoning ? String(message.reasoning) : null,
            native: message?.native ?? null,
            reasoningContent: message?.reasoningContent ? String(message.reasoningContent) : null,
        };
    }
    async readPromptViewerSnapshot() {
        const promptManager = await this.openAiPromptManager();
        const collection = promptManager?.messages;
        if (!collection || typeof collection.flatten !== 'function') {
            throw new ToolkitError('PROMPT_MANAGER_UNAVAILABLE', 'PromptManager 尚未产生组装结果，无法读取提示词。');
        }
        const nameCache = new Map();
        const promptName = identifier => {
            if (nameCache.has(identifier))
                return nameCache.get(identifier);
            let name = null;
            try {
                const prompt = typeof promptManager.getPromptById === 'function'
                    ? promptManager.getPromptById(identifier)
                    : null;
                name = prompt?.name ? String(prompt.name) : null;
            }
            catch {
                name = null;
            }
            nameCache.set(identifier, name);
            return name;
        };
        const projected = collection.flatten().map(message => this.projectPromptViewerMessage(message, promptName));
        const messages = projected.filter(message => !PROMPT_VIEWER_AGENT_ONLY_IDENTIFIERS.has(message.identifier));
        return {
            messages,
            removedAgentItemCount: projected.length - messages.length,
            squashSystemMessages: Boolean(promptManager.serviceSettings?.squash_system_messages),
        };
    }
    async runPromptViewerDryRun(text) {
        const promptManager = await this.openAiPromptManager();
        if (typeof promptManager?.tryGenerate !== 'function') {
            throw new ToolkitError('PROMPT_VIEWER_PREDICTION_UNAVAILABLE', '宿主 PromptManager 缺少 dry-run 预测入口。');
        }
        const textarea = document.getElementById(PROMPT_VIEWER_TEXTAREA_ID);
        if (!textarea || typeof textarea.value !== 'string') {
            throw new ToolkitError('PROMPT_VIEWER_INPUT_UNAVAILABLE', '找不到宿主输入框，无法进行预测。');
        }
        const savedValue = textarea.value;
        const savedStart = textarea.selectionStart;
        const savedEnd = textarea.selectionEnd;
        const savedScrollTop = textarea.scrollTop;
        const counts = promptManager.tokenHandler?.counts;
        const savedCounts = counts ? { ...counts } : null;
        textarea.value = String(text ?? '');
        try {
            await promptManager.tryGenerate();
        }
        finally {
            textarea.value = savedValue;
            try {
                textarea.setSelectionRange(savedStart, savedEnd);
            }
            catch {
                // Some inputs reject selection APIs; value restoration is the important part.
            }
            textarea.scrollTop = savedScrollTop;
            if (counts && savedCounts) {
                for (const key of Object.keys(counts))
                    delete counts[key];
                Object.assign(counts, savedCounts);
            }
        }
    }
    subscribePromptViewerEvents(handlers) {
        const onContractError = typeof handlers?.onContractError === 'function' ? handlers.onContractError : () => undefined;
        const contractError = message => new ToolkitError('PROMPT_VIEWER_EVENT_INVALID', message);
        const disposers = [];
        const add = (name, handler) => {
            disposers.push(this.onHostEvent(name, handler));
        };
        add('GENERATION_AFTER_COMMANDS', (type, _options, dryRun) => {
            handlers.onGenerationStart?.({ type: String(type ?? ''), dryRun: dryRun === true });
        });
        add('CHAT_COMPLETION_PROMPT_READY', payload => {
            if (!payload || typeof payload !== 'object' || !Array.isArray(payload.chat) || typeof payload.dryRun !== 'boolean') {
                onContractError(contractError('CHAT_COMPLETION_PROMPT_READY 负载非法。'));
                return;
            }
            return handlers.onPromptReady?.({ chat: payload.chat, dryRun: payload.dryRun });
        });
        add('WORLD_INFO_ACTIVATED', entries => {
            if (!Array.isArray(entries)) {
                onContractError(contractError('WORLD_INFO_ACTIVATED 负载必须是数组。'));
                return;
            }
            handlers.onWorldInfoActivated?.(entries);
        });
        add('WORLDINFO_SCAN_DONE', args => {
            const entries = args?.activated?.entries;
            if (!args || typeof args !== 'object' || typeof args.isFinal !== 'boolean' || !entries || typeof entries.values !== 'function') {
                onContractError(contractError('WORLDINFO_SCAN_DONE 负载非法。'));
                return;
            }
            handlers.onWorldInfoScan?.({
                isFinal: args.isFinal,
                isDryRun: args.isDryRun === true,
                entries: Array.from(entries.values()),
            });
        });
        add('GENERATION_STOPPED', () => handlers.onGenerationStopped?.());
        add('GENERATION_ENDED', () => handlers.onGenerationEnded?.());
        add('CHAT_CHANGED', () => handlers.onChatChanged?.());
        return () => {
            for (const dispose of disposers.splice(0))
                dispose();
        };
    }
}
