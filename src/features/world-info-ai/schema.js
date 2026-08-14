import { ToolkitError } from '../../kernel/errors.js';

export const WORLD_INFO_EXTENSION_KEY = 'tt-toolkit';
export const WORLD_INFO_ROUTER_FIELD = 'worldInfoAiRouter';

const PROMPT_TEMPLATE_DECORATORS = new Set([
    '@@message_formatting', '@@generate_before', '@@generate_after',
    '@@render_before', '@@render_after', '@@dont_preload',
    '@@initial_variables', '@@always_enabled', '@@only_preload',
    '@@iframe', '@@preprocessing', '@@if', '@@private',
]);

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

function leadingDecorators(content) {
    const output = [];
    for (const line of String(content ?? '').split(/\r?\n/)) {
        if (!line.startsWith('@@') || line.startsWith('@@@'))
            break;
        output.push(line.split(/\s+/, 1)[0].toLowerCase());
    }
    return output;
}

export function detectPromptTemplateEntry(entry) {
    const content = String(entry?.content ?? '');
    const comment = String(entry?.comment ?? '');
    const reasons = [];
    if (content.includes('<%') || content.includes('%>') || /<#\/?escape-ejs>/i.test(content))
        reasons.push('EJS 语法');
    if (/\[GENERATE:|\[RENDER:|@INJECT|\[InitialVariables\]|\[Preprocessing\]/i.test(comment))
        reasons.push('Prompt Template 专用标题');
    const decorators = leadingDecorators(content).filter(value => PROMPT_TEMPLATE_DECORATORS.has(value));
    if (decorators.length)
        reasons.push(`Prompt Template 装饰器 ${decorators.join('、')}`);
    return { detected: reasons.length > 0, reasons };
}

export function worldEntryKey(world, uid) {
    return `${String(world)}.${String(uid)}`;
}
