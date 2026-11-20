import { ToolkitError } from '../../kernel/errors.js';
import { isRecord } from './schema.js';
import { classifyMessage } from './plan.js';
function sameValue(a, b) {
    if (Object.is(a, b))
        return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b))
        return false;
    if (Array.isArray(a) && a.length !== b.length)
        return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
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
            throw new ToolkitError('COMMIT_CONFLICT', '预览后目标楼层的消息结构无效', {
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
        for (const [key, expected] of Object.entries(change.beforeFields)) {
            if (!sameField(raw, key, expected))
                throw new ToolkitError('COMMIT_CONFLICT', '预览后目标正文或候选结构已改变，请重新扫描。', { messageIndex: change.messageIndex });
        }
        if (change.clearSwipesPatch && !sameField(raw, 'swipe_info', change.clearSwipesPatch.beforeInfo))
            throw new ToolkitError('COMMIT_CONFLICT', '预览后候选信息已改变，请重新扫描。', { messageIndex: change.messageIndex });
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
        if (change.clearSwipesPatch) {
            const { currentSwipe } = change.clearSwipesPatch;
            raw.swipes = [raw.swipes[currentSwipe]];
            if (Array.isArray(raw.swipe_info))
                raw.swipe_info = [raw.swipe_info[currentSwipe]];
            raw.swipe_id = 0;
        }
    }
}
export function assertGenerationIdle(host, superseded = false, saved = false) {
    if (superseded || host.isGenerationInProgress()) {
        throw saved
            ? new ToolkitError('CLEANER_GENERATION_AFTER_SAVE', '聊天正文已保存；因宿主启动了生成，已停止剩余操作。请等待生成结束后重新预览。')
            : new ToolkitError('CLEANER_GENERATION_ACTIVE', '宿主正在生成或已开启新一轮生成；本次没有保存，请在生成结束后再提交。');
    }
}
function isCommitConflict(error) {
    return error?.code === 'CHAT_CHANGED' || error?.code === 'COMMIT_CONFLICT';
}
function commitConflict(error, afterSave = false) {
    const prefix = afterSave ? '宿主已返回正文保存成功，清洗进度未更新。' : '';
    const reason = error.code === 'CHAT_CHANGED' ? '当前聊天已切换' : '清洗目标已改变';
    return new ToolkitError(error.code, `${prefix}${reason}，请回到原聊天重新预览。`, { afterSave });
}
function refreshFailure(error) {
    if (isCommitConflict(error))
        return commitConflict(error, true);
    const saved = '宿主已返回正文保存成功，清洗进度未更新。';
    return new ToolkitError('CLEANER_REFRESH_FAILED', `${saved}聊天刷新未完成，请核对原聊天并重新预览。`);
}
export async function commitOperation(host, plan, log, checkWrite = saved => assertGenerationIdle(host, false, saved)) {
    const chatAlias = log ? host.chatAlias(plan.identity.stableId) : undefined;
    log?.debug('transaction.validating', { data: { chatAlias, changedMessages: plan.changes.length } });
    checkWrite(false);
    await host.assertIdentity(plan.identity.stableId, plan.identity.ref);
    const chat = host.context.chat;
    validatePlan(chat, plan);
    checkWrite(false);
    // No await between the final checks, the canonical mutation, and save dispatch.
    applyPlan(chat, plan);
    try {
        await host.saveCurrentChat();
    }
    catch (error) {
        if (isCommitConflict(error))
            throw error instanceof ToolkitError ? error : commitConflict(error);
        let recovery = 'skipped';
        try {
            await host.assertIdentity(plan.identity.stableId, plan.identity.ref);
            checkWrite(false);
            recovery = 'failed';
            await host.reloadCurrentChat();
            recovery = 'reloaded';
        }
        catch { /* The original save failed; never retry the recovery reload. */ }
        const detail = {
            skipped: '未尝试重载，请核对原聊天后重新预览',
            failed: '恢复重载也失败，请核对原聊天后重新预览',
            reloaded: '已重新载入原聊天，请重新预览',
        }[recovery];
        throw new ToolkitError('SAVE_FAILED', `聊天保存失败：${detail}。`, { recovery });
    }
    try {
        await host.assertIdentity(plan.identity.stableId, plan.identity.ref);
    }
    catch (error) {
        throw refreshFailure(error);
    }
    checkWrite(true);
    try {
        await host.reloadCurrentChat();
    }
    catch (error) {
        throw refreshFailure(error);
    }
    log?.info('transaction.persisted', { data: { chatAlias, changedMessages: plan.changes.length }, sensitive: { chatIdentity: plan.identity } });
}
export const transactionInternals = { validatePlan, applyPlan };
