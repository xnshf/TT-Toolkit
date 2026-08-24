import { ToolkitError } from '../../kernel/errors.js';
import { detectPromptTemplateEntry } from '../../kernel/dynamic-template.js';

export { detectPromptTemplateEntry } from '../../kernel/dynamic-template.js';

export const WORLD_INFO_EXTENSION_KEY = 'tt-toolkit';
export const WORLD_INFO_ROUTER_FIELD = 'worldInfoAiRouter';

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是对象。`);
    return value;
}

function exactKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length)
        throw new ToolkitError('INVALID_SCHEMA', `${label} 包含未知字段：${unknown.join(', ')}`);
}

export function createDefaultWorldInfoAiConfig() {
    return { schemaVersion: 1, enabled: false, entries: {} };
}

export function parseWorldInfoAiConfig(value) {
    if (value === undefined || value === null)
        return createDefaultWorldInfoAiConfig();
    const raw = plainObject(value, '世界书 AI 配置');
    exactKeys(raw, ['schemaVersion', 'enabled', 'entries'], '世界书 AI 配置');
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的世界书 AI 配置版本：${String(raw.schemaVersion)}`);
    if (typeof raw.enabled !== 'boolean')
        throw new ToolkitError('INVALID_SCHEMA', '世界书 AI 总开关必须是布尔值。');
    const entries = plainObject(raw.entries, '世界书条目配置');
    const parsedEntries = {};
    for (const [uid, value] of Object.entries(entries)) {
        const entry = plainObject(value, `条目 ${uid} 配置`);
        exactKeys(entry, ['mode', 'aiDescription'], `条目 ${uid} 配置`);
        if (!['native', 'ai'].includes(entry.mode))
            throw new ToolkitError('INVALID_SCHEMA', `条目 ${uid} 模式无效。`);
        if (typeof entry.aiDescription !== 'string')
            throw new ToolkitError('INVALID_SCHEMA', `条目 ${uid} 的 AI 描述必须是字符串。`);
        const aiDescription = entry.aiDescription.trim();
        if (entry.mode === 'ai' && !aiDescription)
            throw new ToolkitError('INVALID_SCHEMA', `条目 ${uid} 的 AI 描述不能为空。`);
        parsedEntries[String(uid)] = { mode: entry.mode, aiDescription };
    }
    return { schemaVersion: 1, enabled: raw.enabled, entries: parsedEntries };
}

export function readEmbeddedWorldInfoAiConfig(worldData) {
    const extensions = worldData?.extensions;
    if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions))
        return undefined;
    const toolkit = extensions[WORLD_INFO_EXTENSION_KEY];
    if (!toolkit || typeof toolkit !== 'object' || Array.isArray(toolkit))
        return undefined;
    return toolkit[WORLD_INFO_ROUTER_FIELD];
}

export function embedWorldInfoAiConfig(worldData, config) {
    const data = structuredClone(plainObject(worldData, '世界书数据'));
    const extensions = data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions)
        ? data.extensions
        : {};
    const existing = extensions[WORLD_INFO_EXTENSION_KEY];
    const toolkit = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {};
    data.extensions = {
        ...extensions,
        [WORLD_INFO_EXTENSION_KEY]: {
            ...toolkit,
            [WORLD_INFO_ROUTER_FIELD]: structuredClone(parseWorldInfoAiConfig(config)),
        },
    };
    return data;
}

export function worldEntryKey(world, uid) {
    return `${String(world)}.${String(uid)}`;
}

export function worldInfoTriggerType(entry) {
    if (entry?.constant === true)
        return 'constant';
    if (entry?.vectorized === true || entry?.extensions?.vectorized === true)
        return 'vectorized';
    return 'keyword';
}

export function isAiModeEligible(entry) {
    return worldInfoTriggerType(entry) === 'keyword' && !detectPromptTemplateEntry(entry).detected;
}

export function createDefaultWorldInfoAiFeatureSettings() {
    return { schemaVersion: 1, presetId: null };
}

export function parseWorldInfoAiFeatureSettings(value) {
    if (value === undefined || value === null)
        return createDefaultWorldInfoAiFeatureSettings();
    const raw = plainObject(value, '世界书 AI 功能设置');
    exactKeys(raw, ['schemaVersion', 'presetId'], '世界书 AI 功能设置');
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的世界书 AI 功能设置版本：${String(raw.schemaVersion)}`);
    if (raw.presetId !== null && typeof raw.presetId !== 'string')
        throw new ToolkitError('INVALID_SCHEMA', '世界书 AI 功能设置的 presetId 必须是字符串或 null。');
    return { schemaVersion: 1, presetId: raw.presetId };
}
