import { ToolkitError } from '../../kernel/errors.js';
const SETTINGS_KEYS = ['schemaVersion', 'deleteNativeReasoning', 'assistant', 'user', 'auto'];
const GROUP_KEYS = ['enabled', 'rules'];
const RULE_KEYS = ['id', 'enabled', 'start', 'end'];
const AUTO_KEYS = ['enabled', 'keepAssistant', 'keepUser'];
const PROGRESS_KEYS = [
    'schemaVersion', 'stableChatId', 'assistantThrough', 'userThrough', 'rulesFingerprint',
    'lastSuccessfulAt',
];
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new ToolkitError('INVALID_SCHEMA', `${label} 包含缺失或未知字段`, { actual, expected: wanted });
    }
}
function boolean(value, label) {
    if (typeof value !== 'boolean')
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是布尔值`);
    return value;
}
function integer(value, label, minimum) {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是大于等于 ${minimum} 的安全整数`);
    }
    return Number(value);
}
function string(value, label) {
    if (typeof value !== 'string')
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是字符串`);
    return value;
}
function parseRules(value, label) {
    if (!Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是数组`);
    const ids = new Set();
    return value.map((candidate, index) => {
        if (!isRecord(candidate))
            throw new ToolkitError('INVALID_SCHEMA', `${label}[${index}] 必须是对象`);
        exactKeys(candidate, RULE_KEYS, `${label}[${index}]`);
        const id = string(candidate.id, `${label}[${index}].id`).trim();
        if (!id || ids.has(id))
            throw new ToolkitError('INVALID_SCHEMA', `${label} 包含空或重复规则 ID`, { id });
        ids.add(id);
        const start = string(candidate.start, `${label}[${index}].start`);
        const end = string(candidate.end, `${label}[${index}].end`);
        if (!start && !end)
            throw new ToolkitError('INVALID_SCHEMA', `${label}[${index}] 的开始和结束标记不能同时为空`);
        return { id, enabled: boolean(candidate.enabled, `${label}[${index}].enabled`), start, end };
    });
}
function parseGroup(value, label) {
    if (!isRecord(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是对象`);
    exactKeys(value, GROUP_KEYS, label);
    return { enabled: boolean(value.enabled, `${label}.enabled`), rules: parseRules(value.rules, `${label}.rules`) };
}
export function createDefaultSettings() {
    return {
        schemaVersion: 1,
        deleteNativeReasoning: true,
        assistant: { enabled: true, rules: [] },
        user: { enabled: false, rules: [] },
        auto: { enabled: false, keepAssistant: 5, keepUser: 5 },
    };
}
export function parseSettings(value) {
    if (value === undefined || value === null)
        return createDefaultSettings();
    if (!isRecord(value))
        throw new ToolkitError('INVALID_SCHEMA', '聊天清洗配置必须是对象');
    if (value.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的聊天清洗配置版本：${String(value.schemaVersion)}`);
    exactKeys(value, SETTINGS_KEYS, '聊天清洗配置');
    if (!isRecord(value.auto))
        throw new ToolkitError('INVALID_SCHEMA', 'auto 必须是对象');
    exactKeys(value.auto, AUTO_KEYS, 'auto');
    return {
        schemaVersion: 1,
        deleteNativeReasoning: boolean(value.deleteNativeReasoning, 'deleteNativeReasoning'),
        assistant: parseGroup(value.assistant, 'assistant'),
        user: parseGroup(value.user, 'user'),
        auto: {
            enabled: boolean(value.auto.enabled, 'auto.enabled'),
            keepAssistant: integer(value.auto.keepAssistant, 'auto.keepAssistant', 1),
            keepUser: integer(value.auto.keepUser, 'auto.keepUser', 1),
        },
    };
}
export function createDefaultProgress() {
    return {
        schemaVersion: 2,
        stableChatId: null,
        assistantThrough: -1,
        userThrough: -1,
        rulesFingerprint: '',
        lastSuccessfulAt: null,
    };
}
export function parseProgress(value) {
    if (value === undefined || value === null)
        return createDefaultProgress();
    if (!isRecord(value))
        throw new ToolkitError('INVALID_PROGRESS', '聊天清洗进度必须是对象');
    if (value.schemaVersion !== 2)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的聊天清洗进度版本：${String(value.schemaVersion)}`);
    exactKeys(value, PROGRESS_KEYS, '聊天清洗进度');
    if (value.stableChatId !== null && typeof value.stableChatId !== 'string')
        throw new ToolkitError('INVALID_PROGRESS', 'stableChatId 必须是字符串或 null');
    if (value.lastSuccessfulAt !== null && typeof value.lastSuccessfulAt !== 'string')
        throw new ToolkitError('INVALID_PROGRESS', 'lastSuccessfulAt 必须是字符串或 null');
    if (typeof value.rulesFingerprint !== 'string')
        throw new ToolkitError('INVALID_PROGRESS', 'rulesFingerprint 必须是字符串');
    return {
        schemaVersion: 2,
        stableChatId: value.stableChatId,
        assistantThrough: integer(value.assistantThrough, 'assistantThrough', -1),
        userThrough: integer(value.userThrough, 'userThrough', -1),
        rulesFingerprint: value.rulesFingerprint,
        lastSuccessfulAt: value.lastSuccessfulAt,
    };
}
