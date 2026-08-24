import { ToolkitError } from '../../kernel/errors.js';

const SETTINGS_KEYS = ['schemaVersion', 'format', 'anonymous', 'roleFilter', 'assistant', 'user'];
const ROLE_KEYS = ['strategy', 'includeRules', 'excludeRules'];
const RULE_KEYS = ['id', 'enabled', 'start', 'end'];
const FORMATS = new Set(['markdown', 'text']);
const ROLE_FILTERS = new Set(['all', 'assistant', 'user']);
const STRATEGIES = new Set(['none', 'include', 'exclude']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 包含缺失或未知字段`, { actual, expected: wanted });
}

function parseRules(value, kind, label) {
    if (!Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是数组`);
    const ids = new Set();
    return value.map((candidate, index) => {
        if (!isRecord(candidate))
            throw new ToolkitError('INVALID_SCHEMA', `${label}[${index}] 必须是对象`);
        exactKeys(candidate, RULE_KEYS, `${label}[${index}]`);
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        if (!id || ids.has(id))
            throw new ToolkitError('INVALID_SCHEMA', `${label} 包含空或重复规则 ID`, { id });
        ids.add(id);
        if (typeof candidate.enabled !== 'boolean' || typeof candidate.start !== 'string' || typeof candidate.end !== 'string')
            throw new ToolkitError('INVALID_SCHEMA', `${label}[${index}] 的字段类型无效`);
        if (kind === 'include' && (!candidate.start || !candidate.end))
            throw new ToolkitError('INVALID_SCHEMA', `${label}[${index}] 的正选标记必须成对填写`);
        if (kind === 'exclude' && !candidate.start && !candidate.end)
            throw new ToolkitError('INVALID_SCHEMA', `${label}[${index}] 的反选标记不能同时为空`);
        return { id, enabled: candidate.enabled, start: candidate.start, end: candidate.end };
    });
}

function parseRole(value, label) {
    if (!isRecord(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是对象`);
    exactKeys(value, ROLE_KEYS, label);
    if (!STRATEGIES.has(value.strategy))
        throw new ToolkitError('INVALID_SCHEMA', `${label}.strategy 无效`);
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
        throw new ToolkitError('INVALID_SCHEMA', '聊天导出配置必须是对象');
    if (value.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的聊天导出配置版本：${String(value.schemaVersion)}`);
    exactKeys(value, SETTINGS_KEYS, '聊天导出配置');
    if (!FORMATS.has(value.format) || !ROLE_FILTERS.has(value.roleFilter) || typeof value.anonymous !== 'boolean')
        throw new ToolkitError('INVALID_SCHEMA', '聊天导出的格式、角色过滤或匿名化设置无效');
    return {
        schemaVersion: 1,
        format: value.format,
        anonymous: value.anonymous,
        roleFilter: value.roleFilter,
        assistant: parseRole(value.assistant, 'assistant'),
        user: parseRole(value.user, 'user'),
    };
}

export const exportSettingValues = {
    formats: Object.freeze([...FORMATS]),
    roleFilters: Object.freeze([...ROLE_FILTERS]),
    strategies: Object.freeze([...STRATEGIES]),
};
