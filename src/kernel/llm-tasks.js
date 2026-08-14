import { ToolkitError } from './errors.js';
import { LlmPresetStore, resolveOpenAiCompatibleBaseUrl } from './llm-presets.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function requirePlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('LLM_TASK_INVALID', `${label} 必须是对象。`);
    return value;
}

function structuredResponseFormat(schema) {
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

export class LlmTaskService {
    constructor(host, log, options = {}) {
        this.log = log;
        this.presets = options.presets ?? new LlmPresetStore(host);
        this.generate = options.generate ?? host?.generateOpenAiCompatible?.bind(host);
    }

    async execute(input) {
        const task = requirePlainObject(input, '模型任务');
        const taskId = String(task.taskId ?? '').trim();
        const prompt = String(task.prompt ?? '');
        const systemPrompt = String(task.systemPrompt ?? '');
        const schema = requirePlainObject(task.schema, 'JSON schema');
        const timeoutMs = Number(task.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        if (!taskId || !prompt || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            throw new ToolkitError('LLM_TASK_INVALID', '模型任务缺少 taskId、prompt 或有效超时。');
        if (task.signal !== undefined && !(task.signal instanceof AbortSignal))
            throw new ToolkitError('LLM_TASK_INVALID', '模型任务 signal 必须是 AbortSignal。');

        const preset = await this.presets.active();
        if (typeof this.generate !== 'function')
            throw new ToolkitError('HOST_ABI_MISSING', 'TauriTavern 缺少 OpenAI-compatible 后端生成接口。');
        const transportPreset = { ...preset, apiUrl: resolveOpenAiCompatibleBaseUrl(preset.apiUrl) };
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const cancel = () => controller.abort();
        task.signal?.addEventListener('abort', cancel, { once: true });
        const startedAt = performance.now();
        this.log?.info('task.started', { data: { taskId, adapter: 'openai-compatible', presetId: preset.id, timeoutMs } });
        try {
            const data = await this.generate(transportPreset, {
                stream: false,
                model: preset.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
                temperature: 0,
                ...(task.responseLength ? { max_tokens: task.responseLength } : {}),
                response_format: structuredResponseFormat(schema),
            }, controller.signal);
            const output = data?.choices?.[0]?.message?.content;
            if (typeof output !== 'string' || !output.trim())
                throw new ToolkitError('LLM_TASK_RESPONSE_INVALID', '模型服务未返回有效文本。');
            this.log?.info('task.completed', {
                data: { taskId, adapter: 'openai-compatible', presetId: preset.id, durationMs: Math.round(performance.now() - startedAt) },
            });
            return output;
        }
        catch (error) {
            const normalized = timedOut
                ? new ToolkitError('LLM_TASK_TIMEOUT', `模型任务在 ${timeoutMs}ms 后超时。`)
                : task.signal?.aborted
                    ? new ToolkitError('LLM_TASK_CANCELLED', '模型任务已取消。')
                    : error;
            this.log?.warn('task.failed', {
                data: { taskId, presetId: preset.id, kind: normalized instanceof ToolkitError ? normalized.code : normalized instanceof Error ? normalized.name : typeof normalized },
            });
            throw normalized;
        }
        finally {
            clearTimeout(timeout);
            task.signal?.removeEventListener('abort', cancel);
        }
    }
}
