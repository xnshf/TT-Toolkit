import { ToolkitError, errorKind } from './errors.js';
import { LlmCapabilityStore, providerRejectionKind, structuredResponseFormat } from './llm-capabilities.js';
import { LlmPresetStore, resolveOpenAiCompatibleBaseUrl } from './llm-presets.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

function requirePlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('LLM_TASK_INVALID', `${label} 必须是对象。`);
    return value;
}

function extractJsonObject(text) {
    const trimmed = String(text ?? '').trim();
    const candidates = [];
    if (trimmed.startsWith('{'))
        candidates.push(trimmed);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start)
        candidates.push(trimmed.slice(start, end + 1));
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        }
        catch {
            // try the next candidate
        }
    }
    throw new ToolkitError('LLM_TASK_JSON_INVALID', '模型服务未返回可解析的 JSON 对象。');
}

function normalizeJsonOutput(output) {
    const trimmed = String(output ?? '').trim();
    if (trimmed.startsWith('{')) {
        try {
            JSON.parse(trimmed);
            return trimmed;
        }
        catch {
            // fall through to extraction
        }
    }
    return JSON.stringify(extractJsonObject(trimmed));
}

export class LlmTaskService {
    constructor(host, log, options = {}) {
        this.log = log;
        this.presets = options.presets ?? new LlmPresetStore(host);
        this.generate = options.generate ?? host?.generateOpenAiCompatible?.bind(host);
        this.capabilities = options.capabilities === undefined
            ? (host && typeof host.globalGet === 'function' ? new LlmCapabilityStore(host) : null)
            : options.capabilities;
        this.unsupportedResponseFormats = new Map();
    }

    async startFormatIndex(presetId) {
        let formatIndex = this.unsupportedResponseFormats.get(presetId) ?? 0;
        if (this.capabilities) {
            try {
                const capability = await this.capabilities.formatFor(presetId);
                if (capability === 'json_object' || capability === 'plain')
                    formatIndex = capability === 'json_object' ? 1 : 2;
            }
            catch (error) {
                this.log?.warn('task.capability_read_failed', {
                    data: { presetId, kind: errorKind(error) },
                    sensitive: { error },
                });
            }
        }
        return formatIndex;
    }

    async execute(input) {
        const task = requirePlainObject(input, '模型任务');
        const taskId = String(task.taskId ?? '').trim();
        const prompt = String(task.prompt ?? '');
        const systemPrompt = String(task.systemPrompt ?? '');
        const schema = requirePlainObject(task.schema, 'JSON schema');
        const timeoutMs = Number(task.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const attemptTimeoutMs = Number(task.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS);
        if (!taskId || !prompt || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            throw new ToolkitError('LLM_TASK_INVALID', '模型任务缺少 taskId、prompt 或有效超时。');
        if (task.signal !== undefined && !(task.signal instanceof AbortSignal))
            throw new ToolkitError('LLM_TASK_INVALID', '模型任务 signal 必须是 AbortSignal。');

        const preset = task.presetId
            ? await this.presets.byId(task.presetId)
            : await this.presets.active();
        if (typeof this.generate !== 'function')
            throw new ToolkitError('HOST_ABI_MISSING', 'TauriTavern 缺少 OpenAI-compatible 后端生成接口。');
        const transportPreset = { ...preset, apiUrl: resolveOpenAiCompatibleBaseUrl(preset.apiUrl) };
        const formats = [structuredResponseFormat(schema), { type: 'json_object' }, null];
        const formatIndex = await this.startFormatIndex(preset.id);
        const startedAt = performance.now();
        const deadline = startedAt + timeoutMs;
        const attemptBudget = Math.max(1, Math.min(attemptTimeoutMs, timeoutMs));
        this.log?.info('task.started', { data: { taskId, adapter: 'openai-compatible', presetId: preset.id, timeoutMs, attemptTimeoutMs } });
        try {
            let data;
            let usable = false;
            let timedOut = false;
            for (let index = formatIndex; index < formats.length; index++) {
                if (task.signal?.aborted)
                    throw new ToolkitError('LLM_TASK_CANCELLED', '模型任务已取消。');
                const remaining = deadline - performance.now();
                if (remaining <= 0) {
                    timedOut = true;
                    break;
                }
                const budget = Math.min(attemptBudget, remaining);
                let attemptTimedOut = false;
                const attemptController = new AbortController();
                const cancel = () => attemptController.abort();
                const attemptTimer = setTimeout(() => {
                    attemptTimedOut = true;
                    attemptController.abort();
                }, budget);
                task.signal?.addEventListener('abort', cancel, { once: true });
                try {
                    data = await this.generate(transportPreset, {
                        stream: false,
                        model: preset.model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: prompt },
                        ],
                        temperature: 0,
                        ...(task.responseLength ? { max_tokens: task.responseLength } : {}),
                        ...(formats[index] ? { response_format: formats[index] } : {}),
                    }, attemptController.signal);
                }
                catch (error) {
                    if (task.signal?.aborted)
                        throw new ToolkitError('LLM_TASK_CANCELLED', '模型任务已取消。');
                    if (attemptTimedOut) {
                        if (index === formats.length - 1) {
                            timedOut = true;
                            break;
                        }
                        this.unsupportedResponseFormats.set(preset.id, index + 1);
                        this.log?.warn('task.structured_output_hang_fallback', {
                            data: { taskId, presetId: preset.id, nextFormat: formats[index + 1]?.type ?? 'plain' },
                        });
                        continue;
                    }
                    const rejection = providerRejectionKind(error);
                    if (rejection !== 'RESPONSE_FORMAT_UNSUPPORTED' || index === formats.length - 1)
                        throw error;
                    this.unsupportedResponseFormats.set(preset.id, index + 1);
                    this.log?.warn('task.structured_output_fallback', {
                        data: { taskId, presetId: preset.id, nextFormat: formats[index + 1]?.type ?? 'plain' },
                    });
                    continue;
                }
                finally {
                    clearTimeout(attemptTimer);
                    task.signal?.removeEventListener('abort', cancel);
                }
                const output = data?.choices?.[0]?.message?.content;
                if (typeof output === 'string' && output.trim()) {
                    usable = true;
                    break;
                }
                if (index === formats.length - 1)
                    break;
                this.unsupportedResponseFormats.set(preset.id, index + 1);
                this.log?.warn('task.structured_output_empty_fallback', {
                    data: { taskId, presetId: preset.id, nextFormat: formats[index + 1]?.type ?? 'plain' },
                });
            }
            if (timedOut)
                throw new ToolkitError('LLM_TASK_TIMEOUT', `模型任务在 ${timeoutMs}ms 后超时。`);
            if (!usable)
                throw new ToolkitError('LLM_TASK_RESPONSE_INVALID', '模型服务未返回有效文本。');
            const result = normalizeJsonOutput(data?.choices?.[0]?.message?.content);
            this.log?.info('task.completed', {
                data: { taskId, adapter: 'openai-compatible', presetId: preset.id, durationMs: Math.round(performance.now() - startedAt) },
            });
            return result;
        }
        catch (error) {
            const normalized = task.signal?.aborted
                ? new ToolkitError('LLM_TASK_CANCELLED', '模型任务已取消。')
                : error;
            const rejection = providerRejectionKind(normalized);
            this.log?.warn('task.failed', {
                data: {
                    taskId,
                    presetId: preset.id,
                    kind: normalized instanceof ToolkitError
                        ? normalized.code
                        : rejection
                            ? rejection
                            : normalized instanceof Error
                                ? normalized.name
                                : typeof normalized,
                },
            });
            throw normalized;
        }
    }
}
