import { ToolkitError } from '../../kernel/errors.js';
import { classifyMessage } from '../../kernel/chat-messages.js';
import { isRecord, parseProgress, parseSettings } from './schema.js';
import { cleanWithRules, rulesFingerprint } from './rules.js';
import { cleanerIssue } from './diagnostics.js';

export { classifyMessage };
function field(record, key) {
    return { present: Object.hasOwn(record, key), value: structuredClone(record[key]) };
}
function reasoningSnapshot(extra) {
    return {
        reasoning: field(extra, 'reasoning'),
        reasoningType: field(extra, 'reasoning_type'),
        reasoningDuration: field(extra, 'reasoning_duration'),
    };
}
function pushReasoningPatch(patches, extra, location, messageIndex, warnings, issues) {
    if (extra === undefined || extra === null)
        return;
    const prefix = location.kind === 'top' ? 'extra' : 'swipe_info.extra';
    if (!isRecord(extra)) {
        cleanerIssue(issues, warnings, messageIndex, prefix, 'record', extra, 'reasoning-extra-invalid',
            'reasoning extra 不是对象，已保留该字段。', location.swipeIndex);
        return;
    }
    const before = reasoningSnapshot(extra);
    if (before.reasoning.present && typeof before.reasoning.value !== 'string') {
        cleanerIssue(issues, warnings, messageIndex, `${prefix}.reasoning`, 'string', extra.reasoning, 'reasoning-type-invalid',
            'reasoning 不是字符串，已保留该字段。', location.swipeIndex);
        return;
    }
    if ((!before.reasoning.present || before.reasoning.value === '') && !before.reasoningType.present && !before.reasoningDuration.present)
        return;
    patches.push({ location, before, removedChars: typeof before.reasoning.value === 'string' ? before.reasoning.value.length : 0 });
}
function enabledRules(settings, role) {
    const group = settings[role];
    return group.enabled ? group.rules.filter(rule => rule.enabled) : [];
}
function cleanMessage(raw, messageIndex, role, settings, warnings, issues, context) {
    const rules = enabledRules(settings, role);
    const bodyPatches = [];
    const reasoningPatches = [];
    const emptySwipeIndexes = [];
    const rawSwipes = raw.swipes;
    const hasSwipes = Array.isArray(rawSwipes) && rawSwipes.length > 0;
    const currentSwipe = hasSwipes ? raw.swipe_id : null;
    const candidateTexts = [];
    let clearSwipesPatch = null;
    const report = (key, expected, actual, reason, message, swipeIndex) =>
        cleanerIssue(issues, warnings, messageIndex, key, expected, actual, reason, message, swipeIndex);
    const validCurrent = hasSwipes && Number.isSafeInteger(currentSwipe) && currentSwipe >= 0 && currentSwipe < rawSwipes.length;
    const projectionMatchesSwipe = validCurrent && raw.mes === rawSwipes[currentSwipe];
    const allowsGreetingProjection = messageIndex === 0 && context.chatKind === 'character';
    const bodyLocatable = typeof raw.mes === 'string' && (!hasSwipes || (validCurrent
        && typeof rawSwipes[currentSwipe] === 'string' && (projectionMatchesSwipe || allowsGreetingProjection)));
    if (typeof raw.mes !== 'string')
        report('mes', 'string', raw.mes, 'body-type-invalid', 'mes 不是字符串，已跳过正文。');
    if (rawSwipes !== undefined && !Array.isArray(rawSwipes))
        report('swipes', 'array', rawSwipes, 'swipes-type-invalid', 'swipes 不是数组，已保留候选字段并跳过正文。');
    else if (hasSwipes) {
        if (!validCurrent)
            report('swipe_id', 'index-within-swipes', raw.swipe_id, 'current-swipe-invalid', '无法定位当前候选，已跳过正文及候选清除。');
        else if (!projectionMatchesSwipe && !allowsGreetingProjection)
            report('mes', 'matches-current-swipe', raw.mes, 'projection-diverged', 'mes 与当前 swipe 正文不一致，已跳过正文及候选清除。', currentSwipe);
        for (let swipeIndex = 0; swipeIndex < rawSwipes.length; swipeIndex += 1) {
            const text = rawSwipes[swipeIndex];
            if (typeof text !== 'string') {
                report('swipes', 'string', text, 'swipe-body-type-invalid', '候选正文不是字符串，已跳过该候选的正文规则。', swipeIndex);
                continue;
            }
            if (bodyLocatable && (!settings.clearSwipes || swipeIndex === currentSwipe))
                candidateTexts.push({ swipeIndex, text, updateTopProjection: projectionMatchesSwipe && swipeIndex === currentSwipe });
        }
        if (bodyLocatable && !projectionMatchesSwipe)
            candidateTexts.push({ swipeIndex: null, text: raw.mes, updateTopProjection: true });
        if (settings.clearSwipes && rawSwipes.length > 1 && bodyLocatable) {
            if (raw.tt_swipe_cold)
                report('tt_swipe_cold', 'hydrated-swipes', raw.tt_swipe_cold, 'cold-swipes-not-hydrated', '冷候选尚未成功读回，已跳过候选清除。');
            else if (raw.swipe_info !== undefined && (!Array.isArray(raw.swipe_info) || raw.swipe_info.length !== rawSwipes.length))
                report('swipe_info', 'array-matching-swipes', raw.swipe_info, 'swipe-info-invalid', 'swipe_info 无法对应候选，已跳过候选清除。');
            else
                clearSwipesPatch = { currentSwipe, removedCount: rawSwipes.length - 1, beforeInfo: field(raw, 'swipe_info') };
        }
        // If clearing cannot run, clean every readable candidate instead of silently omitting them.
        if (settings.clearSwipes && !clearSwipesPatch && bodyLocatable) {
            for (let swipeIndex = 0; swipeIndex < rawSwipes.length; swipeIndex += 1) {
                if (swipeIndex !== currentSwipe && typeof rawSwipes[swipeIndex] === 'string')
                    candidateTexts.push({ swipeIndex, text: rawSwipes[swipeIndex], updateTopProjection: false });
            }
        }
    }
    else if (bodyLocatable)
        candidateTexts.push({ swipeIndex: null, text: raw.mes, updateTopProjection: true });
    for (const candidate of candidateTexts) {
        const result = cleanWithRules(candidate.text, rules);
        if (result.text !== candidate.text) {
            bodyPatches.push({
                swipeIndex: candidate.swipeIndex, before: candidate.text, after: result.text,
                updateTopProjection: candidate.updateTopProjection, matchCount: result.matchCount,
                unmatchedStartCount: result.unmatchedStartCount, unmatchedEndCount: result.unmatchedEndCount,
            });
            if (result.text.length === 0)
                emptySwipeIndexes.push(candidate.swipeIndex);
        }
        if (result.unmatchedStartCount || result.unmatchedEndCount)
            warnings.push(`楼层 ${messageIndex}${candidate.swipeIndex === null ? '' : ` swipe ${candidate.swipeIndex + 1}`} 存在未配对标记，未确定区段保持不变。`);
    }
    if (role === 'assistant' && settings.deleteNativeReasoning) {
        if (hasSwipes) {
            if (raw.swipe_info !== undefined && !Array.isArray(raw.swipe_info) && !settings.clearSwipes)
                report('swipe_info', 'array', raw.swipe_info, 'swipe-info-invalid', 'swipe_info 不是数组，已保留候选 reasoning。');
            const swipeInfo = Array.isArray(raw.swipe_info) ? raw.swipe_info : [];
            for (let swipeIndex = 0; swipeIndex < rawSwipes.length; swipeIndex += 1) {
                if (clearSwipesPatch && swipeIndex !== currentSwipe)
                    continue;
                const info = swipeInfo[swipeIndex];
                if (info === undefined || info === null)
                    continue;
                if (!isRecord(info)) {
                    report('swipe_info', 'record', info, 'swipe-info-entry-invalid', 'swipe_info 不是对象，已保留其 reasoning。', swipeIndex);
                    continue;
                }
                pushReasoningPatch(reasoningPatches, info.extra, { kind: 'swipe', swipeIndex }, messageIndex, warnings, issues);
            }
        }
        pushReasoningPatch(reasoningPatches, raw.extra, { kind: 'top' }, messageIndex, warnings, issues);
    }
    if (clearSwipesPatch) {
        for (const issue of issues) {
            if (issue.messageIndex === messageIndex && issue.reason === 'swipe-body-type-invalid' && issue.swipeIndex !== currentSwipe) {
                issue.outcome = 'candidate-removal-planned';
                issue.nextAction = 'review-and-confirm';
            }
        }
    }
    if (!bodyPatches.length && !reasoningPatches.length && !clearSwipesPatch)
        return null;
    const bodyRemoved = bodyPatches.reduce((total, patch) => total + patch.before.length - patch.after.length, 0);
    const reasoningRemoved = reasoningPatches.reduce((total, patch) => total + patch.removedChars, 0);
    return {
        messageIndex, role, bodyPatches, reasoningPatches, emptySwipeIndexes, clearSwipesPatch,
        beforeFields: Object.fromEntries(['mes', 'swipes', 'swipe_id', 'tt_swipe_cold'].map(key => [key, field(raw, key)])),
        removedChars: bodyRemoved + reasoningRemoved,
    };
}
function boundary(indexes, keep) {
    const eligible = Math.max(0, indexes.length - keep);
    return eligible > 0 ? (indexes[eligible - 1] ?? -1) : -1;
}
function nextProgress(stableChatId, fingerprint, assistantThrough, userThrough, lastSuccessfulAt) {
    return { schemaVersion: 2, stableChatId, assistantThrough, userThrough, rulesFingerprint: fingerprint, lastSuccessfulAt };
}
function emptyStats(scannedMessages = 0, classification = {}) {
    return {
        totalMessages: classification.totalMessages ?? 0,
        eligibleMessages: classification.eligibleMessages ?? 0,
        excludedSystemMessages: classification.excludedSystemMessages ?? 0,
        excludedToolMessages: classification.excludedToolMessages ?? 0,
        hiddenEligibleMessages: classification.hiddenEligibleMessages ?? 0,
        compactEligibleMessages: classification.compactEligibleMessages ?? 0,
        scannedMessages, changedMessages: 0, changedSwipes: 0, removedSwipes: 0, degradedMessages: 0,
        matchCount: 0, bodyRemovedChars: 0, reasoningRemovedChars: 0, removedChars: 0,
        unmatchedStartCount: 0, unmatchedEndCount: 0,
    };
}
export function buildOperationPlan(snapshot, settingsInput, options) {
    const settings = parseSettings(settingsInput);
    const progress = parseProgress(options.progress);
    if (progress.stableChatId !== null && progress.stableChatId !== snapshot.identity.stableId)
        throw new ToolkitError('PROGRESS_CHAT_MISMATCH', '清洗进度绑定的聊天身份与当前聊天不一致');
    const keepAssistant = options.mode === 'auto' ? settings.auto.keepAssistant : options.keep;
    const keepUser = options.mode === 'auto' ? settings.auto.keepUser : options.keep;
    if (!Number.isSafeInteger(keepAssistant) || keepAssistant < 0 || !Number.isSafeInteger(keepUser) || keepUser < 0)
        throw new ToolkitError('INVALID_RANGE', '保留数量必须是非负安全整数');
    if (options.mode === 'auto' && (keepAssistant < 1 || keepUser < 1))
        throw new ToolkitError('INVALID_RANGE', '自动清洗至少分别保留一条 AI 和用户消息');
    const assistantIndexes = [];
    const userIndexes = [];
    const rolesByIndex = [];
    const warnings = [];
    const issues = [];
    const classificationStats = {
        totalMessages: snapshot.messages.length, eligibleMessages: 0, excludedSystemMessages: 0,
        excludedToolMessages: 0, hiddenEligibleMessages: 0, compactEligibleMessages: 0,
    };
    snapshot.messages.forEach((message, index) => {
        if (!isRecord(message)) {
            cleanerIssue(issues, warnings, index, 'message', 'record', message, 'message-type-invalid', '楼层不是对象，已跳过。');
            return;
        }
        const role = classifyMessage(message, index);
        rolesByIndex[index] = role;
        if (role === 'assistant') assistantIndexes.push(index);
        if (role === 'user') userIndexes.push(index);
        if (role === 'system') classificationStats.excludedSystemMessages += 1;
        if (role === 'tool') classificationStats.excludedToolMessages += 1;
        if (role === 'assistant' || role === 'user') {
            classificationStats.eligibleMessages += 1;
            const extra = isRecord(message.extra) ? message.extra : {};
            if (message.is_system === true) classificationStats.hiddenEligibleMessages += 1;
            if (extra.isSmallSys === true) classificationStats.compactEligibleMessages += 1;
        }
    });
    const assistantBoundary = boundary(assistantIndexes, keepAssistant);
    const userBoundary = boundary(userIndexes, keepUser);
    const fingerprint = rulesFingerprint(settings);
    let baselineReason = null;
    if (options.mode === 'auto') {
        if (!progress.rulesFingerprint) baselineReason = 'first-run';
        else if (progress.rulesFingerprint !== fingerprint) baselineReason = 'rules-changed';
    }
    if (baselineReason !== null) {
        return {
            mode: options.mode, identity: snapshot.identity, rulesFingerprint: fingerprint, baselineOnly: true, baselineReason,
            keepAssistant, keepUser, rollback: { assistant: false, user: false }, targetIndexes: [], changes: [], warnings, issues,
            stats: emptyStats(0, classificationStats),
            nextProgress: nextProgress(snapshot.identity.stableId, fingerprint, assistantBoundary, userBoundary, progress.lastSuccessfulAt),
        };
    }
    const assistantActive = settings.clearSwipes || settings.deleteNativeReasoning || enabledRules(settings, 'assistant').length > 0;
    const userActive = settings.clearSwipes || enabledRules(settings, 'user').length > 0;
    // In-place edits do not change watermarks; only out-of-bounds deletion rolls them back.
    const rollback = { assistant: progress.assistantThrough >= snapshot.messages.length, user: progress.userThrough >= snapshot.messages.length };
    const assistantResume = rollback.assistant ? -1 : progress.assistantThrough;
    const userResume = rollback.user ? -1 : progress.userThrough;
    const assistantTargets = options.mode === 'manual' || assistantActive
        ? assistantIndexes.filter(index => index <= assistantBoundary && (options.mode === 'manual' || index > assistantResume)) : [];
    const userTargets = options.mode === 'manual' || userActive
        ? userIndexes.filter(index => index <= userBoundary && (options.mode === 'manual' || index > userResume)) : [];
    const targetIndexes = [...assistantTargets, ...userTargets].sort((a, b) => a - b);
    const changes = [];
    const stats = emptyStats(targetIndexes.length, classificationStats);
    for (const messageIndex of targetIndexes) {
        const role = rolesByIndex[messageIndex];
        const change = cleanMessage(snapshot.messages[messageIndex], messageIndex, role, settings, warnings, issues, { chatKind: snapshot.identity.ref?.kind });
        if (!change) continue;
        changes.push(change);
        stats.changedMessages += 1;
        stats.changedSwipes += change.bodyPatches.length + change.reasoningPatches.length;
        stats.removedSwipes += change.clearSwipesPatch?.removedCount ?? 0;
        for (const patch of change.bodyPatches) {
            stats.matchCount += patch.matchCount;
            stats.bodyRemovedChars += patch.before.length - patch.after.length;
            stats.unmatchedStartCount += patch.unmatchedStartCount;
            stats.unmatchedEndCount += patch.unmatchedEndCount;
        }
        for (const patch of change.reasoningPatches) stats.reasoningRemovedChars += patch.removedChars;
    }
    stats.removedChars = stats.bodyRemovedChars + stats.reasoningRemovedChars;
    stats.degradedMessages = new Set(issues.map(issue => issue.messageIndex)).size;
    // Retry incomplete floors on later automatic runs instead of marking them fully cleaned.
    const resumeThrough = (role, end) => {
        const incomplete = issues.filter(issue => rolesByIndex[issue.messageIndex] === role || !rolesByIndex[issue.messageIndex]);
        return incomplete.reduce((through, issue) => Math.min(through, issue.messageIndex - 1), end);
    };
    return {
        mode: options.mode, identity: snapshot.identity, rulesFingerprint: fingerprint, baselineOnly: false, baselineReason: null,
        keepAssistant, keepUser, rollback, targetIndexes, changes, warnings, issues, stats,
        nextProgress: nextProgress(snapshot.identity.stableId, fingerprint, resumeThrough('assistant', assistantBoundary), resumeThrough('user', userBoundary), new Date().toISOString()),
    };
}
export const cleanerInternals = { classifyMessage, reasoningSnapshot };
