import { ToolkitError } from './errors.js';

const SETTINGS_KEY = 'llm-presets-v1';

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是对象。`);
    return value;
}

function exactKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length)
        throw new ToolkitError('INVALID_SCHEMA', `${label} 包含未知字段：${unknown.join(', ')}`);
}

function normalizeUrl(value) {
    const text = String(value ?? '').trim().replace(/\/+$/, '');
    let url;
    try {
        url = new URL(text);
    }
    catch {
        throw new ToolkitError('INVALID_SCHEMA', '模型 API URL 无效。');
    }
    if (!['http:', 'https:'].includes(url.protocol))
        throw new ToolkitError('INVALID_SCHEMA', '模型 API URL 只支持 http 或 https。');
    return text;
}

export function createDefaultLlmPresetSettings() {
    return { schemaVersion: 1, activePresetId: null, presets: [] };
}

export function parseLlmPresetSettings(value) {
    if (value === undefined || value === null)
        return createDefaultLlmPresetSettings();
    const raw = object(value, '模型预设设置');
    exactKeys(raw, ['schemaVersion', 'activePresetId', 'presets'], '模型预设设置');
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的模型预设版本：${String(raw.schemaVersion)}`);
    if (raw.activePresetId !== null && typeof raw.activePresetId !== 'string')
        throw new ToolkitError('INVALID_SCHEMA', 'activePresetId 必须是字符串或 null。');
    if (!Array.isArray(raw.presets))
        throw new ToolkitError('INVALID_SCHEMA', 'presets 必须是数组。');
    const ids = new Set();
    const presets = raw.presets.map((value, index) => {
        const preset = object(value, `模型预设 ${index + 1}`);
        exactKeys(preset, ['id', 'name', 'apiUrl', 'model', 'apiKey'], `模型预设 ${index + 1}`);
        const id = String(preset.id ?? '').trim();
        const name = String(preset.name ?? '').trim();
        const model = String(preset.model ?? '').trim();
        if (!id || !name || !model || typeof preset.apiKey !== 'string')
            throw new ToolkitError('INVALID_SCHEMA', `模型预设 ${index + 1} 缺少必要字段。`);
        if (ids.has(id))
            throw new ToolkitError('INVALID_SCHEMA', `模型预设 ID 重复：${id}`);
        ids.add(id);
        return { id, name, apiUrl: normalizeUrl(preset.apiUrl), model, apiKey: preset.apiKey };
    });
    const activePresetId = raw.activePresetId;
    if (activePresetId !== null && !ids.has(activePresetId))
        throw new ToolkitError('INVALID_SCHEMA', '当前模型预设不存在。');
    return { schemaVersion: 1, activePresetId, presets };
}

export function resolveChatCompletionsUrl(apiUrl) {
    return `${resolveOpenAiCompatibleBaseUrl(apiUrl)}/chat/completions`;
}

export function resolveModelsUrl(apiUrl) {
    return `${resolveOpenAiCompatibleBaseUrl(apiUrl)}/models`;
}

export function resolveOpenAiCompatibleBaseUrl(apiUrl) {
    return normalizeUrl(apiUrl).replace(/\/(?:chat\/completions|models)$/i, '');
}

export class LlmPresetStore {
    constructor(host) {
        this.host = host;
        this.settings = createDefaultLlmPresetSettings();
    }

    async load() {
        this.settings = parseLlmPresetSettings(await this.host.globalGet(SETTINGS_KEY));
        return structuredClone(this.settings);
    }

    async save(value) {
        const settings = parseLlmPresetSettings(value);
        await this.host.globalSet(SETTINGS_KEY, settings);
        this.settings = settings;
        return structuredClone(settings);
    }

    async active() {
        const settings = await this.load();
        const preset = settings.presets.find(item => item.id === settings.activePresetId);
        if (!preset)
            throw new ToolkitError('LLM_PRESET_MISSING', '尚未选择可用的模型预设。');
        return preset;
    }

    async byId(presetId) {
        const id = String(presetId ?? '').trim();
        if (!id)
            throw new ToolkitError('LLM_PRESET_MISSING', '尚未选择可用的模型预设。');
        const settings = await this.load();
        const preset = settings.presets.find(item => item.id === id);
        if (!preset)
            throw new ToolkitError('LLM_PRESET_MISSING', '模型预设不存在或尚未保存。');
        return preset;
    }
}
