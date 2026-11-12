import { describe, expect, it, vi } from 'vitest';
import {
    CAPABILITY_TTL_MS,
    LlmCapabilityStore,
    parseCapabilitySettings,
    probeResponseFormatCapability,
} from '../src/kernel/llm-capabilities.js';

function preset(overrides = {}) {
    return { id: 'p1', name: 'Primary', apiUrl: 'https://api.example.invalid/v1', model: 'model-a', apiKey: '', ...overrides };
}

function hostWith(generate) {
    return { generateOpenAiCompatible: generate };
}

describe('JSON capability settings schema', () => {
    it('defaults and round-trips legal capability records', () => {
        expect(parseCapabilitySettings(undefined)).toEqual({ schemaVersion: 1, capabilities: {} });
        const parsed = parseCapabilitySettings({
            schemaVersion: 1,
            capabilities: { p1: { format: 'plain', checkedAt: 1700000000000 } },
        });
        expect(parsed.capabilities.p1).toEqual({ format: 'plain', checkedAt: 1700000000000 });
    });

    it('rejects damaged capability records', () => {
        expect(() => parseCapabilitySettings({ schemaVersion: 1, capabilities: { p1: { format: 'xml', checkedAt: 1 } } })).toThrow(/格式非法/);
        expect(() => parseCapabilitySettings({ schemaVersion: 1, capabilities: { p1: { format: 'strict', checkedAt: 'now' } } })).toThrow(/时间非法/);
        expect(() => parseCapabilitySettings({ schemaVersion: 1, capabilities: { p1: { format: 'strict', checkedAt: 1, extra: true } } })).toThrow(/未知字段/);
        expect(() => parseCapabilitySettings({ schemaVersion: 2, capabilities: {} })).toThrow(/版本/);
    });
});

describe('capability store persistence', () => {
    it('records and reads back a format until the TTL expires', async () => {
        let stored;
        const host = {
            globalGet: vi.fn(async () => stored),
            globalSet: vi.fn(async (_key, value) => { stored = structuredClone(value); }),
        };
        const store = new LlmCapabilityStore(host);
        expect(await store.formatFor('p1')).toBeNull();
        await store.record('p1', 'json_object');
        expect(await store.formatFor('p1')).toBe('json_object');
        const settings = await store.load();
        settings.capabilities.p1.checkedAt = Date.now() - CAPABILITY_TTL_MS - 1000;
        stored = settings;
        expect(await store.formatFor('p1')).toBeNull();
    });

    it('refuses to record unknown formats', async () => {
        const store = new LlmCapabilityStore({ globalGet: vi.fn(async () => undefined), globalSet: vi.fn() });
        await expect(store.record('p1', 'xml')).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    });
});

describe('response format capability probe', () => {
    it('stops at strict when the provider accepts structured output', async () => {
        const generate = vi.fn(async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
        const result = await probeResponseFormatCapability(hostWith(generate), preset());
        expect(result.format).toBe('strict');
        expect(generate).toHaveBeenCalledOnce();
        expect(generate.mock.calls[0][1].response_format.type).toBe('json_schema');
    });

    it('falls back to json_object when json_schema is rejected', async () => {
        const generate = vi.fn(async (_preset, body) => {
            if (body.response_format?.type === 'json_schema')
                throw new Error('Bad request: Error from provider (Console Go): Upstream request failed: [invalid_request_error] This response_format type is unavailable now');
            return { choices: [{ message: { content: '{"ok":true}' } }] };
        });
        const result = await probeResponseFormatCapability(hostWith(generate), preset());
        expect(result.format).toBe('json_object');
        expect(generate).toHaveBeenCalledTimes(2);
    });

    it('falls back to plain when both response_format variants are rejected', async () => {
        const generate = vi.fn(async (_preset, body) => {
            if (body.response_format?.type)
                throw new Error('Bad request: response_format not supported');
            return { choices: [{ message: { content: '{"ok":true}' } }] };
        });
        const result = await probeResponseFormatCapability(hostWith(generate), preset());
        expect(result.format).toBe('plain');
        expect(generate).toHaveBeenCalledTimes(3);
        expect(generate.mock.calls[2][1].response_format).toBeUndefined();
    });

    it('treats empty json_object content as unusable and continues to plain', async () => {
        const generate = vi.fn(async (_preset, body) => {
            if (body.response_format?.type === 'json_schema')
                throw new Error('Bad request: This response_format type is unavailable now');
            if (body.response_format?.type === 'json_object')
                return { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
            return { choices: [{ message: { content: '{"ok":true}' } }] };
        });
        const result = await probeResponseFormatCapability(hostWith(generate), preset());
        expect(result.format).toBe('plain');
    });

    it('treats non-JSON plain content as unusable and fails the probe', async () => {
        const generate = vi.fn(async () => ({ choices: [{ message: { content: 'sorry, I cannot do that' } }] }));
        const result = await probeResponseFormatCapability(hostWith(generate), preset());
        expect(result).toBeNull();
        expect(generate).toHaveBeenCalledTimes(3);
    });

    it('returns null without recording on non-format failures such as auth errors', async () => {
        const generate = vi.fn(async () => { throw new Error('Bad request: invalid api key'); });
        const result = await probeResponseFormatCapability(hostWith(generate), preset());
        expect(result).toBeNull();
        expect(generate).toHaveBeenCalledOnce();
    });

    it('moves past a hanging format attempt after its short timeout', async () => {
        const generate = vi.fn(async (_preset, body, signal) => {
            if (body.response_format?.type === 'json_schema')
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            return { choices: [{ message: { content: '{"ok":true}' } }] };
        });
        const result = await probeResponseFormatCapability(hostWith(generate), preset(), { attemptTimeoutMs: 20 });
        expect(result.format).toBe('json_object');
        expect(generate).toHaveBeenCalledTimes(2);
    });
});
