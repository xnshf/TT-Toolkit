import { ToolkitError } from './errors.js';
import { LlmPresetStore, resolveSystemOneUrl } from './llm-presets.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messages = {
    DECISION_INPUT_INVALID: '决策请求无效，请检查状态、问题和超时设置。',
    DECISION_PRESET_INVALID: '决策模型预设不可用，请检查或重置模型预设。',
    DECISION_PROTOCOL_MISMATCH: '决策模型需要 System One 协议预设。',
    DECISION_NETWORK_FAILED: '无法连接决策服务，请检查地址、网络及跨域许可后重试。',
    DECISION_HTTP_FAILED: '决策服务拒绝请求，请检查地址、权限及服务状态后重试。',
    DECISION_RESPONSE_INVALID: '决策服务响应结构无效，本次结果未使用；请检查服务协议后重试。',
    DECISION_TIMEOUT: '决策服务请求超时，本次结果未使用；可重试。',
    DECISION_CANCELLED: '决策服务请求已取消。',
};
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function failure(code, stage, field, expected, actualType) {
    return new ToolkitError(code, messages[code], {
        stage, ...(field ? { field, expected } : {}), ...(actualType ? { actualType } : {}),
        source: 'src/kernel/decision-model.js',
        outcome: 'rejected', recovery: code === 'DECISION_CANCELLED' ? 'none' : 'check_settings_or_retry',
    });
}

/** JSON.parse silently overwrites duplicate keys, including escaped answer IDs. */
export function parseDecisionResponseJson(text) {
    try {
        const data = JSON.parse(text);
        const stack = [];
        for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? []) {
            const frame = stack.at(-1);
            if (token.startsWith('"') && frame?.keys && frame.expectKey) {
                const key = JSON.parse(token);
                if (frame.keys.has(key))
                    throw failure('DECISION_RESPONSE_INVALID', 'parse', 'json.keys', 'unique');
                frame.keys.add(key);
                frame.expectKey = false;
            }
            else if (token === '{') stack.push({ keys: new Set(), expectKey: true });
            else if (token === '[') stack.push({});
            else if (token === '}' || token === ']') stack.pop();
            else if (token === ',' && frame?.keys) frame.expectKey = true;
        }
        return data;
    }
    catch (error) {
        if (error instanceof ToolkitError) throw error;
        throw failure('DECISION_RESPONSE_INVALID', 'parse', 'json', 'valid JSON');
    }
}

function validatePreset(preset, needsModel) {
    if (!record(preset) || typeof preset.apiKey !== 'string'
        || (needsModel && (typeof preset.model !== 'string' || !preset.model.trim())))
        throw failure('DECISION_PRESET_INVALID', 'preset');
    if (preset.protocol !== 'systemone')
        throw failure('DECISION_PROTOCOL_MISMATCH', 'preset', 'protocol', 'systemone');
    try {
        if (typeof preset.apiUrl !== 'string') throw new Error();
        return resolveSystemOneUrl(preset.apiUrl);
    }
    catch {
        throw failure('DECISION_PRESET_INVALID', 'preset', 'apiUrl', 'credential-free http(s) base or systemone URL');
    }
}

function validateJsonState(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || ancestors.has(value)
        || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
        throw failure('DECISION_INPUT_INVALID', 'validate', 'state', 'JSON-compatible value');
    ancestors.add(value);
    for (const item of Object.values(value)) validateJsonState(item, ancestors);
    ancestors.delete(value);
}

function requestBody(input, model) {
    if (input.state === null || !['string', 'object'].includes(typeof input.state))
        throw failure('DECISION_INPUT_INVALID', 'validate', 'state', 'string or JSON object/array');
    validateJsonState(input.state);
    if (!record(input.questions) || !Object.keys(input.questions).length)
        throw failure('DECISION_INPUT_INVALID', 'validate', 'questions', 'nonempty object');
    for (const [id, question] of Object.entries(input.questions)) {
        if (!id.trim() || !record(question) || question.type !== 'noul'
            || typeof question.instructions !== 'string' || !question.instructions.trim()
            || Object.keys(question).some(key => !['type', 'instructions'].includes(key)))
            throw failure('DECISION_INPUT_INVALID', 'validate', 'questions.item', '{type:noul,instructions:string}');
    }
    try {
        return JSON.stringify({ model, state: input.state, questions: input.questions });
    }
    catch {
        throw failure('DECISION_INPUT_INVALID', 'validate', 'request', 'JSON serializable');
    }
}

function validateAnswers(data, ids, apiKey) {
    const invalid = (field, expected, value) => { throw failure('DECISION_RESPONSE_INVALID', 'validate_response', field, expected, valueType(value)); };
    if (!record(data) || typeof data.model !== 'string' || !data.model.trim() || (apiKey && data.model.includes(apiKey)))
        invalid('model', 'nonempty model string without credentials', data?.model);
    if (!record(data.answers)) invalid('answers', 'object', data.answers);
    const actual = Object.keys(data.answers);
    if (actual.length !== ids.length || actual.some(id => !ids.includes(id)))
        invalid('answers.keys', 'exact question IDs', actual);
    const probabilities = new Map();
    for (const id of ids) {
        const answer = data.answers[id];
        if (!Object.hasOwn(data.answers, id) || !record(answer) || answer.type !== 'noul'
            || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
            invalid('answers.item.noul', 'finite number in [0,1], type noul', answer?.noul);
        probabilities.set(id, answer.noul);
    }
    let usage;
    if (data.usage !== undefined) {
        if (!record(data.usage)) invalid('usage', 'optional object', data.usage);
        usage = {};
        for (const name of ['input_tokens', 'output_tokens', 'total_tokens']) {
            if (!Object.hasOwn(data.usage, name)) continue;
            if (!Number.isSafeInteger(data.usage[name]) || data.usage[name] < 0)
                invalid('usage.tokens', 'nonnegative safe integer', data.usage[name]);
            usage[name] = data.usage[name];
        }
    }
    return { model: data.model, probabilities, usage };
}

async function withDeadline(options, work) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal)))
        throw failure('DECISION_INPUT_INVALID', 'validate', 'timeoutMs/signal', 'positive timer integer / AbortSignal');
    if (options.signal?.aborted) throw failure('DECISION_CANCELLED', 'cancel');
    const controller = new AbortController();
    let timer;
    let cancel;
    const stop = new Promise((_, reject) => {
        cancel = () => {
            reject(failure('DECISION_CANCELLED', 'cancel'));
            controller.abort();
        };
        options.signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => {
            reject(failure('DECISION_TIMEOUT', 'deadline'));
            controller.abort();
        }, timeoutMs);
    });
    try {
        // Race covers preset loading, fetch and body consumption even if abort is ignored.
        return await Promise.race([stop, Promise.resolve().then(() => work(controller.signal))]);
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
    }
}

async function fetchJson(fetchImpl, url, init) {
    if (init.signal.aborted) throw failure('DECISION_CANCELLED', 'cancel');
    let response;
    try {
        response = await fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit' });
    }
    catch {
        throw failure('DECISION_NETWORK_FAILED', 'fetch');
    }
    if (init.signal.aborted) throw failure('DECISION_CANCELLED', 'cancel');
    if (!response?.ok) throw failure('DECISION_HTTP_FAILED', 'http');
    let text;
    try { text = await response.text(); }
    catch { throw failure('DECISION_RESPONSE_INVALID', 'body', 'body', 'readable JSON'); }
    if (init.signal.aborted) throw failure('DECISION_CANCELLED', 'cancel');
    return parseDecisionResponseJson(text);
}

export class DecisionModelService {
    constructor(host, log, options = {}) {
        this.presets = options.presets ?? new LlmPresetStore(host);
        this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
        this.log = log;
    }

    async evaluate(input) {
        let stage = 'validate';
        try {
            if (!record(input)) throw failure('DECISION_INPUT_INVALID', stage);
            return await withDeadline(input, async signal => {
                stage = 'preset';
                let preset;
                try {
                    preset = input.presetId ? await this.presets.byId(input.presetId) : await this.presets.active();
                }
                catch { throw failure('DECISION_PRESET_INVALID', stage); }
                const url = validatePreset(preset, true);
                const body = requestBody(input, preset.model);
                const ids = Object.keys(JSON.parse(body).questions);
                stage = 'request';
                const data = await fetchJson(this.fetch, url, {
                    method: 'POST', signal,
                    headers: { 'Content-Type': 'application/json', ...(preset.apiKey ? { Authorization: `Bearer ${preset.apiKey}` } : {}) },
                    body,
                });
                return validateAnswers(data, ids, preset.apiKey);
            });
        }
        catch (error) {
            const normalized = error instanceof ToolkitError && Object.hasOwn(messages, error.code)
                ? error : failure('DECISION_INPUT_INVALID', stage);
            const level = normalized.code === 'DECISION_CANCELLED' ? 'info' : 'warn';
            this.log?.[level]('decision.failed', { data: { operation: 'evaluate', reasonCode: normalized.code, ...normalized.context } });
            throw normalized;
        }
    }
}

/** GET only: verifies transport/credentials, not paid inference capability. */
export async function listDecisionModels(preset, options = {}) {
    return withDeadline(options, async signal => {
        const url = validatePreset(preset, false).replace(/\/systemone$/i, '/models');
        const data = await fetchJson(options.fetch ?? globalThis.fetch?.bind(globalThis), url, {
            method: 'GET', signal,
            headers: { Accept: 'application/json', ...(preset.apiKey ? { Authorization: `Bearer ${preset.apiKey}` } : {}) },
        });
        const models = Array.isArray(data?.models) ? data.models : data?.data;
        const field = Array.isArray(data?.models) ? 'name' : 'id';
        if (!record(data) || !Array.isArray(models)
            || models.some(item => !record(item) || typeof item[field] !== 'string' || !item[field].trim()
                || (preset.apiKey && item[field].includes(preset.apiKey))))
            throw failure('DECISION_RESPONSE_INVALID', 'models', 'models/data', 'array of model names/IDs');
        return [...new Set(models.map(item => item[field].trim()))].sort((a, b) => a.localeCompare(b));
    });
}
