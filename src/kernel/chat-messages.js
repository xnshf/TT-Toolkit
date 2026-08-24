import { ToolkitError } from './errors.js';

const SYSTEM_MESSAGE_TYPES = new Set([
    'help', 'welcome', 'empty', 'generic', 'narrator', 'comment', 'slash_commands',
    'formatting', 'hotkeys', 'macros', 'welcome_prompt', 'assistant_note', 'assistant_message',
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasAssistantProvenance(raw) {
    if (typeof raw?.original_avatar === 'string' && raw.original_avatar.trim())
        return true;
    if (!Array.isArray(raw?.swipes) || raw.swipes.length === 0)
        return false;
    const swipeId = Number(raw.swipe_id);
    return Number.isSafeInteger(swipeId)
        && swipeId >= 0
        && swipeId < raw.swipes.length
        && raw.swipes.every(text => typeof text === 'string')
        && typeof raw.mes === 'string'
        && raw.mes === raw.swipes[swipeId];
}

export function classifyMessage(raw, messageIndex, context = {}) {
    if (!isRecord(raw))
        throw new ToolkitError('INVALID_MESSAGE', '聊天楼层必须是对象', { messageIndex });
    const extra = isRecord(raw.extra) ? raw.extra : {};
    if (Array.isArray(extra.tool_invocations))
        return 'tool';
    if (SYSTEM_MESSAGE_TYPES.has(extra.type) || extra.uses_system_ui === true)
        return 'system';
    if (raw.is_user === true)
        return 'user';
    if (raw.is_system !== true)
        return 'assistant';
    if (hasAssistantProvenance(raw))
        return 'assistant';
    // Older/imported character chats can retain the opening greeting as is_system.
    // Explicit system/tool markers above always win, and this exception is limited
    // to the canonical first floor of a character chat.
    if (messageIndex === 0 && context.chatKind === 'character')
        return 'assistant';
    throw new ToolkitError('AMBIGUOUS_MESSAGE_ROLE', `楼层 ${messageIndex} 标记为 is_system，但无法可靠区分系统消息与隐藏的 AI 消息`, { messageIndex });
}

export function isHiddenConversationMessage(raw) {
    const extra = isRecord(raw?.extra) ? raw.extra : {};
    return raw?.is_system === true || extra.isSmallSys === true;
}
