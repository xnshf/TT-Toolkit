import { ToolkitError } from '../../kernel/errors.js';

export const PROMPT_VIEWER_SCHEMA_VERSION = 1;

export function createDefaultPromptViewerSettings() {
    return {
        schemaVersion: PROMPT_VIEWER_SCHEMA_VERSION,
        defaultCollapsed: true,
    };
}

export function parsePromptViewerSettings(value) {
    if (value === undefined || value === null)
        return createDefaultPromptViewerSettings();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '提示词查看设置必须是对象。');
    const candidate = value;
    if (candidate.schemaVersion !== PROMPT_VIEWER_SCHEMA_VERSION)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的提示词查看设置版本：${String(candidate.schemaVersion)}`);
    if (typeof candidate.defaultCollapsed !== 'boolean')
        throw new ToolkitError('INVALID_SCHEMA', 'defaultCollapsed 必须是布尔值。');
    return {
        schemaVersion: PROMPT_VIEWER_SCHEMA_VERSION,
        defaultCollapsed: candidate.defaultCollapsed,
    };
}

export const PROMPT_SNAPSHOT_KINDS = Object.freeze(['sent', 'prediction']);
export const PROMPT_GENERATION_TYPES = Object.freeze(['normal', 'regenerate', 'swipe', 'continue']);

export function assertPromptSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '提示词快照必须是对象。');
    const candidate = value;
    if (candidate.schemaVersion !== PROMPT_VIEWER_SCHEMA_VERSION)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', '提示词快照版本不受支持。');
    if (!PROMPT_SNAPSHOT_KINDS.includes(candidate.kind))
        throw new ToolkitError('INVALID_SCHEMA', '提示词快照类型非法。');
    if (!PROMPT_GENERATION_TYPES.includes(candidate.generationType))
        throw new ToolkitError('INVALID_SCHEMA', '提示词快照生成类型非法。');
    if (!Array.isArray(candidate.items))
        throw new ToolkitError('INVALID_SCHEMA', '提示词快照缺少 items 数组。');
    if (!Array.isArray(candidate.worldEntries))
        throw new ToolkitError('INVALID_SCHEMA', '提示词快照缺少 worldEntries 数组。');
    if (typeof candidate.tokenTotal !== 'number' || !Number.isFinite(candidate.tokenTotal))
        throw new ToolkitError('INVALID_SCHEMA', '提示词快照缺少 token 总计。');
    return value;
}
