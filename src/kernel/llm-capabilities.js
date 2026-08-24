import { ToolkitError } from './errors.js';
import { resolveOpenAiCompatibleBaseUrl } from './llm-presets.js';

export const CAPABILITIES_KEY = 'llm-preset-json-capabilities-v1';
export const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROBE_ATTEMPT_TIMEOUT_MS = 15_000;
export const CAPABILITY_FORMATS = ['strict', 'json_object', 'plain'];

export function errorMessageOf(value) {
    if (value instanceof Error)
        return value.message;
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object') {
        if (typeof value.message === 'string')
            return value.message;
        try {
            const serialized = JSON.stringify(value);
            if (serialized)
                return serialized;
        }
        catch {
            // fall through to String()
        }
    }
    return String(value ?? '');
}

export function providerRejectionKind(error) {
    const message = errorMessageOf(error);
    if (/response_format|json_schema|structured\s*output/i.test(message)
        && (/invalid_request_error|bad request|\b400\b|unsupported|unavailable|not\s*support|not\s*available/i.test(message)
            || /must contain the word.{0,16}json/i.test(message)))
        return 'RESPONSE_FORMAT_UNSUPPORTED';
    if (/invalid_request_error|bad request|\b400\b/i.test(message))
        return 'PROVIDER_REJECTED';
    return null;
}

export function structuredResponseFormat(schema) {
    return {
        type: 'json_schema',
        json_schema: {
            name: String(schema.name || 'tt_toolkit_task'),
            description: String(schema.description || ''),
            strict: schema.strict !== false,
            schema: requirePlainObject(schema.value, 'JSON schema value'),
        },
    };
}

function requirePlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('LLM_TASK_INVALID', `${label} 必须是对象。`);
    return value;
}

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

export function createDefaultCapabilitySettings() {
    return { schemaVersion: 1, capabilities: {} };
}

export function parseCapabilitySettings(value) {
    if (value === undefined || value === null)
        return createDefaultCapabilitySettings();
    const raw = plainObject(value, '模型 JSON 能力记录');
    exactKeys(raw, ['schemaVersion', 'capabilities'], '模型 JSON 能力记录');
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的模型 JSON 能力记录版本：${String(raw.schemaVersion)}`);
    const capabilities = plainObject(raw.capabilities, '模型 JSON 能力表');
    const parsed = {};
    for (const [presetId, entry] of Object.entries(capabilities)) {
        const item = plainObject(entry, `预设 ${presetId} 能力记录`);
        exactKeys(item, ['format', 'checkedAt'], `预设 ${presetId} 能力记录`);
        if (!CAPABILITY_FORMATS.includes(item.format))
            throw new ToolkitError('INVALID_SCHEMA', `预设 ${presetId} 的能力格式非法。`);
        if (!Number.isSafeInteger(item.checkedAt) || item.checkedAt < 0)
            throw new ToolkitError('INVALID_SCHEMA', `预设 ${presetId} 的能力检测时间非法。`);
        parsed[String(presetId)] = { format: item.format, checkedAt: item.checkedAt };
    }
    return { schemaVersion: 1, capabilities: parsed };
}

export class LlmCapabilityStore {
    constructor(host) {
        this.host = host;
    }

    async load() {
        return parseCapabilitySettings(await this.host.globalGet(CAPABILITIES_KEY));
    }

    async formatFor(presetId) {
        const settings = await this.load();
        const entry = settings.capabilities[String(presetId)];
        if (!entry)
            return null;
        if (Date.now() - entry.checkedAt > CAPABILITY_TTL_MS)
            return null;
        return entry.format;
    }

    async record(presetId, format) {
        if (!CAPABILITY_FORMATS.includes(format))
            throw new ToolkitError('INVALID_SCHEMA', '无法记录未知的 JSON 能力格式。');
        const settings = await this.load();
        settings.capabilities[String(presetId)] = { format, checkedAt: Date.now() };
        await this.host.globalSet(CAPABILITIES_KEY, settings);
    }
}

const PROBE_SCHEMA = {
    name: 'tt_toolkit_capability_probe',
    description: 'Probe whether the provider supports structured JSON output.',
    strict: true,
    value: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
    },
};

const PROBE_SYSTEM_PROMPT = '你是 JSON 格式探测器。只输出 JSON 对象，不要代码块标记或任何解释文字。';
const PROBE_USER_PROMPT = '输出：{"ok":true}';

function tryParseProbeJson(text) {
    const trimmed = String(text ?? '').trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // fall through to extraction
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        }
        catch {
            return null;
        }
    }
    return null;
}

export async function probeResponseFormatCapability(host, preset, options = {}) {
    const generate = options.generate ?? host?.generateOpenAiCompatible?.bind(host);
    if (typeof generate !== 'function')
        return null;
    const attemptTimeoutMs = Number(options.attemptTimeoutMs ?? PROBE_ATTEMPT_TIMEOUT_MS);
    const transportPreset = { ...preset, apiUrl: resolveOpenAiCompatibleBaseUrl(preset.apiUrl) };
    const attempts = [
        { name: 'strict', responseFormat: structuredResponseFormat(PROBE_SCHEMA) },
        { name: 'json_object', responseFormat: { type: 'json_object' } },
        { name: 'plain', responseFormat: null },
    ];
    for (const attempt of attempts) {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, attemptTimeoutMs);
        try {
            const data = await generate(transportPreset, {
                stream: false,
                model: preset.model,
                messages: [
                    { role: 'system', content: PROBE_SYSTEM_PROMPT },
                    { role: 'user', content: PROBE_USER_PROMPT },
                ],
                temperature: 0,
                ...(attempt.responseFormat ? { response_format: attempt.responseFormat } : {}),
            }, controller.signal);
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content === 'string' && content.trim()) {
                const parsed = tryParseProbeJson(content);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    return { format: attempt.name, checkedAt: Date.now() };
            }
        }
        catch (error) {
            if (timedOut)
                continue;
            if (providerRejectionKind(error) !== 'RESPONSE_FORMAT_UNSUPPORTED')
                return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    return null;
}
