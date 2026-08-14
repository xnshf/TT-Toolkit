import { classifyMessage, isHiddenConversationMessage } from '../../kernel/chat-messages.js';
import { ToolkitError } from '../../kernel/errors.js';

export const CHAT_VIEW_PAGE_SIZE = 20;
export const RANGE_PREVIEW_LENGTH = 300;
export const SEARCH_CONTEXT_LENGTH = 120;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function swipeSummary(raw, absoluteIndex) {
    if (!Array.isArray(raw.swipes) || raw.swipes.length === 0)
        return { swipeNumber: null, swipeCount: 0 };
    const swipeIndex = Number(raw.swipe_id);
    if (!Number.isSafeInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= raw.swipes.length) {
        throw new ToolkitError('INVALID_MESSAGE', `楼层 ${absoluteIndex} 的 swipe_id 无法定位当前候选`, { absoluteIndex, swipeId: raw.swipe_id });
    }
    return { swipeNumber: swipeIndex + 1, swipeCount: raw.swipes.length };
}

function comparableTarget(raw, role) {
    const extra = isRecord(raw.extra) ? raw.extra : {};
    return {
        role,
        text: raw.mes,
        name: raw.name,
        sendDate: raw.send_date,
        isUser: raw.is_user === true,
        isSystem: raw.is_system === true,
        originalAvatar: raw.original_avatar,
        swipeId: raw.swipe_id,
        swipeCount: Array.isArray(raw.swipes) ? raw.swipes.length : 0,
        extraType: extra.type,
        usesSystemUi: extra.uses_system_ui,
        isSmallSys: extra.isSmallSys,
    };
}

function sameComparable(left, right) {
    return Object.keys(left).every(key => Object.is(left[key], right[key]));
}

export function buildChatViewModel(snapshot) {
    if (!isRecord(snapshot?.identity) || typeof snapshot.identity.stableId !== 'string' || !Array.isArray(snapshot?.messages))
        throw new ToolkitError('INVALID_SNAPSHOT', '聊天快照结构无效。');
    const items = [];
    const stats = {
        totalMessages: snapshot.messages.length,
        conversationMessages: 0,
        excludedSystemMessages: 0,
        excludedToolMessages: 0,
        hiddenConversationMessages: 0,
    };
    snapshot.messages.forEach((raw, absoluteIndex) => {
        const role = classifyMessage(raw, absoluteIndex);
        if (role === 'system') {
            stats.excludedSystemMessages += 1;
            return;
        }
        if (role === 'tool') {
            stats.excludedToolMessages += 1;
            return;
        }
        if (typeof raw.mes !== 'string')
            throw new ToolkitError('INVALID_MESSAGE', `楼层 ${absoluteIndex} 的消息正文必须是字符串`, { absoluteIndex });
        const hidden = isHiddenConversationMessage(raw);
        const swipe = swipeSummary(raw, absoluteIndex);
        const conversationIndex = items.length + 1;
        items.push({
            conversationIndex,
            absoluteIndex,
            role,
            hidden,
            compact: isRecord(raw.extra) && raw.extra.isSmallSys === true,
            name: typeof raw.name === 'string' ? raw.name : '',
            sendDate: typeof raw.send_date === 'string' || typeof raw.send_date === 'number' ? raw.send_date : null,
            text: raw.mes,
            ...swipe,
            target: comparableTarget(raw, role),
        });
        stats.conversationMessages += 1;
        if (hidden)
            stats.hiddenConversationMessages += 1;
    });
    return {
        identity: structuredClone(snapshot.identity),
        items,
        stats,
    };
}

export function defaultChatRange(model) {
    const end = model.items.length;
    return end === 0 ? { start: 0, end: 0 } : { start: Math.max(1, end - 19), end };
}

export function selectChatRange(model, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > model.items.length) {
        throw new ToolkitError('INVALID_RANGE', `楼层范围必须满足 1 ≤ 起始楼层 ≤ 截止楼层 ≤ ${model.items.length}`, { start, end });
    }
    return model.items.slice(start - 1, end);
}

export function searchChatMessages(model, query) {
    if (typeof query !== 'string' || query.trim().length === 0)
        throw new ToolkitError('EMPTY_QUERY', '请输入要搜索的正文。');
    const needle = query.toLocaleLowerCase();
    return model.items.filter(item => item.text.toLocaleLowerCase().includes(needle));
}

export function paginateChatItems(items, page, pageSize = CHAT_VIEW_PAGE_SIZE) {
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pageCount - 1);
    return {
        page: safePage,
        pageCount,
        items: items.slice(safePage * pageSize, (safePage + 1) * pageSize),
    };
}

export function prefixSnippet(text, limit = RANGE_PREVIEW_LENGTH) {
    const characters = Array.from(text);
    return characters.length <= limit
        ? { text, truncated: false }
        : { text: characters.slice(0, limit).join(''), truncated: true };
}

export function searchSnippet(text, query, contextLength = SEARCH_CONTEXT_LENGTH) {
    const haystack = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const matchOffset = haystack.indexOf(needle);
    if (matchOffset < 0)
        return prefixSnippet(text, contextLength * 2);
    const beforeLength = Array.from(text.slice(0, matchOffset)).length;
    const matchLength = Array.from(text.slice(matchOffset, matchOffset + query.length)).length;
    const characters = Array.from(text);
    const start = Math.max(0, beforeLength - contextLength);
    const end = Math.min(characters.length, beforeLength + matchLength + contextLength);
    return {
        text: characters.slice(start, end).join(''),
        truncated: start > 0 || end < characters.length,
        leading: start > 0,
        trailing: end < characters.length,
    };
}

export function matchesMessageTarget(raw, item) {
    try {
        return classifyMessage(raw, item.absoluteIndex) === item.role
            && sameComparable(comparableTarget(raw, item.role), item.target);
    }
    catch {
        return false;
    }
}
