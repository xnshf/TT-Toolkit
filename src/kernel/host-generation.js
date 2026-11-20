import { ToolkitError } from './errors.js';
import { valueType } from './chat-diagnostics.js';
import { REGEX_URL, dynamicImport } from './host-abi.js';

// generationMethods: 由 host.js 按宿主能力拆分，方法体与拆分前一致。
export const generationMethods = {
    isGenerationInProgress() {
        if (typeof this.scriptModule?.isGenerating !== 'function')
            throw new ToolkitError('HOST_GENERATION_STATUS_MISSING', '宿主生成状态接口不可用，请检查宿主版本后重试。');
        const result = this.scriptModule.isGenerating();
        if (typeof result !== 'boolean')
            throw new ToolkitError('HOST_GENERATION_STATUS_INVALID', '宿主生成状态无效，已停止当前操作。');
        return result;
    },
    generationIdlePromise() {
        if (typeof this.scriptModule?.waitForGenerationIdle !== 'function')
            throw new ToolkitError('HOST_GENERATION_IDLE_UNAVAILABLE', '宿主未提供生成收尾状态，请检查宿主版本后重试。');
        const idle = this.scriptModule.waitForGenerationIdle();
        if (typeof idle?.then !== 'function')
            throw new ToolkitError('HOST_GENERATION_IDLE_UNAVAILABLE', '宿主生成收尾状态无效，请检查宿主版本后重试。');
        return idle;
    },
    generationWillRequestModel() {
        const context = this.context;
        if (context.onlineStatus === 'no_connection')
            return false;
        if (this.groupModule.selected_group && !this.groupModule.is_group_generating)
            return false;
        return true;
    },
    onHostEvent(name, handler, { first = false } = {}) {
        const context = this.context;
        const event = context.eventTypes?.[name];
        const source = context.eventSource;
        const register = first ? source?.makeFirst : source?.on;
        if (!event || typeof register !== 'function')
            throw new ToolkitError('HOST_EVENT_MISSING', `TauriTavern 缺少 ${name} ${first ? '的首位监听接口' : '事件'}。`);
        const remove = typeof source.off === 'function' ? source.off : source.removeListener;
        if (typeof remove !== 'function')
            throw new ToolkitError('HOST_EVENT_MISSING', 'TauriTavern 缺少事件移除方法。');
        const dispose = () => remove.call(source, event, handler);
        try {
            register.call(source, event, handler);
        }
        catch (error) {
            // The host can call a replay listener after adding it, before registration returns.
            try {
                dispose();
            }
            catch {
                // Preserve the registration failure.
            }
            throw error;
        }
        return dispose;
    },
    async emitHostEvent(name, ...args) {
        const context = this.context;
        const event = context.eventTypes?.[name];
        if (!event || typeof context.eventSource?.emit !== 'function')
            throw new ToolkitError('HOST_EVENT_MISSING', `TauriTavern 缺少 ${name} 事件。`);
        await context.eventSource.emit(event, ...args);
    },
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
    },
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
    },
    async formatDecisionText(text, source, depth) {
        const placements = { user_input: 'USER_INPUT', ai_output: 'AI_OUTPUT', world_info: 'WORLD_INFO' };
        if (typeof text !== 'string' || typeof source !== 'string' || !Object.hasOwn(placements, source)
            || (depth !== undefined && (!Number.isSafeInteger(depth) || depth < -1))) {
            throw new ToolkitError('DECISION_TEXT_INVALID', '决策上下文正文、来源或深度无效。');
        }
        try {
            this.regexModule ??= await (this.dynamicImport ?? dynamicImport)(REGEX_URL);
        }
        catch {
            throw new ToolkitError('HOST_DECISION_REGEX_MISSING', '宿主提示词正则模块不可用，本轮应使用原生激活。');
        }
        const engine = this.regexModule;
        const placement = engine?.regex_placement?.[placements[source]];
        if (typeof engine?.getRegexedString !== 'function' || !Number.isSafeInteger(placement))
            throw new ToolkitError('HOST_DECISION_REGEX_MISSING', '宿主缺少提示词正则必需导出，本轮应使用原生激活。');
        let result;
        try {
            result = engine.getRegexedString(text, placement, { isPrompt: true, ...(depth !== undefined ? { depth } : {}) });
        }
        catch {
            throw new ToolkitError('DECISION_TEXT_FORMAT_FAILED', '宿主提示词正则处理失败，本轮应使用原生激活。', { source });
        }
        if (typeof result !== 'string')
            throw new ToolkitError('DECISION_TEXT_FORMAT_INVALID', '宿主提示词正则结果不是字符串，本轮应使用原生激活。', {
                source, expected: 'string', actualType: valueType(result),
            });
        return result;
    },
    expandDecisionCondition(text) {
        if (typeof text !== 'string')
            throw new ToolkitError('DECISION_CONDITION_INVALID', '决策条件必须是字符串。');
        if (typeof this.scriptModule?.substituteParams !== 'function')
            throw new ToolkitError('HOST_DECISION_MACRO_MISSING', '宿主缺少条件宏展开接口，本轮应使用原生激活。');
        let result;
        try {
            result = this.scriptModule.substituteParams(text);
        }
        catch {
            throw new ToolkitError('DECISION_CONDITION_EXPANSION_FAILED', '决策条件宏展开失败，本轮应使用原生激活。');
        }
        if (typeof result !== 'string')
            throw new ToolkitError('DECISION_CONDITION_EXPANSION_INVALID', '决策条件宏展开结果不是字符串，本轮应使用原生激活。', {
                expected: 'string', actualType: valueType(result),
            });
        return result;
    },
    decisionCharacterKey() {
        const context = this.context;
        const id = context.characterId;
        if (!((Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && id.trim())))
            throw new ToolkitError('DECISION_CHARACTER_INVALID', '当前生成角色身份不可用，本轮应使用原生激活。');
        const avatar = context.characters?.[id]?.avatar;
        if (typeof avatar !== 'string' || !avatar.trim())
            throw new ToolkitError('DECISION_CHARACTER_INVALID', '当前生成角色身份不可用，本轮应使用原生激活。');
        return JSON.stringify([id, avatar]);
    },
    decisionEligibility(entry, type) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            throw new ToolkitError('DECISION_ENTRY_INVALID', '决策条目必须是对象。');
        // Match the native scan's loose disable check, before any activation basis.
        if (entry.disable == true)
            return false;
        if (Array.isArray(entry.triggers) && entry.triggers.length && !entry.triggers.includes(type))
            return false;
        const filter = entry.characterFilter;
        if (!filter?.names?.length && !filter?.tags?.length)
            return true;
        const context = this.context;
        const avatar = context.characters?.[context.characterId]?.avatar;
        if (avatar !== undefined && typeof avatar !== 'string')
            throw new ToolkitError('DECISION_CHARACTER_INVALID', '当前角色头像标识无效，本轮应使用原生激活。');
        const filename = avatar?.replace(/\.[^/.]+$/, '') ?? null;
        if (filter.names?.length) {
            const included = filter.names.includes(filename);
            if (filter.isExclude ? included : !included)
                return false;
        }
        if (filter.tags?.length && avatar) {
            if (!context.tagMap || typeof context.tagMap !== 'object' || Array.isArray(context.tagMap))
                throw new ToolkitError('DECISION_TAG_MAP_INVALID', '宿主角色标签映射不可用，本轮应使用原生激活。');
            // getTagKeyForEntity initializes a missing character map to []; do not mutate it here.
            const tags = avatar in context.tagMap ? context.tagMap[avatar] : [];
            if (Array.isArray(tags)) {
                const included = tags.some(tag => filter.tags.includes(tag));
                if (filter.isExclude ? included : !included)
                    return false;
            }
        }
        return true;
    },
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
};
