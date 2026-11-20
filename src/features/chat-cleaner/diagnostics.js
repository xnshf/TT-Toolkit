import { ToolkitError } from '../../kernel/errors.js';
import { valueType } from '../../kernel/chat-diagnostics.js';

export function cleanerIssue(issues, warnings, messageIndex, field, expected, actual, reason, message, swipeIndex) {
    const issue = {
        messageIndex, field, expected, actualType: valueType(actual), reason,
        sourceLocation: 'chat-cleaner/plan.js:buildOperationPlan',
        outcome: 'field-preserved', nextAction: 'review-preview-or-reload',
    };
    if (Number.isSafeInteger(swipeIndex))
        issue.swipeIndex = swipeIndex;
    issues.push(issue);
    warnings.push(`楼层 ${messageIndex}${swipeIndex === undefined ? '' : ` swipe ${swipeIndex + 1}`}：${message}`);
}

const FAILURES = {
    COMMIT_CONFLICT: ['chat.target-validation', 'target-changed', 'rebuild-preview'],
    CHAT_CHANGED: ['chat.identity-validation', 'chat-changed', 'rebuild-preview'],
    SAVE_FAILED: ['chat.persistence', 'save-failed', 'verify-chat-and-rebuild'],
    CLEANER_REFRESH_FAILED: ['chat.refresh', 'refresh-failed-after-save', 'verify-chat-and-rebuild'],
    CLEANER_GENERATION_ACTIVE: ['chat.generation-guard', 'generation-active-or-superseded', 'wait-for-generation'],
    CLEANER_GENERATION_AFTER_SAVE: ['chat.generation-guard', 'generation-started-after-save', 'wait-and-rebuild-preview'],
    HOST_GENERATION_STATUS_MISSING: ['chat.generation-guard', 'generation-status-missing', 'check-host-build'],
    HOST_GENERATION_STATUS_INVALID: ['chat.generation-guard', 'generation-status-invalid', 'check-host-build'],
    PROGRESS_SAVE_FAILED: ['progress.persistence', 'progress-save-failed', 'reload-progress'],
    EMPTY_CONFIRM_REQUIRED: ['cleaner.confirmation', 'empty-confirmation-required', 'review-and-confirm'],
    AUTO_EMPTY_REJECTED: ['cleaner.confirmation', 'auto-empty-rejected', 'use-manual-preview'],
    NO_PLAN: ['cleaner.confirmation', 'preview-missing', 'rebuild-preview'],
    STALE_PLAN: ['cleaner.confirmation', 'preview-stale', 'rebuild-preview'],
    INVALID_RANGE: ['cleaner.selection', 'range-invalid', 'correct-range'],
    INVALID_SCHEMA: ['settings.validation', 'settings-invalid', 'correct-or-reset-settings'],
    UNSUPPORTED_SCHEMA: ['settings.validation', 'schema-unsupported', 'reset-settings-or-progress'],
    INVALID_PROGRESS: ['progress.validation', 'progress-invalid', 'reset-progress'],
    PROGRESS_CHAT_MISMATCH: ['progress.validation', 'progress-chat-mismatch', 'reset-progress'],
    NO_CHAT: ['chat.identity-validation', 'chat-unavailable', 'select-chat'],
    BUSY: ['cleaner.operation', 'operation-busy', 'wait-and-retry'],
};
export function logCleanerFailure(log, event, operation, error, sourceLocation = 'chat-cleaner/runtime.js') {
    const known = error instanceof ToolkitError && Object.hasOwn(FAILURES, error.code);
    const [stage, reason, nextAction] = known ? FAILURES[error.code] : [operation, 'operation-failed', 'retry-or-report'];
    const cancelled = error?.code === 'CLEANER_GENERATION_ACTIVE';
    const afterSave = known && (error.code === 'CLEANER_GENERATION_AFTER_SAVE' || error.code === 'CLEANER_REFRESH_FAILED'
        || (['CHAT_CHANGED', 'COMMIT_CONFLICT'].includes(error.code) && error.context?.afterSave === true));
    const outcome = cancelled ? 'cancelled-before-write' : afterSave ? 'saved-without-completing' : 'operation-stopped';
    const data = { operation, stage, reason, nextAction, outcome, sourceLocation,
        kind: error instanceof ToolkitError ? 'ToolkitError' : error instanceof Error ? 'Error' : typeof error };
    if (known)
        data.code = error.code;
    if (known && error.code === 'SAVE_FAILED' && ['skipped', 'failed', 'reloaded'].includes(error.context?.recovery))
        data.recovery = error.context.recovery;
    if (error instanceof ToolkitError && Number.isSafeInteger(error.context?.messageIndex))
        data.messageIndex = error.context.messageIndex;
    if (cancelled)
        log.info(event, { data });
    else
        log.warn(event, { data, sensitive: { error } });
}
