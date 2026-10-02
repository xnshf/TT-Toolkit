import { ToolkitError } from '../../kernel/errors.js';
import { valueType } from '../../kernel/chat-diagnostics.js';

const SETTINGS_KEYS = ['schemaVersion', 'format', 'anonymous', 'roleFilter', 'assistant', 'user'];
const ROLE_KEYS = ['strategy', 'includeRules', 'excludeRules'];
const RULE_KEYS = ['id', 'enabled', 'start', 'end'];
const FORMATS = new Set(['markdown', 'text']);
const ROLE_FILTERS = new Set(['all', 'assistant', 'user']);
const STRATEGIES = new Set(['none', 'include', 'exclude']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message, field, expected, value, extra = {}, code = 'INVALID_SCHEMA') {
    throw new ToolkitError(code, message, {
        field, expected, actualType: valueType(value), sourceLocation: 'chat-exporter/schema.js', ...extra,
    });
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        invalid(`${label} 包含缺失或未知字段`, label, 'exact-keys', value, { actualCount: actual.length, expectedCount: wanted.length });
}

function parseRules(value, kind, label) {
    if (!Array.isArray(value))
        invalid(`${label} 必须是数组`, label, 'array', value);
    const ids = new Set();
    return value.map((candidate, index) => {
        if (!isRecord(candidate))
            invalid(`${label}[${index}] 必须是对象`, `${label}[${index}]`, 'record', candidate, { ruleIndex: index });
        exactKeys(candidate, RULE_KEYS, `${label}[${index}]`);
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        if (!id || ids.has(id))
            invalid(`${label} 包含空或重复规则 ID`, `${label}[${index}].id`, 'nonempty-unique-id', candidate.id, { ruleIndex: index });
        ids.add(id);
        for (const [field, type] of [['enabled', 'boolean'], ['start', 'string'], ['end', 'string']]) {
            if (typeof candidate[field] !== type)
                invalid(`${label}[${index}].${field} 的字段类型无效`, `${label}[${index}].${field}`, type, candidate[field], { ruleIndex: index });
        }
        if (kind === 'include' && (!candidate.start || !candidate.end))
            invalid(`${label}[${index}] 的正选标记必须成对填写`, `${label}[${index}]`, 'paired-markers', candidate, { ruleIndex: index });
        if (kind === 'exclude' && !candidate.start && !candidate.end)
            invalid(`${label}[${index}] 的反选标记不能同时为空`, `${label}[${index}]`, 'nonempty-markers', candidate, { ruleIndex: index });
        return { id, enabled: candidate.enabled, start: candidate.start, end: candidate.end };
    });
}

function parseRole(value, label) {
    if (!isRecord(value))
        invalid(`${label} 必须是对象`, label, 'record', value);
    exactKeys(value, ROLE_KEYS, label);
    if (!STRATEGIES.has(value.strategy))
        invalid(`${label}.strategy 无效`, `${label}.strategy`, 'supported-value', value.strategy);
    return {
        strategy: value.strategy,
        includeRules: parseRules(value.includeRules, 'include', `${label}.includeRules`),
        excludeRules: parseRules(value.excludeRules, 'exclude', `${label}.excludeRules`),
    };
}

function defaultRole() {
    return { strategy: 'none', includeRules: [], excludeRules: [] };
}

export function createDefaultExportSettings() {
    return {
        schemaVersion: 1,
        format: 'markdown',
        anonymous: false,
        roleFilter: 'all',
        assistant: defaultRole(),
        user: defaultRole(),
    };
}

export function parseExportSettings(value) {
    if (value === undefined || value === null)
        return createDefaultExportSettings();
    if (!isRecord(value))
        invalid('聊天导出配置必须是对象', 'settings', 'record', value);
    if (value.schemaVersion !== 1)
        invalid('不支持的聊天导出配置版本，请重置配置。', 'settings.schemaVersion', 'schema-version-1', value.schemaVersion, {}, 'UNSUPPORTED_SCHEMA');
    exactKeys(value, SETTINGS_KEYS, 'settings');
    for (const [field, allowed] of [['format', FORMATS], ['roleFilter', ROLE_FILTERS]]) {
        if (!allowed.has(value[field]))
            invalid(`聊天导出的 ${field} 设置无效`, `settings.${field}`, 'supported-value', value[field]);
    }
    if (typeof value.anonymous !== 'boolean')
        invalid('聊天导出的匿名化设置必须是布尔值', 'settings.anonymous', 'boolean', value.anonymous);
    return {
        schemaVersion: 1,
        format: value.format,
        anonymous: value.anonymous,
        roleFilter: value.roleFilter,
        assistant: parseRole(value.assistant, 'settings.assistant'),
        user: parseRole(value.user, 'settings.user'),
    };
}

export const exportSettingValues = {
    formats: Object.freeze([...FORMATS]),
    roleFilters: Object.freeze([...ROLE_FILTERS]),
    strategies: Object.freeze([...STRATEGIES]),
};
