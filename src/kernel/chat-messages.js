import { ToolkitError } from './errors.js';

const SYSTEM_MESSAGE_TYPES = new Set([
    'help', 'welcome', 'empty', 'generic', 'narrator', 'comment', 'slash_commands',
    'formatting', 'hotkeys', 'macros', 'welcome_prompt', 'assistant_note', 'assistant_message',
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function classifyMessage(raw, messageIndex) {
    if (!isRecord(raw))
        throw new ToolkitError('INVALID_MESSAGE', '聊天楼层必须是对象', { messageIndex });
    const extra = isRecord(raw.extra) ? raw.extra : {};
    if (raw.role === 'tool' || Array.isArray(extra.tool_invocations))
        return 'tool';
    if (SYSTEM_MESSAGE_TYPES.has(extra.type) || extra.uses_system_ui === true)
        return 'system';
    return raw.is_user === true ? 'user' : 'assistant';
}

export function isHiddenConversationMessage(raw) {
    const extra = isRecord(raw?.extra) ? raw.extra : {};
    return raw?.is_system === true || extra.isSmallSys === true;
}
