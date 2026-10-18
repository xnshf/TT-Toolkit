import { ToolkitError } from './errors.js';
import { OPENAI_URL, PROMPT_CONFLICT_CHAT_NAMESPACE, PROMPT_CONFLICT_INVALIDATION_EVENTS, PROMPT_VIEWER_AGENT_ONLY_IDENTIFIERS, PROMPT_VIEWER_TEXTAREA_ID, dynamicImport } from './host-abi.js';

// promptMethods: 由 host.js 按宿主能力拆分，方法体与拆分前一致。
export const promptMethods = {
    async getPromptConflictChatMetadata() {
        return this.chatExtensionGet(PROMPT_CONFLICT_CHAT_NAMESPACE);
    },
    async setPromptConflictChatMetadata(expectedStableId, value) {
        await this.chatExtensionSet(expectedStableId, PROMPT_CONFLICT_CHAT_NAMESPACE, value);
    },
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
    },
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
    },
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
    },
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
    },
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
    },
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
    },
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
    },
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
};
