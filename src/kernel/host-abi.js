import { ToolkitError } from './errors.js';
export const SCRIPT_URL = '/script.js';
export const CONTEXT_URL = '/scripts/st-context.js';
export const GROUP_URL = '/scripts/group-chats.js';
export const WORLD_INFO_URL = '/scripts/world-info.js';
export const OPENAI_URL = '/scripts/openai.js';
export const EXTENSIONS_URL = '/scripts/extensions.js';
export const FILE_EXPORT_URL = '/scripts/utils.js';
export const REGEX_URL = '/scripts/extensions/regex/engine.js';
export const PROMPT_CONFLICT_CHAT_NAMESPACE = 'tt-toolkit.prompt-conflict';
export const PROMPT_CONFLICT_INVALIDATION_EVENTS = [
    'SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER',
    'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'CHAT_CHANGED',
];
export const PROMPT_VIEWER_AGENT_ONLY_IDENTIFIERS = new Set(['agentSystemPrompt', 'agentResults', 'agentTask']);
export const PROMPT_VIEWER_TEXTAREA_ID = 'send_textarea';
export function dynamicImport(url) {
    return import(url);
}
export function requireAbi() {
    const abi = window.__TAURITAVERN__;
    if (!abi?.api?.chat || !abi.api.extension?.store || !abi.api.layout
        || typeof abi.invoke?.safeInvoke !== 'function') {
        throw new ToolkitError('HOST_ABI_MISSING', 'TauriTavern 必需 ABI 不可用，TT-Toolkit 已停止初始化。');
    }
    return abi;
}
export function identityLabel(ref) {
    if (ref && typeof ref === 'object' && 'kind' in ref) {
        const candidate = ref;
        if (candidate.kind === 'group')
            return `群聊 ${String(candidate.chatId ?? '')}`;
        if (candidate.kind === 'character')
            return `角色聊天 ${String(candidate.characterId ?? '')} / ${String(candidate.fileName ?? '')}`;
    }
    return '当前聊天';
}
