import { ToolkitError } from './errors.js';

export function valueType(value) {
    return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

const FAILURE_REASONS = {
    INVALID_SNAPSHOT: ['snapshot-contract-invalid', 'reload-chat'],
    INVALID_RANGE: ['range-invalid', 'correct-range'],
    EMPTY_QUERY: ['query-empty', 'enter-query'],
    NO_SNAPSHOT: ['snapshot-missing', 'reload-chat'],
    NO_CHAT: ['chat-unavailable', 'select-chat'],
    NO_PLAN: ['preview-missing', 'rebuild-preview'],
    STALE_PLAN: ['preview-stale', 'rebuild-preview'],
    CHAT_CHANGED: ['chat-changed', 'reload-and-rebuild'],
    MESSAGE_CHANGED: ['message-changed', 'reload-and-rebuild'],
    MESSAGE_UNREADABLE: ['message-unreadable', 'select-readable-message'],
    EXPORT_CONFIRM_REQUIRED: ['risk-confirmation-required', 'review-and-confirm'],
    NO_ACTIVE_RULES: ['active-rules-missing', 'configure-rules'],
    EXPORT_SELECTION_EMPTY: ['selection-has-no-messages', 'change-range-or-role-filter'],
    EXPORT_RESULT_EMPTY: ['all-output-skipped', 'change-range-or-rules'],
    INVALID_SCHEMA: ['settings-invalid', 'correct-or-reset-settings'],
    UNSUPPORTED_SCHEMA: ['settings-version-unsupported', 'reset-settings'],
    BUSY: ['operation-busy', 'wait-and-retry'],
    HOST_ABI_MISSING: ['host-api-missing', 'check-host-version'],
    HOST_EXPORT_MISSING: ['host-export-missing', 'check-host-version'],
    CHAT_JUMP_FAILED: ['host-jump-failed', 'reload-and-retry'],
};
const FAILURE_STAGES = {
    INVALID_SNAPSHOT: 'chat.projection', INVALID_SCHEMA: 'settings.validation', UNSUPPORTED_SCHEMA: 'settings.validation',
    EXPORT_SELECTION_EMPTY: 'export.selection', EXPORT_RESULT_EMPTY: 'export.transform', NO_ACTIVE_RULES: 'export.rules',
    EXPORT_CONFIRM_REQUIRED: 'export.confirmation', MESSAGE_CHANGED: 'chat.target-validation', CHAT_CHANGED: 'chat.identity-validation',
};
const ERROR_KINDS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AbortError', 'NotAllowedError', 'NotFoundError', 'NetworkError', 'SecurityError', 'InvalidStateError', 'NoModificationAllowedError', 'DataCloneError']);
const TYPES = new Set(['undefined', 'null', 'array', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol', 'function']);
const CONSTRAINTS = new Set(['record', 'string', 'nonempty-string', 'array', 'boolean', 'exact-keys', 'schema-version-1', 'nonempty-unique-id', 'paired-markers', 'nonempty-markers', 'supported-value']);
const SOURCES = new Set(['kernel/chat-projection.js:projectConversationSnapshot', 'chat-exporter/schema.js', 'chat-exporter/model.js', 'chat-viewer/model.js', 'chat-exporter/runtime.js', 'chat-viewer/runtime.js']);

// Only explicitly typed diagnostic fields enter redacted logs; never copy message/context wholesale.
export function chatFailureData(operation, error, sourceLocation) {
    const known = error instanceof ToolkitError && Object.hasOwn(FAILURE_REASONS, error.code);
    const [reason, nextAction] = known ? FAILURE_REASONS[error.code] : ['unexpected-readonly-failure', 'retry-or-report'];
    const kind = error instanceof ToolkitError ? { kind: 'ToolkitError', code: known ? error.code : 'UNKNOWN_TOOLKIT_ERROR' }
        : { kind: error instanceof Error ? (ERROR_KINDS.has(error.name) ? error.name : 'Error') : typeof error };
    const data = { operation, stage: known ? (FAILURE_STAGES[error.code] ?? operation) : operation, ...kind, reason, outcome: 'blocked', nextAction };
    if (SOURCES.has(sourceLocation))
        data.sourceLocation = sourceLocation;
    if (!(error instanceof ToolkitError))
        return data;
    const context = error.context ?? {};
    for (const key of ['absoluteIndex', 'conversationIndex', 'start', 'end', 'totalMessages', 'ruleIndex', 'expectedCount', 'actualCount', 'skippedMessages', 'warningCount']) {
        if (Number.isSafeInteger(context[key]))
            data[key] = context[key];
    }
    if (['include-no-match', 'empty', 'unreadable'].includes(context.skipReason))
        data.skipReason = context.skipReason;
    if (TYPES.has(context.actualType))
        data.actualType = context.actualType;
    if (CONSTRAINTS.has(context.expected))
        data.expected = context.expected;
    if (SOURCES.has(context.sourceLocation))
        data.sourceLocation = context.sourceLocation;
    if (typeof context.field === 'string' && /^(identity(?:\.stableId)?|messages|mes|range|query|preview|target|settings(?:\.(?:schemaVersion|format|roleFilter|anonymous|assistant|user|strategy|includeRules|excludeRules|id|enabled|start|end)|\[\d+\])*)$/.test(context.field))
        data.field = context.field;
    return data;
}

export function logChatFailure(log, event, operation, error, sourceLocation) {
    log.warn(event, { data: chatFailureData(operation, error, sourceLocation), sensitive: { error } });
}

export function logChatProjectionIssues(log, model, operation, chatAlias) {
    for (const issue of model.issues) {
        const { message, ...diagnostic } = issue;
        log.warn('message.degraded', { data: { operation, stage: 'chat.projection', chatAlias, ...diagnostic } });
    }
}
