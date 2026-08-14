import { ToolkitError } from '../../kernel/errors.js';
import { classifyMessage, hasAssistantProvenance } from '../../kernel/chat-messages.js';
import { isRecord, parseProgress, parseSettings } from './schema.js';
import { cleanWithRules, rulesFingerprint } from './rules.js';

export { classifyMessage };
function field(record, key) {
    return { present: Object.hasOwn(record, key), value: record[key] };
}
function reasoningSnapshot(extra) {
    const snapshot = {
        reasoning: field(extra, 'reasoning'),
        reasoningType: field(extra, 'reasoning_type'),
        reasoningDuration: field(extra, 'reasoning_duration'),
    };
    if (snapshot.reasoning.present && typeof snapshot.reasoning.value !== 'string') {
        throw new ToolkitError('INVALID_MESSAGE', '原生 reasoning 存在时必须是字符串');
    }
    return snapshot;
}
function reasoningNeedsChange(snapshot) {
    return (snapshot.reasoning.present && snapshot.reasoning.value !== '')
        || snapshot.reasoningType.present
        || snapshot.reasoningDuration.present;
}
function pushReasoningPatch(patches, extra, location, messageIndex, warnings) {
    if (extra === undefined || extra === null)
        return;
    if (!isRecord(extra)) {
        warnings.push(`楼层 ${messageIndex} 的 reasoning extra 不是对象，已保留该字段。`);
        return;
    }
    let before;
    try {
        before = reasoningSnapshot(extra);
    }
    catch (error) {
        throw new ToolkitError('INVALID_MESSAGE', '原生 reasoning 存在时必须是字符串', {
            messageIndex,
            location,
            cause: error instanceof Error ? error.message : String(error),
        });
    }
    if (!reasoningNeedsChange(before))
        return;
    patches.push({
        location,
        before,
        removedChars: typeof before.reasoning.value === 'string' ? before.reasoning.value.length : 0,
    });
}
function enabledRules(settings, role) {
    const group = settings[role];
    return group.enabled ? group.rules.filter(rule => rule.enabled) : [];
}
function cleanMessage(raw, messageIndex, role, settings, warnings) {
    if (!isRecord(raw))
        throw new ToolkitError('INVALID_MESSAGE', '目标楼层必须是对象', { messageIndex });
    const rules = enabledRules(settings, role);
    const bodyPatches = [];
    const reasoningPatches = [];
    const emptySwipeIndexes = [];
    const rawSwipes = raw.swipes;
    const hasSwipes = Array.isArray(rawSwipes) && rawSwipes.length > 0;
    const currentSwipe = hasSwipes ? Number(raw.swipe_id) : null;
    if (hasSwipes && (!Number.isSafeInteger(currentSwipe) || currentSwipe === null || currentSwipe < 0 || currentSwipe >= rawSwipes.length)) {
        throw new ToolkitError('INVALID_MESSAGE', 'swipe_id 无法定位当前 swipe', { messageIndex, swipeId: raw.swipe_id });
    }
    const candidateTexts = [];
    if (hasSwipes) {
        for (let swipeIndex = 0; swipeIndex < rawSwipes.length; swipeIndex += 1) {
            const text = rawSwipes[swipeIndex];
            if (typeof text !== 'string')
                throw new ToolkitError('INVALID_MESSAGE', 'swipes 中的正文必须是字符串', { messageIndex, swipeIndex });
            candidateTexts.push({ swipeIndex, text, updateTopProjection: swipeIndex === currentSwipe });
        }
        if (typeof raw.mes !== 'string' || raw.mes !== rawSwipes[currentSwipe]) {
            throw new ToolkitError('INVALID_MESSAGE', 'mes 与当前 swipe 正文不一致', { messageIndex, swipeIndex: currentSwipe });
        }
    }
    else {
        if (typeof raw.mes !== 'string')
            throw new ToolkitError('INVALID_MESSAGE', '消息正文必须是字符串', { messageIndex });
        candidateTexts.push({ swipeIndex: null, text: raw.mes, updateTopProjection: true });
    }
    if (rules.length > 0) {
        for (const candidate of candidateTexts) {
            const result = cleanWithRules(candidate.text, rules);
            if (result.text !== candidate.text) {
                bodyPatches.push({
                    swipeIndex: candidate.swipeIndex,
                    before: candidate.text,
                    after: result.text,
                    updateTopProjection: candidate.updateTopProjection,
                    matchCount: result.matchCount,
                    unmatchedStartCount: result.unmatchedStartCount,
                    unmatchedEndCount: result.unmatchedEndCount,
                });
                if (result.text.length === 0)
                    emptySwipeIndexes.push(candidate.swipeIndex);
            }
            if (result.unmatchedStartCount || result.unmatchedEndCount) {
                warnings.push(`楼层 ${messageIndex}${candidate.swipeIndex === null ? '' : ` swipe ${candidate.swipeIndex + 1}`} 存在未配对标记，未确定区段保持不变。`);
            }
        }
    }
    if (role === 'assistant' && settings.deleteNativeReasoning) {
        if (hasSwipes) {
            const swipeInfo = Array.isArray(raw.swipe_info) ? raw.swipe_info : [];
            for (let swipeIndex = 0; swipeIndex < rawSwipes.length; swipeIndex += 1) {
                const info = swipeInfo[swipeIndex];
                if (info === undefined || info === null)
                    continue;
                if (!isRecord(info)) {
                    warnings.push(`楼层 ${messageIndex} swipe ${swipeIndex + 1} 的 swipe_info 不是对象，已保留其 reasoning。`);
                    continue;
                }
                pushReasoningPatch(reasoningPatches, info.extra, { kind: 'swipe', swipeIndex }, messageIndex, warnings);
            }
            pushReasoningPatch(reasoningPatches, raw.extra, { kind: 'top' }, messageIndex, warnings);
        }
        else {
            pushReasoningPatch(reasoningPatches, raw.extra, { kind: 'top' }, messageIndex, warnings);
        }
    }
    if (!bodyPatches.length && !reasoningPatches.length)
        return null;
    const bodyRemoved = bodyPatches.reduce((total, patch) => total + patch.before.length - patch.after.length, 0);
    const reasoningRemoved = reasoningPatches.reduce((total, patch) => total + patch.removedChars, 0);
    return {
        messageIndex,
        role,
        bodyPatches,
        reasoningPatches,
        emptySwipeIndexes,
        removedChars: bodyRemoved + reasoningRemoved,
    };
}
function boundary(indexes, keep) {
    const eligible = Math.max(0, indexes.length - keep);
    return eligible > 0 ? (indexes[eligible - 1] ?? -1) : -1;
}
function nextProgress(stableChatId, fingerprint, assistantThrough, userThrough, lastSuccessfulAt) {
    return {
        schemaVersion: 2,
        stableChatId,
        assistantThrough,
        userThrough,
        rulesFingerprint: fingerprint,
        lastSuccessfulAt,
    };
}
function emptyStats(scannedMessages = 0, classification = {}) {
    return {
        totalMessages: classification.totalMessages ?? 0,
        eligibleMessages: classification.eligibleMessages ?? 0,
        excludedSystemMessages: classification.excludedSystemMessages ?? 0,
        excludedToolMessages: classification.excludedToolMessages ?? 0,
        hiddenEligibleMessages: classification.hiddenEligibleMessages ?? 0,
        compactEligibleMessages: classification.compactEligibleMessages ?? 0,
        scannedMessages,
        changedMessages: 0,
        changedSwipes: 0,
        matchCount: 0,
        bodyRemovedChars: 0,
        reasoningRemovedChars: 0,
        removedChars: 0,
        unmatchedStartCount: 0,
        unmatchedEndCount: 0,
    };
}
export function buildOperationPlan(snapshot, settingsInput, options) {
    const settings = parseSettings(settingsInput);
    const progress = parseProgress(options.progress);
    if (progress.stableChatId !== null && progress.stableChatId !== snapshot.identity.stableId) {
        throw new ToolkitError('PROGRESS_CHAT_MISMATCH', '清洗进度绑定的聊天身份与当前聊天不一致');
    }
    const keepAssistant = options.mode === 'auto' ? settings.auto.keepAssistant : options.keep;
    const keepUser = options.mode === 'auto' ? settings.auto.keepUser : options.keep;
    if (!Number.isSafeInteger(keepAssistant) || keepAssistant < 0 || !Number.isSafeInteger(keepUser) || keepUser < 0) {
        throw new ToolkitError('INVALID_RANGE', '保留数量必须是非负安全整数');
    }
    if (options.mode === 'auto' && (keepAssistant < 1 || keepUser < 1)) {
        throw new ToolkitError('INVALID_RANGE', '自动清洗至少分别保留一条 AI 和用户消息');
    }
    const assistantIndexes = [];
    const userIndexes = [];
    const rolesByIndex = [];
    const classificationStats = {
        totalMessages: snapshot.messages.length,
        eligibleMessages: 0,
        excludedSystemMessages: 0,
        excludedToolMessages: 0,
        hiddenEligibleMessages: 0,
        compactEligibleMessages: 0,
    };
    snapshot.messages.forEach((message, index) => {
        const role = classifyMessage(message, index);
        rolesByIndex[index] = role;
        if (role === 'assistant')
            assistantIndexes.push(index);
        if (role === 'user')
            userIndexes.push(index);
        if (role === 'system')
            classificationStats.excludedSystemMessages += 1;
        if (role === 'tool')
            classificationStats.excludedToolMessages += 1;
        if (role === 'assistant' || role === 'user') {
            classificationStats.eligibleMessages += 1;
            const extra = isRecord(message.extra) ? message.extra : {};
            if (message.is_system === true)
                classificationStats.hiddenEligibleMessages += 1;
            if (extra.isSmallSys === true)
                classificationStats.compactEligibleMessages += 1;
        }
    });
    const assistantBoundary = boundary(assistantIndexes, keepAssistant);
    const userBoundary = boundary(userIndexes, keepUser);
    const fingerprint = rulesFingerprint(settings);
    let baselineReason = null;
    if (options.mode === 'auto') {
        if (!progress.rulesFingerprint)
            baselineReason = 'first-run';
        else if (progress.rulesFingerprint !== fingerprint)
            baselineReason = 'rules-changed';
    }
    if (baselineReason !== null) {
        return {
            mode: options.mode,
            identity: snapshot.identity,
            rulesFingerprint: fingerprint,
            baselineOnly: true,
            baselineReason,
            keepAssistant,
            keepUser,
            rollback: { assistant: false, user: false },
            targetIndexes: [],
            changes: [],
            warnings: [],
            stats: emptyStats(0, classificationStats),
            nextProgress: nextProgress(snapshot.identity.stableId, fingerprint, assistantBoundary, userBoundary, progress.lastSuccessfulAt),
        };
    }
    const assistantActive = settings.deleteNativeReasoning || enabledRules(settings, 'assistant').length > 0;
    const userActive = enabledRules(settings, 'user').length > 0;
    // 删除楼层会让断点下标指向已不存在的楼层：该角色断点越界即回滚，重新从顶部校验；未越界忽略。
    // 手动编辑只改正文，不改楼层结构，不构成任何状态参考。
    const rollback = {
        assistant: progress.assistantThrough >= snapshot.messages.length,
        user: progress.userThrough >= snapshot.messages.length,
    };
    const assistantResume = rollback.assistant ? -1 : progress.assistantThrough;
    const userResume = rollback.user ? -1 : progress.userThrough;
    const assistantTargets = options.mode === 'manual' || assistantActive
        ? assistantIndexes.filter(index => index <= assistantBoundary && (options.mode === 'manual' || index > assistantResume))
        : [];
    const userTargets = options.mode === 'manual' || userActive
        ? userIndexes.filter(index => index <= userBoundary && (options.mode === 'manual' || index > userResume))
        : [];
    const targetIndexes = [...assistantTargets, ...userTargets].sort((a, b) => a - b);
    const warnings = [];
    const changes = [];
    const stats = emptyStats(targetIndexes.length, classificationStats);
    for (const messageIndex of targetIndexes) {
        const role = rolesByIndex[messageIndex];
        const change = cleanMessage(snapshot.messages[messageIndex], messageIndex, role, settings, warnings);
        if (!change)
            continue;
        changes.push(change);
        stats.changedMessages += 1;
        stats.changedSwipes += change.bodyPatches.length + change.reasoningPatches.length;
        for (const patch of change.bodyPatches) {
            stats.matchCount += patch.matchCount;
            stats.bodyRemovedChars += patch.before.length - patch.after.length;
            stats.unmatchedStartCount += patch.unmatchedStartCount;
            stats.unmatchedEndCount += patch.unmatchedEndCount;
        }
        for (const patch of change.reasoningPatches)
            stats.reasoningRemovedChars += patch.removedChars;
    }
    stats.removedChars = stats.bodyRemovedChars + stats.reasoningRemovedChars;
    return {
        mode: options.mode,
        identity: snapshot.identity,
        rulesFingerprint: fingerprint,
        baselineOnly: false,
        baselineReason: null,
        keepAssistant,
        keepUser,
        rollback,
        targetIndexes,
        changes,
        warnings,
        stats,
        nextProgress: nextProgress(snapshot.identity.stableId, fingerprint, assistantBoundary, userBoundary, new Date().toISOString()),
    };
}
export const cleanerInternals = { classifyMessage, hasAssistantProvenance, reasoningSnapshot };
