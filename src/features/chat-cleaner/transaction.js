import { ToolkitError, errorMessage } from '../../kernel/errors.js';
import { isRecord } from './schema.js';
import { classifyMessage } from './plan.js';
function sameValue(a, b) {
    if (Object.is(a, b))
        return true;
    return JSON.stringify(a) === JSON.stringify(b);
}
function currentField(record, key) {
    return { present: Object.hasOwn(record, key), value: record[key] };
}
function sameField(record, key, expected) {
    const current = currentField(record, key);
    return current.present === expected.present && sameValue(current.value, expected.value);
}
function sameReasoning(extra, expected) {
    return sameField(extra, 'reasoning', expected.reasoning)
        && sameField(extra, 'reasoning_type', expected.reasoningType)
        && sameField(extra, 'reasoning_duration', expected.reasoningDuration);
}
function resolveReasoningExtra(raw, patch) {
    if (patch.location.kind === 'top') {
        if (!isRecord(raw.extra))
            throw new ToolkitError('COMMIT_CONFLICT', '提交时消息 extra 已改变');
        return raw.extra;
    }
    const info = Array.isArray(raw.swipe_info) ? raw.swipe_info[patch.location.swipeIndex] : undefined;
    if (!isRecord(info) || !isRecord(info.extra))
        throw new ToolkitError('COMMIT_CONFLICT', '提交时 swipe_info.extra 已改变');
    return info.extra;
}
function validatePlan(chat, plan) {
    for (const change of plan.changes) {
        const raw = chat[change.messageIndex];
        if (!isRecord(raw))
            throw new ToolkitError('COMMIT_CONFLICT', '提交时目标楼层已不存在', { messageIndex: change.messageIndex });
        let currentRole;
        try {
            currentRole = classifyMessage(raw, change.messageIndex);
        }
        catch (error) {
            throw new ToolkitError('COMMIT_CONFLICT', '预览后目标楼层的消息类型已无法可靠判断', {
                messageIndex: change.messageIndex,
                cause: error instanceof ToolkitError ? error.code : error instanceof Error ? error.name : typeof error,
            });
        }
        if (currentRole !== change.role) {
            throw new ToolkitError('COMMIT_CONFLICT', '预览后目标楼层的消息类型已改变', {
                messageIndex: change.messageIndex,
                expectedRole: change.role,
                currentRole,
            });
        }
        for (const patch of change.bodyPatches) {
            const current = patch.swipeIndex === null
                ? raw.mes
                : Array.isArray(raw.swipes) ? raw.swipes[patch.swipeIndex] : undefined;
            if (current !== patch.before)
                throw new ToolkitError('COMMIT_CONFLICT', '预览后目标正文已改变', { messageIndex: change.messageIndex, swipeIndex: patch.swipeIndex });
            if (patch.updateTopProjection && raw.mes !== patch.before) {
                throw new ToolkitError('COMMIT_CONFLICT', '预览后当前正文投影已改变', { messageIndex: change.messageIndex });
            }
        }
        for (const patch of change.reasoningPatches) {
            const extra = resolveReasoningExtra(raw, patch);
            if (!sameReasoning(extra, patch.before))
                throw new ToolkitError('COMMIT_CONFLICT', '预览后 reasoning 已改变', { messageIndex: change.messageIndex, location: patch.location });
        }
    }
}
function clearReasoning(extra) {
    extra.reasoning = '';
    delete extra.reasoning_type;
    delete extra.reasoning_duration;
}
function applyPlan(chat, plan) {
    for (const change of plan.changes) {
        const raw = chat[change.messageIndex];
        for (const patch of change.bodyPatches) {
            if (patch.swipeIndex !== null)
                raw.swipes[patch.swipeIndex] = patch.after;
            if (patch.updateTopProjection)
                raw.mes = patch.after;
        }
        for (const patch of change.reasoningPatches)
            clearReasoning(resolveReasoningExtra(raw, patch));
    }
}
export async function commitOperation(host, plan, log) {
    const chatAlias = log ? host.chatAlias(plan.identity.stableId) : undefined;
    log?.debug('transaction.validating', { data: { chatAlias, changedMessages: plan.changes.length } });
    await host.assertIdentity(plan.identity.stableId);
    const chat = host.context.chat;
    validatePlan(chat, plan);
    applyPlan(chat, plan);
    log?.debug('transaction.applied', { data: { chatAlias, changedMessages: plan.changes.length } });
    try {
        await host.assertIdentity(plan.identity.stableId);
        await host.saveCurrentChat();
        await host.assertIdentity(plan.identity.stableId);
        await host.reloadCurrentChat();
        log?.info('transaction.persisted', { data: { chatAlias, changedMessages: plan.changes.length }, sensitive: { chatIdentity: plan.identity } });
    }
    catch (error) {
        try {
            await host.reloadCurrentChat();
        }
        catch { /* Report the original persistence failure. */ }
        log?.error('transaction.persistence_failed', { data: { chatAlias, changedMessages: plan.changes.length, errorKind: error instanceof ToolkitError ? error.code : error instanceof Error ? error.name : typeof error }, sensitive: { error, chatIdentity: plan.identity } });
        throw new ToolkitError('SAVE_FAILED', `聊天保存失败，已请求重新载入权威数据：${errorMessage(error)}`);
    }
}
export const transactionInternals = { validatePlan, applyPlan };
