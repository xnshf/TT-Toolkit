import { classifyMessage, isHiddenConversationMessage } from './chat-messages.js';
import { ToolkitError } from './errors.js';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function swipeSummary(raw, absoluteIndex) {
    if (!Array.isArray(raw.swipes) || raw.swipes.length === 0)
        return { swipeNumber: null, swipeCount: 0 };
    const swipeIndex = Number(raw.swipe_id);
    if (!Number.isSafeInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= raw.swipes.length)
        throw new ToolkitError('INVALID_MESSAGE', `楼层 ${absoluteIndex} 的 swipe_id 无法定位当前候选`, { absoluteIndex, swipeId: raw.swipe_id });
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

export function projectConversationSnapshot(snapshot) {
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
        const role = classifyMessage(raw, absoluteIndex, { chatKind: snapshot.identity.ref?.kind });
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
        items.push({
            conversationIndex: items.length + 1,
            absoluteIndex,
            chatKind: snapshot.identity.ref?.kind,
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
    return { identity: structuredClone(snapshot.identity), items, stats };
}

export function matchesProjectedMessageTarget(raw, item) {
    try {
        return classifyMessage(raw, item.absoluteIndex, { chatKind: item.chatKind }) === item.role
            && sameComparable(comparableTarget(raw, item.role), item.target);
    }
    catch {
        return false;
    }
}
