import { ToolkitError } from '../../kernel/errors.js';
import { detectPromptTemplateEntry } from '../../kernel/dynamic-template.js';
export { detectPromptTemplateEntry } from '../../kernel/dynamic-template.js';

export const WORLD_INFO_EXTENSION_KEY = 'tt-toolkit';
export const WORLD_INFO_ROUTER_FIELD = 'worldInfoAiRouter';
export const FEATURE_SETTINGS_KEY = 'world-info-ai-settings-v1';

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是对象。`);
    return value;
}
function keys(value, allowed, label) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 包含未知字段。`);
}
export function validateThreshold(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
        throw new ToolkitError('INVALID_SCHEMA', '阈值必须是 0 到 1 之间的有限数值。');
    return value;
}
export function createDefaultWorldInfoAiConfig() {
    return { schemaVersion: 2, enabled: false, entries: {} };
}
export function parseWorldInfoAiConfig(value) {
    if (value === undefined) return createDefaultWorldInfoAiConfig();
    const raw = object(value, '世界书决策配置');
    keys(raw, ['schemaVersion', 'enabled', 'entries'], '世界书决策配置');
    if (![1, 2].includes(raw.schemaVersion))
        throw new ToolkitError('UNSUPPORTED_SCHEMA', '世界书决策配置版本不受支持，请显式重置。');
    if (typeof raw.enabled !== 'boolean')
        throw new ToolkitError('INVALID_SCHEMA', '世界书接管开关必须是布尔值。');
    const entries = Object.create(null);
    for (const [uid, item] of Object.entries(object(raw.entries, '条目配置'))) {
        const entry = object(item, '条目配置');
        keys(entry, raw.schemaVersion === 1 ? ['mode', 'aiDescription'] : ['mode', 'aiDescription', 'threshold'], '条目配置');
        if (!['native', 'ai'].includes(entry.mode) || typeof entry.aiDescription !== 'string')
            throw new ToolkitError('INVALID_SCHEMA', '条目模式或条件类型无效。');
        const aiDescription = entry.aiDescription.trim();
        if (entry.mode === 'ai' && !aiDescription)
            throw new ToolkitError('INVALID_SCHEMA', '接管条件不能为空。');
        const threshold = raw.schemaVersion === 1 ? null : entry.threshold;
        if (threshold !== null) validateThreshold(threshold);
        entries[uid] = { mode: entry.mode, aiDescription, threshold };
    }
    // Known v1 descriptions become conditions; no native world-info fields are changed.
    return { schemaVersion: 2, enabled: raw.enabled, entries };
}
export function readEmbeddedWorldInfoAiConfig(data) {
    const extensions = data?.extensions;
    if (extensions === undefined) return undefined;
    const toolkit = object(extensions, '世界书扩展')[WORLD_INFO_EXTENSION_KEY];
    if (toolkit === undefined) return undefined;
    return object(toolkit, '工具箱世界书扩展')[WORLD_INFO_ROUTER_FIELD];
}
export function embedWorldInfoAiConfig(worldData, config) {
    const data = structuredClone(object(worldData, '世界书数据'));
    const extensions = data.extensions === undefined ? {} : object(data.extensions, '世界书扩展');
    const toolkit = extensions[WORLD_INFO_EXTENSION_KEY] === undefined ? {} : object(extensions[WORLD_INFO_EXTENSION_KEY], '工具箱世界书扩展');
    data.extensions = { ...extensions, [WORLD_INFO_EXTENSION_KEY]: { ...toolkit, [WORLD_INFO_ROUTER_FIELD]: parseWorldInfoAiConfig(config) } };
    return data;
}
export function worldEntryKey(world, uid) {
    return JSON.stringify([world, uid]);
}
export function worldInfoTriggerType(entry) {
    return entry?.constant === true ? 'constant' : entry?.vectorized === true || entry?.extensions?.vectorized === true ? 'vectorized' : 'keyword';
}
export function isAiModeEligible(entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
        && (typeof entry.uid === 'string' || Number.isSafeInteger(entry.uid))
        && typeof entry.content === 'string'
        && !detectPromptTemplateEntry(entry).detected
        && !/^[ \t]*@@dont_activate\b/mu.test(entry.content));
}
export function createDefaultWorldInfoAiFeatureSettings() {
    return { schemaVersion: 2, presetId: null, threshold: 0.7, historyRounds: 3, timeoutMs: 10000 };
}
export function parseWorldInfoAiFeatureSettings(value) {
    if (value === undefined) return createDefaultWorldInfoAiFeatureSettings();
    const raw = object(value, '决策激活设置');
    keys(raw, raw.schemaVersion === 1 ? ['schemaVersion', 'presetId'] : ['schemaVersion', 'presetId', 'threshold', 'historyRounds', 'timeoutMs'], '决策激活设置');
    if (![1, 2].includes(raw.schemaVersion))
        throw new ToolkitError('UNSUPPORTED_SCHEMA', '决策激活设置版本不受支持，请显式重置。');
    if (raw.presetId !== null && (typeof raw.presetId !== 'string' || !raw.presetId.trim()))
        throw new ToolkitError('INVALID_SCHEMA', '模型预设 ID 必须是非空字符串或 null。');
    const parsed = raw.schemaVersion === 1 ? { ...createDefaultWorldInfoAiFeatureSettings(), presetId: raw.presetId } : raw;
    validateThreshold(parsed.threshold);
    if (!Number.isSafeInteger(parsed.historyRounds) || parsed.historyRounds < 1 || parsed.historyRounds > 100
        || !Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1000 || parsed.timeoutMs > 120000)
        throw new ToolkitError('INVALID_SCHEMA', '最近轮数须为 1–100，超时须为 1000–120000 毫秒。');
    return { schemaVersion: 2, presetId: parsed.presetId, threshold: parsed.threshold, historyRounds: parsed.historyRounds, timeoutMs: parsed.timeoutMs };
}

export function parseConfigExchange(text) {
    let value;
    try { value = JSON.parse(text); }
    catch { throw new ToolkitError('INVALID_SCHEMA', '配置文件不是合法 JSON。'); }
    const raw = object(value, '导入配置');
    keys(raw, ['format', 'config'], '导入配置');
    if (raw.format !== 'tt-toolkit.world-info-decision.v1')
        throw new ToolkitError('UNSUPPORTED_SCHEMA', '不是工具箱决策激活配置文件。');
    return parseWorldInfoAiConfig(raw.config);
}
export function serializeConfigExchange(config) {
    return JSON.stringify({ format: 'tt-toolkit.world-info-decision.v1', config: parseWorldInfoAiConfig(config) }, null, 2);
}
