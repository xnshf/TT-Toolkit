import { sameConversationIdentity } from '../../kernel/chat-projection.js';
import { errorKind, errorMessage, ToolkitError } from '../../kernel/errors.js';
import { worldInfoSnapshotFailureData } from '../../kernel/world-info.js';
import { invalidateSourceSnapshot } from './collect.js';
import {
    applyStagedChanges,
    buildOverrideLookup,
    createStagedChange,
    overrideRecordKey,
    sameMetadata,
    stageChange,
} from './overrides.js';
import { parsePromptConflictChatMetadata } from './schema.js';

// 暂存与写回流程都围绕 runtime 的状态展开，这里以显式传参的函数实现，runtime 只保留同名薄方法。
function buildChange(source, action) {
    return createStagedChange({
        sourceId: source.sourceId,
        worldDigest: source.worldDigest,
        uid: source.uid,
        contentDigest: source.rawContentDigest,
        action,
        dynamic: source.dynamic,
    });
}

export function stageSuppress(runtime, sourceId) {
    const source = runtime.snapshotSources().find(candidate => candidate.sourceId === sourceId);
    if (!source || source.sourceType !== 'world-info' || source.suppressedForCurrentChat)
        return;
    runtime.mutable.stagedChanges = stageChange(runtime.mutable.stagedChanges, buildChange(source, 'suppress'));
    runtime.log?.debug('staged.suppressed', { data: { changeCount: runtime.mutable.stagedChanges.size } });
    runtime.notify();
}

export function stageRestore(runtime, sourceId) {
    const source = runtime.snapshotSources().find(candidate => candidate.sourceId === sourceId);
    if (!source || source.sourceType !== 'world-info' || !source.suppressedForCurrentChat)
        return;
    runtime.mutable.stagedChanges = stageChange(runtime.mutable.stagedChanges, buildChange(source, 'restore'));
    runtime.log?.debug('staged.restored', { data: { changeCount: runtime.mutable.stagedChanges.size } });
    runtime.notify();
}

export function stageRestoreRecord(runtime, record) {
    const key = overrideRecordKey(record);
    const existing = runtime.snapshotSources().find(source =>
        source.sourceType === 'world-info'
        && `${source.worldDigest}:${typeof source.uid}:${String(source.uid)}` === key);
    const sourceId = existing?.sourceId ?? `wi:${record.worldDigest}:${String(record.uid)}`;
    const change = createStagedChange({
        sourceId,
        worldDigest: record.worldDigest,
        uid: record.uid,
        contentDigest: record.contentDigest,
        action: 'restore',
        dynamic: false,
    });
    runtime.mutable.stagedChanges = stageChange(runtime.mutable.stagedChanges, change);
    runtime.notify();
}

export function clearStagedChanges(runtime) {
    runtime.mutable.stagedChanges = new Map();
    runtime.notify();
}

export async function beginApplyReview(runtime) {
    if (runtime.mutable.applying || !runtime.mutable.stagedChanges.size)
        return;
    try {
        const identity = await runtime.host.getCurrentChatIdentity();
        runtime.applyAnchorIdentity = identity;
        runtime.mutable.applying = true;
        runtime.mutable.phase = 'applying';
        runtime.mutable.error = '';
        runtime.notify();
    }
    catch (error) {
        runtime.log?.error('apply.review_failed', { data: { operation: 'apply.review', ...errorKind(error) }, sensitive: { error } });
        runtime.setError(errorMessage(error), 'apply.review_failed');
    }
}

export function cancelApplyReview(runtime) {
    runtime.mutable.applying = false;
    runtime.mutable.phase = 'idle';
    runtime.applyAnchorIdentity = null;
    runtime.notify();
}

// 写回前逐条复核：聊天身份未变、待屏蔽条目仍在且正文摘要未变、待恢复记录仍存在。
async function verifyPlan(runtime, plan, anchor) {
    const identity = await runtime.host.getCurrentChatIdentity();
    if (!sameConversationIdentity(identity, anchor))
        throw new ToolkitError('CHAT_CHANGED', '应用前聊天已切换，未写入任何变更，请重新检查。');
    const metadata = parsePromptConflictChatMetadata(await runtime.host.getPromptConflictChatMetadata());
    const groups = await runtime.host.getMountedWorldInfoEntries();
    const lookup = await buildOverrideLookup(groups);
    for (const change of plan.values()) {
        const key = overrideRecordKey(change);
        if (change.action === 'suppress') {
            const entryInfo = lookup.get(key);
            if (!entryInfo || entryInfo.contentDigest !== change.contentDigest)
                throw new ToolkitError('PROMPT_CONFLICT_ENTRY_CHANGED', '目标世界书条目已删除、已修改或已变为非常驻，未写入任何变更，请重新检查暂存计划。');
        }
        else if (!metadata.disabledWorldEntries.some(record => overrideRecordKey(record) === key)) {
            throw new ToolkitError('PROMPT_CONFLICT_OVERRIDE_STALE', '待恢复的屏蔽记录已不存在，未写入任何变更，请重新检查暂存计划。');
        }
    }
    return { identity, metadata };
}

export async function commitStagedChanges(runtime) {
    const plan = runtime.mutable.stagedChanges;
    const anchor = runtime.applyAnchorIdentity;
    if (!runtime.mutable.applying || !anchor || !plan.size) {
        cancelApplyReview(runtime);
        return;
    }
    try {
        const { identity, metadata } = await verifyPlan(runtime, plan, anchor);
        if (runtime.applyAnchorIdentity !== anchor)
            return;
        const next = applyStagedChanges(metadata, plan);
        const result = !sameMetadata(metadata, next)
            ? await runtime.host.setPromptConflictChatMetadata(identity.stableId, next, identity.ref)
            : null;
        const suppressedCount = [...plan.values()].filter(change => change.action === 'suppress').length;
        const restoredCount = [...plan.values()].filter(change => change.action === 'restore').length;
        if (runtime.applyAnchorIdentity === anchor) {
            runtime.mutable.stagedChanges = new Map();
            runtime.mutable.applying = false;
            runtime.applyAnchorIdentity = null;
            await runtime.refresh();
        }
        if (!runtime.applyAnchorIdentity) {
            runtime.mutable.status = result?.localMirror === false
                ? '已写入原聊天，但未同步当前界面。请重新打开原聊天核对，不要重复提交。'
                : `已写入当前聊天：屏蔽 ${suppressedCount} 项，恢复 ${restoredCount} 项。`;
            runtime.notify();
        }
        runtime.log?.info('overrides.committed', { data: { suppressedCount, restoredCount } });
    }
    catch (error) {
        if (runtime.applyAnchorIdentity !== anchor)
            return;
        runtime.mutable.applying = false;
        runtime.applyAnchorIdentity = null;
        const sourceFailure = worldInfoSnapshotFailureData(error);
        if (sourceFailure) {
            invalidateSourceSnapshot(runtime);
            runtime.setError(`${error.message} 未写入任何变更。`, 'overrides.commit_failed', {
                ...sourceFailure, outcome: 'not-written',
            });
        }
        else {
            runtime.log?.error('overrides.commit_failed', {
                data: { operation: 'overrides.commit', ...errorKind(error) },
                sensitive: { error },
            });
            runtime.setError(errorMessage(error), 'overrides.commit_failed');
        }
    }
}
