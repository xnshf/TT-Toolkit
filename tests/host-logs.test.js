import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';

function makeHost(frontendLogs) {
    const host = new TauriTavernHost();
    host.abi = { api: { dev: { frontendLogs } } };
    return host;
}

function entry(overrides = {}) {
    return {
        id: 1,
        timestampMs: 1000,
        level: 'info',
        message: 'hello',
        target: 'main',
        ...overrides,
    };
}

function assertCode(promise, code) {
    return expect(promise).rejects.toMatchObject({ name: 'ToolkitError', code });
}

function assertThrowsCode(fn, code) {
    try {
        fn();
        throw new Error(`expected throw with code ${code}`);
    }
    catch (error) {
        if (error?.name === 'ToolkitError' && error.code === code)
            return;
        throw error;
    }
}

describe('host log storage adapter', () => {
    it('classifies only the exact host missing-Blob result and preserves other rejections', async () => {
        const host = new TauriTavernHost();
        const blob = new Blob(['test']);
        const getBlob = vi.fn().mockResolvedValueOnce(blob)
            .mockRejectedValueOnce(new Error('Extension store entry not found: tt-toolkit:logs/chunk.jsonl'));
        const unexpected = new Error('Extension store entry not found: tt-toolkit:other/chunk.jsonl');
        getBlob.mockRejectedValueOnce(unexpected);
        host.abi = { api: { extension: { store: { getBlob } } } };
        await expect(host.storeGetBlob('logs', 'chunk.jsonl')).resolves.toBe(blob);
        await assertCode(host.storeGetBlob('logs', 'chunk.jsonl'), 'STORE_BLOB_NOT_FOUND');
        await expect(host.storeGetBlob('logs', 'chunk.jsonl')).rejects.toBe(unexpected);
        expect(getBlob).toHaveBeenCalledWith({ namespace: 'tt-toolkit', table: 'logs', key: 'chunk.jsonl' });
    });
});

describe('host frontend log adapter', () => {
    it('reads and validates the host frontend log tail without passing a limit', async () => {
        const list = vi.fn(async () => [entry({ id: 7, futureField: 'ignored' })]);
        const host = makeHost({ list, subscribe: vi.fn() });
        const entries = await host.listFrontendLogs();
        expect(list).toHaveBeenCalledWith();
        expect(entries).toEqual([{ id: 7, timestampMs: 1000, level: 'info', message: 'hello', target: 'main' }]);
    });

    it('fails explicitly when frontendLogs or any required method is missing', () => {
        assertThrowsCode(() => makeHost(undefined).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
        assertThrowsCode(() => makeHost({ subscribe: vi.fn() }).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
        assertThrowsCode(() => makeHost({ list: vi.fn() }).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
    });

    it('rejects a non-array tail', async () => {
        const host = makeHost({ list: vi.fn(async () => ({ not: 'array' })), subscribe: vi.fn() });
        await assertCode(host.listFrontendLogs(), 'HOST_FRONTEND_LOG_LIST_INVALID');
    });

    it('rejects a tail read rejection', async () => {
        const host = makeHost({ list: vi.fn(async () => { throw new Error('down'); }), subscribe: vi.fn() });
        await assertCode(host.listFrontendLogs(), 'HOST_FRONTEND_LOG_LIST_INVALID');
    });

    it('rejects invalid entry fields with a stable contract code', async () => {
        const invalid = [
            entry({ id: 0 }),
            entry({ id: 1.5 }),
            entry({ id: '3' }),
            entry({ timestampMs: -1 }),
            entry({ timestampMs: 1.5 }),
            entry({ timestampMs: '1' }),
            entry({ level: 'ERROR' }),
            entry({ level: 'verbose' }),
            entry({ level: 1 }),
            entry({ message: 42 }),
            entry({ message: null }),
            entry({ target: 42 }),
            entry({ target: null }),
        ];
        for (const bad of invalid) {
            const host = makeHost({ list: vi.fn(async () => [bad]), subscribe: vi.fn() });
            await assertCode(host.listFrontendLogs(), 'HOST_FRONTEND_LOG_ENTRY_INVALID');
        }
    });

    it('subscribes, validates entries before delivery, and returns an idempotent cancel', async () => {
        const unsubscribe = vi.fn();
        let capturedHandler;
        const subscribe = vi.fn(handler => {
            capturedHandler = handler;
            return Promise.resolve(unsubscribe);
        });
        const host = makeHost({ list: vi.fn(), subscribe });
        const onEntry = vi.fn();
        const onContractError = vi.fn();
        const cancel = await host.subscribeFrontendLogs(onEntry, onContractError);
        capturedHandler(entry({ id: 5, unknown: 'extra' }));
        expect(onEntry).toHaveBeenCalledWith({ id: 5, timestampMs: 1000, level: 'info', message: 'hello', target: 'main' });
        cancel();
        cancel();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        capturedHandler(entry({ id: 6 }));
        expect(onEntry).toHaveBeenCalledTimes(1);
    });

    it('accepts entries without a target and tolerates the missing target field', async () => {
        const unsubscribe = vi.fn();
        let capturedHandler;
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(handler => { capturedHandler = handler; return Promise.resolve(unsubscribe); }) });
        const onEntry = vi.fn();
        const onContractError = vi.fn();
        const cancel = await host.subscribeFrontendLogs(onEntry, onContractError);
        capturedHandler(entry({ target: undefined }));
        expect(onEntry).toHaveBeenCalledWith({ id: 1, timestampMs: 1000, level: 'info', message: 'hello' });
        cancel();
    });

    it('delivers callbacks that fire before the subscribe promise resolves', async () => {
        const unsubscribe = vi.fn();
        const subscribe = vi.fn(handler => {
            handler(entry({ id: 3 }));
            return Promise.resolve(unsubscribe);
        });
        const host = makeHost({ list: vi.fn(), subscribe });
        const onEntry = vi.fn();
        const onContractError = vi.fn();
        const cancel = await host.subscribeFrontendLogs(onEntry, onContractError);
        expect(onEntry).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
        cancel();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(onContractError).not.toHaveBeenCalled();
    });

    it('reports an invalid runtime entry exactly once and stops delivery', async () => {
        const unsubscribe = vi.fn();
        let capturedHandler;
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(handler => { capturedHandler = handler; return Promise.resolve(unsubscribe); }) });
        const onEntry = vi.fn();
        const onContractError = vi.fn();
        const cancel = await host.subscribeFrontendLogs(onEntry, onContractError);
        capturedHandler(entry({ level: 'bogus' }));
        capturedHandler(entry({ id: 9, level: 'bogus' }));
        capturedHandler(entry({ id: 10, timestampMs: 1000, level: 'info', message: 'fine' }));
        expect(onContractError).toHaveBeenCalledTimes(1);
        expect(onContractError.mock.calls[0][0]).toMatchObject({ code: 'HOST_FRONTEND_LOG_ENTRY_INVALID' });
        expect(onEntry).not.toHaveBeenCalled();
        cancel();
    });

    it('unsubscribes once when an invalid entry stops delivery before the host returns the cancel function', async () => {
        const ready = Promise.withResolvers();
        let capturedHandler;
        const unsubscribe = vi.fn();
        const host = makeHost({ list: vi.fn(), subscribe: handler => { capturedHandler = handler; return ready.promise; } });
        const onEntry = vi.fn();
        const onContractError = vi.fn();
        const subscription = host.subscribeFrontendLogs(onEntry, onContractError);
        capturedHandler(entry({ level: 'bogus' }));
        capturedHandler(entry());
        expect(onContractError).toHaveBeenCalledOnce();
        expect(onEntry).not.toHaveBeenCalled();
        ready.resolve(unsubscribe);
        const cancel = await subscription;
        expect(unsubscribe).toHaveBeenCalledOnce();
        cancel();
        capturedHandler(entry());
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(onEntry).not.toHaveBeenCalled();
    });

    it.each(['invalid cancel function', 'rejection'])('stops delivery after failed registration: %s', async failure => {
        let capturedHandler;
        const host = makeHost({ list: vi.fn(), subscribe: async handler => {
            capturedHandler = handler;
            if (failure === 'rejection')
                throw new Error('private host error');
            return { not: 'function' };
        } });
        const onEntry = vi.fn();
        const onContractError = vi.fn();
        const subscription = host.subscribeFrontendLogs(onEntry, onContractError);
        await assertCode(subscription, failure === 'rejection' ? 'HOST_FRONTEND_LOG_SUBSCRIBE_FAILED' : 'HOST_FRONTEND_LOG_SUBSCRIPTION_INVALID');
        await expect(subscription).rejects.not.toThrow(/private host error/);
        capturedHandler(entry());
        capturedHandler(entry({ level: 'bogus' }));
        expect(onEntry).not.toHaveBeenCalled();
        expect(onContractError).not.toHaveBeenCalled();
    });
});
