import { describe, expect, it, vi } from 'vitest';
import {
    createDefaultLlmPresetSettings,
    LlmPresetStore,
    parseLlmPresetSettings,
    resolveChatCompletionsUrl,
    resolveModelsUrl,
    resolveSystemOneUrl,
} from '../src/kernel/llm-presets.js';
import { fetchOpenAiCompatibleModels } from '../src/kernel/llm-models.js';
import { LlmTaskService } from '../src/kernel/llm-tasks.js';
import { TauriTavernHost } from '../src/kernel/host.js';

function preset(overrides = {}) {
    return {
        id: 'preset-1',
        name: 'Primary',
        apiUrl: 'https://api.example.invalid/v1',
        model: 'model-a',
        apiKey: 'secret-key',
        ...overrides,
    };
}

describe('LLM presets', () => {
    it('supports multiple URL/model/key groups and validates the active preset', () => {
        const value = parseLlmPresetSettings({
            schemaVersion: 1,
            activePresetId: 'preset-2',
            presets: [preset(), preset({ id: 'preset-2', name: 'Backup', model: 'model-b', apiKey: '' })],
        });
        expect(value.presets).toHaveLength(2);
        expect(value.activePresetId).toBe('preset-2');
        expect(() => parseLlmPresetSettings({ ...value, activePresetId: 'missing' })).toThrow(/不存在/);
        expect(createDefaultLlmPresetSettings().presets).toEqual([]);
    });

    it('explicitly migrates known v1 presets without protocol to openai and preserves both protocols', () => {
        const raw = { schemaVersion: 1, activePresetId: 'preset-1', presets: [preset(), preset({ id: 'two', protocol: 'systemone' })] };
        const parsed = parseLlmPresetSettings(raw);
        expect(parsed.presets.map(item => item.protocol)).toEqual(['openai', 'systemone']);
        expect(raw.presets[0]).not.toHaveProperty('protocol');
        expect(parseLlmPresetSettings(parsed)).toEqual(parsed);
        for (const protocol of [null, '', 'unknown', 1])
            expect(() => parseLlmPresetSettings({ ...raw, presets: [preset({ protocol })] })).toThrow();
        expect(() => parseLlmPresetSettings(null)).toThrow();
        expect(() => parseLlmPresetSettings({ ...raw, schemaVersion: 2 })).toThrow();
    });

    it('resolves only clean http(s) System One URLs', () => {
        expect(resolveSystemOneUrl('https://api.example.invalid/v1/')).toBe('https://api.example.invalid/v1/systemone');
        expect(resolveSystemOneUrl('http://localhost:8080/systemone/')).toBe('http://localhost:8080/systemone');
        for (const url of ['file:///tmp/a', 'invalid', 'https://user:secret@api.example.invalid/v1', 'https://api.example.invalid/v1?key=secret', 'https://api.example.invalid/v1#secret', 'https://api.example.invalid/v1?', 'https://api.example.invalid/v1#']) {
            expect(() => resolveSystemOneUrl(url)).toThrow();
            expect(() => parseLlmPresetSettings({ schemaVersion: 1, activePresetId: null, presets: [preset({ protocol: 'systemone', apiUrl: url })] })).toThrow();
        }
    });

    it('derives the standard chat completions route without duplicating a full route', () => {
        expect(resolveChatCompletionsUrl('https://api.example.invalid/v1/')).toBe('https://api.example.invalid/v1/chat/completions');
        expect(resolveChatCompletionsUrl('http://localhost:1234/v1/chat/completions')).toBe('http://localhost:1234/v1/chat/completions');
        expect(() => resolveChatCompletionsUrl('file:///tmp/model')).toThrow(/http/);
        expect(resolveModelsUrl('https://api.example.invalid/v1')).toBe('https://api.example.invalid/v1/models');
        expect(resolveModelsUrl('https://api.example.invalid/v1/chat/completions')).toBe('https://api.example.invalid/v1/models');
        expect(resolveModelsUrl('https://api.example.invalid/v1/models')).toBe('https://api.example.invalid/v1/models');
    });

    it('persists settings through the extension store and resolves the active preset', async () => {
        let saved;
        const host = {
            globalGet: vi.fn(async () => saved),
            globalSet: vi.fn(async (_key, value) => { saved = structuredClone(value); }),
        };
        const store = new LlmPresetStore(host);
        const settings = { schemaVersion: 1, activePresetId: 'preset-1', presets: [preset()] };
        await store.save(settings);
        expect((await store.active()).model).toBe('model-a');
        expect(host.globalSet).toHaveBeenCalledWith('llm-presets-v1', expect.anything());
    });

    it('resolves a preset by id and rejects missing or empty ids', async () => {
        const host = {
            globalGet: vi.fn(async () => ({ schemaVersion: 1, activePresetId: 'preset-1', presets: [preset(), preset({ id: 'preset-2', name: 'Backup' })] })),
        };
        const store = new LlmPresetStore(host);
        expect((await store.byId('preset-2')).name).toBe('Backup');
        await expect(store.byId('missing')).rejects.toMatchObject({ code: 'LLM_PRESET_MISSING' });
        await expect(store.byId('')).rejects.toMatchObject({ code: 'LLM_PRESET_MISSING' });
    });
});

describe('OpenAI-compatible model discovery', () => {
    it('loads, deduplicates and sorts model IDs using the draft preset credentials', async () => {
        const request = vi.fn(async () => ({ data: [{ id: 'model-z' }, { id: 'model-a' }, { id: 'model-a' }] }));
        const models = await fetchOpenAiCompatibleModels({}, preset({ apiUrl: 'https://api.example.invalid/v1/chat/completions' }), { request, timeoutMs: 1000 });
        expect(models).toEqual(['model-a', 'model-z']);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            apiUrl: 'https://api.example.invalid/v1',
            apiKey: 'secret-key',
        }));
    });

    it('rejects non-compatible model list responses without exposing the response body', async () => {
        const request = vi.fn(async () => ({ models: ['secret-response'] }));
        await expect(fetchOpenAiCompatibleModels({}, preset(), { request })).rejects.toMatchObject({
            code: 'LLM_MODELS_RESPONSE_INVALID',
        });
    });
});

describe('TauriTavern OpenAI-compatible transport', () => {
    it('uses the native chat-completion commands with the preset URL and key', async () => {
        const safeInvoke = vi.fn(async command => command === 'get_chat_completions_status'
            ? { data: [] }
            : { choices: [{ message: { content: '{}' } }] });
        const host = new TauriTavernHost();
        host.abi = { invoke: { safeInvoke } };

        await host.getOpenAiCompatibleStatus(preset());
        await host.generateOpenAiCompatible(preset(), { model: 'model-a', messages: [] }, new AbortController().signal);

        expect(safeInvoke).toHaveBeenNthCalledWith(1, 'get_chat_completions_status', {
            dto: expect.objectContaining({
                custom_url: '',
                reverse_proxy: 'https://api.example.invalid/v1',
                proxy_password: 'secret-key',
            }),
        });
        expect(safeInvoke).toHaveBeenNthCalledWith(2, 'generate_chat_completion', expect.objectContaining({
            requestId: expect.any(String),
            dto: expect.objectContaining({
                custom_url: '',
                reverse_proxy: 'https://api.example.invalid/v1',
                proxy_password: 'secret-key',
                model: 'model-a',
            }),
        }));
    });
});

describe('OpenAI-compatible task service', () => {
    it('guards System One before transport and capability requests', async () => {
        const generate = vi.fn();
        const capabilities = { formatFor: vi.fn() };
        const service = new LlmTaskService({}, null, { presets: { active: async () => preset({ protocol: 'systemone' }) }, generate, capabilities });
        await expect(service.execute({ taskId: 'guard', prompt: 'x', schema: { name: 'r' } })).rejects.toMatchObject({ code: 'LLM_PRESET_PROTOCOL_MISMATCH' });
        expect(generate).not.toHaveBeenCalled();
        expect(capabilities.formatFor).not.toHaveBeenCalled();
    });
    it('sends structured output requests to the selected preset without logging the key', async () => {
        const generate = vi.fn(async () => ({ choices: [{ message: { content: '{"activate":[]}' } }] }));
        const log = { info: vi.fn(), warn: vi.fn() };
        const service = new LlmTaskService({}, log, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        const output = await service.execute({
            taskId: 'test',
            systemPrompt: 'system',
            prompt: 'payload',
            timeoutMs: 1000,
            responseLength: 80,
            schema: {
                name: 'result',
                strict: true,
                value: { type: 'object', required: ['activate'], properties: { activate: { type: 'array' } } },
            },
        });
        expect(output).toBe('{"activate":[]}');
        expect(generate).toHaveBeenCalledOnce();
        const [transportPreset, body] = generate.mock.calls[0];
        expect(transportPreset).toEqual(expect.objectContaining({ apiUrl: 'https://api.example.invalid/v1', apiKey: 'secret-key' }));
        expect(body.model).toBe('model-a');
        expect(body.response_format.json_schema.schema.type).toBe('object');
        expect(JSON.stringify(log.info.mock.calls)).not.toContain('secret-key');
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-key');
    });

    it('aborts a timed-out request and reports a typed timeout', async () => {
        const generate = vi.fn((_preset, _body, signal) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        await expect(service.execute({
            taskId: 'timeout',
            prompt: 'payload',
            timeoutMs: 5,
            schema: { name: 'result', value: { type: 'object' } },
        })).rejects.toMatchObject({ code: 'LLM_TASK_TIMEOUT' });
    });

    it('uses an explicit preset id when provided instead of the active preset', async () => {
        const generate = vi.fn(async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
        const service = new LlmTaskService({}, null, {
            presets: {
                byId: vi.fn(async id => preset({ id, name: 'Explicit', model: 'model-b' })),
                active: vi.fn(async () => preset()),
            },
            generate,
        });
        const output = await service.execute({
            taskId: 'explicit',
            presetId: 'preset-9',
            prompt: 'payload',
            timeoutMs: 1000,
            schema: { name: 'result', value: { type: 'object' } },
        });
        expect(output).toBe('{"ok":true}');
        expect(generate.mock.calls[0][0].model).toBe('model-b');
        expect(service.presets.active).not.toHaveBeenCalled();
    });

    it('falls back to json_object when the provider rejects strict structured output and caches the decision', async () => {
        const generate = vi.fn(async (_preset, body) => {
            if (body.response_format?.type === 'json_schema')
                throw new Error('Bad request: Error from provider (Console Go): Upstream request failed: [invalid_request_error] This response_format type is unavailable now');
            return { choices: [{ message: { content: '{"activate":[]}' } }] };
        });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        const input = { taskId: 'fallback', prompt: 'payload', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } };
        expect(await service.execute(input)).toBe('{"activate":[]}');
        expect(generate).toHaveBeenCalledTimes(2);
        expect(generate.mock.calls[1][1].response_format).toEqual({ type: 'json_object' });
        await service.execute(input);
        expect(generate).toHaveBeenCalledTimes(3);
        expect(generate.mock.calls[2][1].response_format).toEqual({ type: 'json_object' });
    });

    it('falls back to plain text and extracts a JSON object when json_object is also unavailable', async () => {
        const generate = vi.fn(async (_preset, body) => {
            if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')
                throw new Error('Bad request: response_format not supported');
            return { choices: [{ message: { content: 'Here you go:\n{"activate":[]}\n' } }] };
        });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        expect(await service.execute({ taskId: 'plain', prompt: 'payload', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"activate":[]}');
        expect(generate).toHaveBeenCalledTimes(3);
        expect(generate.mock.calls[2][1].response_format).toBeUndefined();
    });

    it('does not retry unrelated provider failures and reports a typed JSON error on plain-text fallback', async () => {
        const rejected = vi.fn(async () => { throw new Error('Bad request: model not found'); });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: rejected,
        });
        await expect(service.execute({ taskId: 'x', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .rejects.toThrow('model not found');
        expect(rejected).toHaveBeenCalledTimes(1);

        const prose = vi.fn(async (_preset, body) => {
            if (body.response_format?.type)
                throw new Error('Bad request: response_format unavailable');
            return { choices: [{ message: { content: 'just prose without json' } }] };
        });
        const loose = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: prose,
        });
        await expect(loose.execute({ taskId: 'x', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .rejects.toMatchObject({ code: 'LLM_TASK_JSON_INVALID' });
    });

    it('classifies non-Error rejections and both response_format variants unavailable on the gateway', async () => {
        const gateway = vi.fn(async (_preset, body) => {
            if (body.response_format?.type)
                throw 'Invalid data: Error from provider (Console Go): Upstream request failed: [invalid_request_error] This response_format type is unavailable now';
            return { choices: [{ message: { content: '{"activate":[]}' } }] };
        });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: gateway,
        });
        expect(await service.execute({ taskId: 'gateway', prompt: 'payload', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"activate":[]}');
        expect(gateway).toHaveBeenCalledTimes(3);
        expect(gateway.mock.calls[0][1].response_format.type).toBe('json_schema');
        expect(gateway.mock.calls[1][1].response_format.type).toBe('json_object');
        expect(gateway.mock.calls[2][1].response_format).toBeUndefined();
    });

    it('falls back when json_object succeeds but returns empty content and plain succeeds', async () => {
        const flash = vi.fn(async (_preset, body) => {
            if (body.response_format?.type === 'json_schema')
                throw new Error('Bad request: This response_format type is unavailable now');
            if (body.response_format?.type === 'json_object')
                return { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
            return { choices: [{ message: { content: '{"activate":[]}' } }] };
        });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: flash,
        });
        expect(await service.execute({ taskId: 'flash', prompt: 'payload', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"activate":[]}');
        expect(flash).toHaveBeenCalledTimes(3);
        expect(flash.mock.calls[2][1].response_format).toBeUndefined();
    });

    it('falls back when the gateway requires the literal word json for json_object mode', async () => {
        const strict = vi.fn(async (_preset, body) => {
            if (body.response_format?.type === 'json_schema')
                throw new Error('Bad request: This response_format type is unavailable now');
            if (body.response_format?.type === 'json_object')
                throw new Error("Bad request: The 'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'");
            return { choices: [{ message: { content: '{"activate":[]}' } }] };
        });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: strict,
        });
        expect(await service.execute({ taskId: 'jsonword', prompt: 'payload', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"activate":[]}');
        expect(strict).toHaveBeenCalledTimes(3);
    });

    it('keeps empty content on the final plain attempt as a typed response error', async () => {
        const empty = vi.fn(async () => ({ choices: [{ message: { content: '  ' } }] }));
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: empty,
        });
        await expect(service.execute({ taskId: 'empty', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .rejects.toMatchObject({ code: 'LLM_TASK_RESPONSE_INVALID' });
        expect(empty).toHaveBeenCalledTimes(3);
    });

    it('starts directly from the recorded capability format instead of strict', async () => {
        const generate = vi.fn(async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
        const capabilities = {
            formatFor: vi.fn(async () => 'json_object'),
            record: vi.fn(),
        };
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
            capabilities,
        });
        expect(await service.execute({ taskId: 'capped', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"ok":true}');
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls[0][1].response_format).toEqual({ type: 'json_object' });

        const plainStore = { formatFor: vi.fn(async () => 'plain') };
        const plainService = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: vi.fn(async () => ({ choices: [{ message: { content: '{"ok":true}' } }] })),
            capabilities: plainStore,
        });
        await plainService.execute({ taskId: 'capped', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } });
        expect(plainService.generate.mock.calls[0][1].response_format).toBeUndefined();
    });

    it('moves past a hanging format attempt after the per-attempt timeout and succeeds on json_object', async () => {
        const generate = vi.fn(async (_preset, body, signal) => {
            if (body.response_format?.type === 'json_schema')
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            return { choices: [{ message: { content: '{"ok":true}' } }] };
        });
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        expect(await service.execute({
            taskId: 'hang',
            prompt: 'p',
            timeoutMs: 1000,
            attemptTimeoutMs: 20,
            schema: { name: 'r', value: { type: 'object' } },
        })).toBe('{"ok":true}');
        expect(generate).toHaveBeenCalledTimes(2);
        expect(generate.mock.calls[1][1].response_format).toEqual({ type: 'json_object' });
    });

    it('reports a typed timeout when every format attempt hangs to the deadline', async () => {
        const generate = vi.fn((_preset, _body, signal) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        await expect(service.execute({
            taskId: 'hang-all',
            prompt: 'p',
            timeoutMs: 100,
            attemptTimeoutMs: 20,
            schema: { name: 'r', value: { type: 'object' } },
        })).rejects.toMatchObject({ code: 'LLM_TASK_TIMEOUT' });
        expect(generate).toHaveBeenCalledTimes(3);
    });

    it('stops immediately with a typed cancellation when the user aborts and never retries formats', async () => {
        const generate = vi.fn(async (_preset, _body, signal) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate,
        });
        const controller = new AbortController();
        const detection = service.execute({
            taskId: 'cancel',
            prompt: 'p',
            timeoutMs: 1000,
            attemptTimeoutMs: 20,
            signal: controller.signal,
            schema: { name: 'r', value: { type: 'object' } },
        });
        setTimeout(() => controller.abort(), 5);
        await expect(detection).rejects.toMatchObject({ code: 'LLM_TASK_CANCELLED' });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('normalizes markdown-fenced or prose-wrapped JSON even without a response_format fallback', async () => {
        const fenced = vi.fn(async () => ({ choices: [{ message: { content: '```json\n{"activate":[]}\n```' } }] }));
        const service = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: fenced,
        });
        expect(await service.execute({ taskId: 'fenced', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"activate":[]}');
        expect(fenced).toHaveBeenCalledTimes(1);

        const wrapped = vi.fn(async () => ({ choices: [{ message: { content: 'Sure, here you go:\n{"activate":["a"]}' } }] }));
        const loose = new LlmTaskService({}, null, {
            presets: { active: vi.fn(async () => preset()) },
            generate: wrapped,
        });
        expect(await loose.execute({ taskId: 'wrapped', prompt: 'p', timeoutMs: 1000, schema: { name: 'r', value: { type: 'object' } } }))
            .toBe('{"activate":["a"]}');
    });
});
