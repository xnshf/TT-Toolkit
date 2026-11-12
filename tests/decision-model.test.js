import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionModelService, listDecisionModels, parseDecisionResponseJson } from '../src/kernel/decision-model.js';

const preset = (overrides = {}) => ({ id: 'p1', protocol: 'systemone', apiUrl: 'https://api.example.invalid/v1', model: 'jev-test', apiKey: 'sk-private', ...overrides });
const input = (overrides = {}) => ({ state: { text: 'private state' }, questions: { q1: { type: 'noul', instructions: 'private instructions' } }, ...overrides });
const response = (overrides = {}) => ({ model: 'jev-test', answers: { q1: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 15, output_tokens: 1 }, ...overrides });
const reply = data => ({ ok: true, text: vi.fn(async () => typeof data === 'string' ? data : JSON.stringify(data)) });
function service(fetchImpl, overrides = {}) {
    const log = { info: vi.fn(), warn: vi.fn() };
    const presets = { active: vi.fn(async () => preset()), byId: vi.fn(async () => preset()) };
    return { log, presets, service: new DecisionModelService(null, log, { presets, fetch: fetchImpl, ...overrides }) };
}
afterEach(() => vi.useRealTimers());

describe('System One decision service', () => {
    it('sends one native batch directly, resolves an explicit preset, and returns probabilities and safe usage', async () => {
        const fetch = vi.fn(async () => reply(response({ usage: { input_tokens: 15, output_tokens: 1, private: 'sk-private' } })));
        const { service: model, presets, log } = service(fetch);
        const result = await model.evaluate(input({ presetId: 'p1' }));
        expect(presets.byId).toHaveBeenCalledWith('p1');
        expect(presets.active).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledOnce();
        const [url, request] = fetch.mock.calls[0];
        expect(url).toBe('https://api.example.invalid/v1/systemone');
        expect(request).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', headers: { Authorization: 'Bearer sk-private', 'Content-Type': 'application/json' } });
        expect(JSON.parse(request.body)).toEqual({ model: 'jev-test', state: input().state, questions: input().questions });
        expect(result).toEqual({ model: 'jev-test', probabilities: new Map([['q1', 0.7]]), usage: { input_tokens: 15, output_tokens: 1 } });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('allows optional usage, multiple independent questions, endpoints and empty keys', async () => {
        const fetch = vi.fn(async () => reply(response({ answers: { q1: { type: 'noul', noul: 0 }, q2: { type: 'noul', noul: 1 } }, usage: undefined })));
        const { service: model } = service(fetch, { presets: { active: async () => preset({ apiUrl: 'https://api.example.invalid/v1/systemone/', apiKey: '' }) } });
        const result = await model.evaluate(input({ state: 'state', questions: { ...input().questions, q2: { type: 'noul', instructions: 'another' } } }));
        expect(result.probabilities).toEqual(new Map([['q1', 0], ['q2', 1]]));
        expect(result.usage).toBeUndefined();
        expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
        expect(fetch.mock.calls[0][0]).toBe('https://api.example.invalid/v1/systemone');
    });

    it.each(['openai', undefined, 'unknown'])('rejects %s protocol without a request', async protocol => {
        const fetch = vi.fn();
        const { service: model } = service(fetch, { presets: { active: async () => preset({ protocol }) } });
        await expect(model.evaluate(input())).rejects.toMatchObject({ code: 'DECISION_PROTOCOL_MISMATCH' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        { state: null }, { state: 42 }, { state: { a: NaN } }, { state: { a: undefined } },
        { questions: {} }, { questions: [] }, { questions: { q1: { type: 'choice', instructions: 'x' } } },
        { questions: { q1: { type: 'noul', instructions: '' } } },
        { questions: { q1: { type: 'noul', instructions: 'x', unexpected: true } } },
        { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 32 }, { signal: {} },
    ])('rejects invalid input %# without transport', async overrides => {
        const fetch = vi.fn();
        await expect(service(fetch).service.evaluate(input(overrides))).rejects.toMatchObject({ code: 'DECISION_INPUT_INVALID' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects cycles and sanitizes preset loader exceptions', async () => {
        const state = {}; state.self = state;
        await expect(service(vi.fn()).service.evaluate(input({ state }))).rejects.toMatchObject({ code: 'DECISION_INPUT_INVALID' });
        const { service: model, log } = service(vi.fn(), { presets: { active: async () => { throw new Error('jev-test sk-private'); } } });
        const error = await model.evaluate(input()).catch(error => error);
        expect(error.code).toBe('DECISION_PRESET_INVALID');
        expect(error.message).not.toMatch(/jev-test|sk-private/);
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/jev-test|sk-private/);
    });

    it.each([
        { answers: {} }, { answers: { q1: { type: 'noul', noul: 0.2 }, extra: { type: 'noul', noul: 0 } } },
        { answers: { other: { type: 'noul', noul: 0 } } }, { answers: { q1: { type: 'noul', noul: '0.5' } } },
        { answers: { q1: { type: 'noul', noul: -0.1 } } }, { answers: { q1: { type: 'noul', noul: 1.1 } } },
        { answers: { q1: { type: 'choice', noul: 0.1 } } }, { model: '' }, { model: 'sk-private' },
        { usage: null }, { usage: { input_tokens: -1 } }, { usage: { output_tokens: 0.1 } },
    ])('strictly rejects invalid response %#', async overrides => {
        const fetch = vi.fn(async () => reply(response(overrides)));
        await expect(service(fetch).service.evaluate(input())).rejects.toMatchObject({ code: 'DECISION_RESPONSE_INVALID' });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
        '{"model":"jev-test","answers":{"q1":{"type":"noul","noul":1e999}}}',
        '{"model":"jev-test","answers":{"q1":{"type":"noul","noul":0},"q1":{"type":"noul","noul":1}}}',
        '{"model":"jev-test","answers":{"q1":{"type":"noul","noul":0,"noul":1}}}',
        '{"model":"jev-test","answers":{"q1":{"type":"noul","noul":0},"\\u00711":{"type":"noul","noul":1}}}',
        'not JSON sk-private',
    ])('rejects invalid JSON, duplicate or nonfinite answers without leaking the body', async text => {
        const { service: model, log } = service(vi.fn(async () => reply(text)));
        const error = await model.evaluate(input()).catch(error => error);
        expect(error.code).toBe('DECISION_RESPONSE_INVALID');
        expect(error.message).not.toMatch(/jev-test|sk-private/);
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/jev-test|sk-private|private state|private instructions/);
        expect(log.warn).toHaveBeenCalledWith('decision.failed', expect.objectContaining({ data: expect.objectContaining({ operation: 'evaluate', reasonCode: 'DECISION_RESPONSE_INVALID', source: 'src/kernel/decision-model.js', outcome: 'rejected' }) }));
    });

    it('reports a safe field/type diagnostic without recording answer values', async () => {
        const { service: model, log } = service(vi.fn(async () => reply(response({ answers: { q1: { type: 'noul', noul: 'private value' } } }))));
        await expect(model.evaluate(input())).rejects.toMatchObject({ code: 'DECISION_RESPONSE_INVALID' });
        expect(log.warn).toHaveBeenCalledWith('decision.failed', { data: expect.objectContaining({ field: 'answers.item.noul', actualType: 'string', stage: 'validate_response', expected: 'finite number in [0,1], type noul' }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private value');
    });

    it('supports nested JSON while rejecting all duplicate keys', () => {
        const data = { a: [{ b: 'string with ", {} [] :' }, { b: ['x', { c: 1 }] }], c: 'd' };
        expect(parseDecisionResponseJson(JSON.stringify(data))).toEqual(data);
        expect(() => parseDecisionResponseJson('{"a":[{"b":1,"b":2}]}')).toThrow();
    });

    it.each(['network', 'http', 'body'])('sanitizes %s failure and does not retry', async type => {
        const fetch = vi.fn(async () => {
            if (type === 'network') throw new Error('jev-test sk-private private URL');
            if (type === 'http') return { ok: false, status: 401, text: vi.fn(() => { throw new Error('should not consume'); }) };
            return { ok: true, text: async () => { throw new Error('jev-test sk-private body'); } };
        });
        const { service: model, log } = service(fetch);
        const error = await model.evaluate(input()).catch(error => error);
        expect(error.code).toBe({ network: 'DECISION_NETWORK_FAILED', http: 'DECISION_HTTP_FAILED', body: 'DECISION_RESPONSE_INVALID' }[type]);
        expect(error.message).not.toMatch(/jev-test|sk-private/);
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/jev-test|sk-private/);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it.each(['fetch', 'body', 'preset'])('enforces the whole deadline when %s ignores abort', async phase => {
        vi.useFakeTimers();
        const hanging = () => new Promise(() => {});
        const fetch = vi.fn(phase === 'fetch' ? hanging : async () => ({ ok: true, text: hanging }));
        const options = phase === 'preset' ? { presets: { active: hanging } } : {};
        const { service: model } = service(fetch, options);
        const promise = model.evaluate(input({ timeoutMs: 20 }));
        const check = expect(promise).rejects.toMatchObject({ code: 'DECISION_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(20);
        await check;
        if (phase !== 'preset') expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('handles pre-abort and cancellation during body reading as info, never retries', async () => {
        const controller = new AbortController();
        const fetch = vi.fn(async () => ({ ok: true, text: () => new Promise(() => {}) }));
        const { service: model, log } = service(fetch);
        const promise = model.evaluate(input({ signal: controller.signal }));
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        controller.abort();
        await expect(promise).rejects.toMatchObject({ code: 'DECISION_CANCELLED' });
        await expect(model.evaluate(input({ signal: controller.signal }))).rejects.toMatchObject({ code: 'DECISION_CANCELLED' });
        expect(fetch).toHaveBeenCalledOnce();
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledTimes(2);
    });
});

describe('System One models GET', () => {
    it.each([{ models: [{ name: 'z' }, { name: 'a' }, { name: 'a' }] }, { data: [{ id: 'z' }, { id: 'a' }] }])('accepts both model list shapes and never calls inference', async data => {
        const fetch = vi.fn(async () => reply(data));
        expect(await listDecisionModels(preset({ apiUrl: 'https://api.example.invalid/v1/systemone' }), { fetch })).toEqual(['a', 'z']);
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith('https://api.example.invalid/v1/models', expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit' }));
        expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
    });
    it.each([{ models: [] }, { data: [] }])('allows empty model lists', async data => {
        expect(await listDecisionModels(preset(), { fetch: async () => reply(data) })).toEqual([]);
    });
    it.each([{ models: ['a'] }, { data: [{ id: '' }] }, { models: [{ name: 'sk-private' }] }, { error: 'private' }])('rejects malformed models', async data => {
        await expect(listDecisionModels(preset(), { fetch: async () => reply(data) })).rejects.toMatchObject({ code: 'DECISION_RESPONSE_INVALID' });
    });
});
