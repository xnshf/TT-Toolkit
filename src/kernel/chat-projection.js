import { classifyMessage, isHiddenConversationMessage } from './chat-messages.js';
import { valueType } from './chat-diagnostics.js';
import { ToolkitError } from './errors.js';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(code, field, expected, actual, absoluteIndex, conversationIndex, message, outcome, nextAction) {
    return {
        code, field, expected, actualType: valueType(actual), absoluteIndex, conversationIndex, message, outcome, nextAction,
        sourceLocation: 'kernel/chat-projection.js:projectConversationSnapshot',
    };
}

function swipeSummary(raw, absoluteIndex, conversationIndex, issues) {
    if (raw.swipes === undefined || (Array.isArray(raw.swipes) && raw.swipes.length === 0))
        return { swipeNumber: null, swipeCount: 0 };
    const count = Array.isArray(raw.swipes) ? raw.swipes.length : 0;
    // Number conversion must not accept null/boolean or throw for arbitrary host values.
    const swipeIndex = typeof raw.swipe_id === 'number' || (typeof raw.swipe_id === 'string' && raw.swipe_id.trim())
        ? Number(raw.swipe_id) : NaN;
    if (!Array.isArray(raw.swipes) || !Number.isSafeInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= count) {
        const diagnostic = issue('MESSAGE_SWIPE_INVALID', Array.isArray(raw.swipes) ? 'swipe_id' : 'swipes',
            Array.isArray(raw.swipes) ? 'index-within-swipes' : 'array', Array.isArray(raw.swipes) ? raw.swipe_id : raw.swipes,
            absoluteIndex, conversationIndex, `对话楼层 ${conversationIndex}（原始索引 ${absoluteIndex}）：候选信息异常，仍读取当前 mes 正文。`,
            'current-body-preserved', 'inspect-swipe-data');
        diagnostic.swipeCount = count;
        if (Number.isSafeInteger(swipeIndex))
            diagnostic.swipeIndex = swipeIndex;
        issues.push(diagnostic);
        return { swipeNumber: null, swipeCount: count };
    }
    return { swipeNumber: swipeIndex + 1, swipeCount: count };
}

function comparableTarget(raw, role) {
    if (!isRecord(raw))
        return { role: 'unknown', recordType: valueType(raw) };
    const extra = isRecord(raw.extra) ? raw.extra : {};
    return {
        role,
        text: typeof raw.mes === 'string' ? raw.mes : null,
        textType: valueType(raw.mes),
        name: typeof raw.name === 'string' ? raw.name : '',
        sendDate: typeof raw.send_date === 'string' || typeof raw.send_date === 'number' ? raw.send_date : null,
        isUser: raw.is_user === true,
        isSystem: raw.is_system === true,
        originalAvatar: typeof raw.original_avatar === 'string' ? raw.original_avatar : null,
        swipeId: typeof raw.swipe_id === 'string' || typeof raw.swipe_id === 'number' ? raw.swipe_id : null,
        swipeIdType: valueType(raw.swipe_id),
        swipeCount: Array.isArray(raw.swipes) ? raw.swipes.length : 0,
        extraType: typeof extra.type === 'string' ? extra.type : null,
        usesSystemUi: extra.uses_system_ui === true,
        isSmallSys: extra.isSmallSys === true,
    };
}

function sameComparable(left, right) {
    return Object.keys(left).every(key => Object.is(left[key], right[key]));
}

export function projectConversationSnapshot(snapshot) {
    const sourceLocation = 'kernel/chat-projection.js:projectConversationSnapshot';
    if (!isRecord(snapshot?.identity) || typeof snapshot.identity.stableId !== 'string' || !snapshot.identity.stableId) {
        const field = isRecord(snapshot?.identity) ? 'identity.stableId' : 'identity';
        const value = field === 'identity' ? snapshot?.identity : snapshot.identity.stableId;
        throw new ToolkitError('INVALID_SNAPSHOT', '聊天快照缺少有效身份，请重新读取当前聊天。', {
            field, expected: field === 'identity' ? 'record' : 'nonempty-string', actualType: valueType(value), sourceLocation,
        });
    }
    if (!Array.isArray(snapshot?.messages))
        throw new ToolkitError('INVALID_SNAPSHOT', '聊天快照缺少消息数组，请重新读取当前聊天。', {
            field: 'messages', expected: 'array', actualType: valueType(snapshot?.messages), sourceLocation,
        });
    const items = [];
    const issues = [];
    const stats = {
        totalMessages: snapshot.messages.length,
        conversationMessages: 0,
        excludedSystemMessages: 0,
        excludedToolMessages: 0,
        hiddenConversationMessages: 0,
        unreadableMessages: 0,
        invalidSwipeMessages: 0,
    };
    for (let absoluteIndex = 0; absoluteIndex < snapshot.messages.length; absoluteIndex += 1) {
        const raw = snapshot.messages[absoluteIndex];
        const record = isRecord(raw);
        const role = record ? classifyMessage(raw, absoluteIndex) : 'unknown';
        if (role === 'system') {
            stats.excludedSystemMessages += 1;
            continue;
        }
        if (role === 'tool') {
            stats.excludedToolMessages += 1;
            continue;
        }
        const conversationIndex = items.length + 1;
        const itemIssues = [];
        const readable = record && typeof raw.mes === 'string';
        if (!readable) {
            itemIssues.push(issue(record ? 'MESSAGE_BODY_NOT_STRING' : 'MESSAGE_NOT_OBJECT', record ? 'mes' : 'message',
                record ? 'string' : 'record', record ? raw.mes : raw, absoluteIndex, conversationIndex,
                `对话楼层 ${conversationIndex}（原始索引 ${absoluteIndex}）：${record ? 'mes 正文不是字符串' : '楼层不是消息对象'}，保留异常标记；搜索不包含此层，导出需确认跳过。`,
                'unreadable-placeholder', 'inspect-message-or-confirm-export-skip'));
            stats.unreadableMessages += 1;
        }
        const hidden = record && isHiddenConversationMessage(raw);
        const swipe = record ? swipeSummary(raw, absoluteIndex, conversationIndex, itemIssues) : { swipeNumber: null, swipeCount: 0 };
        if (itemIssues.some(item => item.code === 'MESSAGE_SWIPE_INVALID'))
            stats.invalidSwipeMessages += 1;
        items.push({
            conversationIndex, absoluteIndex, chatKind: snapshot.identity.ref?.kind, role, hidden, readable,
            compact: record && isRecord(raw.extra) && raw.extra.isSmallSys === true,
            name: record && typeof raw.name === 'string' ? raw.name : '',
            sendDate: record && (typeof raw.send_date === 'string' || typeof raw.send_date === 'number') ? raw.send_date : null,
            text: readable ? raw.mes : '',
            ...swipe,
            issues: itemIssues,
            target: comparableTarget(raw, role),
        });
        issues.push(...itemIssues);
        stats.conversationMessages += 1;
        if (hidden)
            stats.hiddenConversationMessages += 1;
    }
    return { identity: structuredClone(snapshot.identity), items, stats, issues };
}

export function sameConversationIdentity(left, right) {
    if (left.stableId !== right.stableId || left.ref?.kind !== right.ref?.kind)
        return false;
    if (left.ref?.kind === 'character')
        return left.ref.characterId === right.ref.characterId && left.ref.fileName === right.ref.fileName;
    if (left.ref?.kind === 'group')
        return left.ref.chatId === right.ref.chatId;
    return false;
}

export function matchesProjectedMessageTarget(raw, item) {
    try {
        const role = isRecord(raw) ? classifyMessage(raw, item.absoluteIndex) : 'unknown';
        return role === item.role && sameComparable(comparableTarget(raw, role), item.target);
    }
    catch {
        return false;
    }
}
