import { matchesProjectedMessageTarget, projectConversationSnapshot } from '../../kernel/chat-projection.js';
import { ToolkitError } from '../../kernel/errors.js';
import { valueType } from '../../kernel/chat-diagnostics.js';

export const CHAT_VIEW_PAGE_SIZE = 20;
export const RANGE_PREVIEW_LENGTH = 300;
export const SEARCH_CONTEXT_LENGTH = 120;

export function buildChatViewModel(snapshot) {
    return projectConversationSnapshot(snapshot);
}

export function defaultChatRange(model) {
    const end = model.items.length;
    return end === 0 ? { start: 0, end: 0 } : { start: Math.max(1, end - 19), end };
}

export function selectChatRange(model, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > model.items.length) {
        throw new ToolkitError('INVALID_RANGE', `楼层范围必须满足 1 ≤ 起始楼层 ≤ 截止楼层 ≤ ${model.items.length}`, { start, end, totalMessages: model.items.length, field: 'range', sourceLocation: 'chat-viewer/model.js' });
    }
    return model.items.slice(start - 1, end);
}

export function searchChatMessages(model, query) {
    if (typeof query !== 'string' || query.trim().length === 0)
        throw new ToolkitError('EMPTY_QUERY', '请输入要搜索的正文。', { field: 'query', expected: 'string', actualType: valueType(query), sourceLocation: 'chat-viewer/model.js' });
    const needle = query.toLocaleLowerCase();
    return model.items.filter(item => item.readable && item.text.toLocaleLowerCase().includes(needle));
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
    return matchesProjectedMessageTarget(raw, item);
}
