import { ToolkitError } from './errors.js';

const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'NotAllowedError', 'NotFoundError', 'NetworkError', 'SecurityError', 'InvalidStateError']);
export function fileExportErrorKind(error) {
    return ERROR_NAMES.has(error?.name) ? error.name : 'Error';
}

// download(..., { throwOnFailure: true }) returns delivery/cancellation, not platform paths.
export function fileExportResult(result) {
    if (typeof result?.delivered === 'boolean')
        return result.delivered
            ? { status: 'saved', mode: 'host-download', message: '导出成功，宿主已完成文件导出。' }
            : { status: 'cancelled', mode: 'host-download', message: '已取消导出。' };
    throw new ToolkitError('FILE_EXPORT_RESULT_INVALID', '宿主导出结果无法确认，请检查目标位置后再重试，避免重复导出。', {
        stage: 'export.result', reason: 'host-export-result-invalid',
    });
}

const FAILURE_CODES = {
    FILE_EXPORT_INPUT_INVALID: ['export.validation', 'file-export-input-invalid'],
    FILE_EXPORT_UNAVAILABLE: ['export.capability', 'host-export-unavailable'],
    FILE_EXPORT_FAILED: ['export.write', 'host-export-rejected'],
    FILE_EXPORT_ABORTED: ['export.write', 'host-export-aborted'],
    FILE_EXPORT_RESULT_INVALID: ['export.result', 'host-export-result-invalid'],
};
export function logFileExportFailure(log, event, operation, error, sourceLocation) {
    const known = error instanceof ToolkitError && Object.hasOwn(FAILURE_CODES, error.code);
    const [stage, reason] = known ? FAILURE_CODES[error.code] : [operation, 'file-operation-rejected'];
    log?.warn?.(event, { data: {
        operation,
        stage,
        kind: known ? 'ToolkitError' : fileExportErrorKind(error),
        ...(known ? { code: error.code } : {}),
        ...(known && ERROR_NAMES.has(error.context?.kind) ? { hostErrorKind: error.context.kind } : {}),
        ...(error?.code === 'FILE_EXPORT_INPUT_INVALID'
            && ['content', 'filename', 'mimeType'].includes(error.context?.field)
            && ['string', 'nonempty-string'].includes(error.context?.expected)
            && ['undefined', 'null', 'array', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol', 'function'].includes(error.context?.actualType)
            ? { field: error.context.field, expected: error.context.expected, actualType: error.context.actualType } : {}),
        reason,
        sourceLocation,
        outcome: 'not-confirmed',
        nextAction: 'inspect-destination-and-retry',
    } });
}
