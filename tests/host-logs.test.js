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

describe('host frontend log adapter', () => {
    it('reads and validates the host frontend log tail without passing a limit', async () => {
        const list = vi.fn(async () => [entry({ id: 7, futureField: 'ignored' })]);
        const host = makeHost({ list, subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() });
        const entries = await host.listFrontendLogs();
        expect(list).toHaveBeenCalledWith();
        expect(entries).toEqual([{ id: 7, timestampMs: 1000, level: 'info', message: 'hello', target: 'main' }]);
    });

    it('fails explicitly when frontendLogs or any required method is missing', () => {
        assertThrowsCode(() => makeHost(undefined).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
        assertThrowsCode(() => makeHost({ subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() }).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
        assertThrowsCode(() => makeHost({ list: vi.fn(), getConsoleCaptureEnabled: vi.fn() }).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
        assertThrowsCode(() => makeHost({ list: vi.fn(), subscribe: vi.fn() }).assertFrontendLogsCapability(), 'HOST_FRONTEND_LOGS_MISSING');
        expect(() => makeHost({ list: vi.fn(), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() }).assertFrontendLogsCapability()).not.toThrow();
    });

    it('rejects a non-array tail', async () => {
        const host = makeHost({ list: vi.fn(async () => ({ not: 'array' })), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() });
        await assertCode(host.listFrontendLogs(), 'HOST_FRONTEND_LOG_LIST_INVALID');
    });

    it('rejects a tail read rejection', async () => {
        const host = makeHost({ list: vi.fn(async () => { throw new Error('down'); }), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() });
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
            const host = makeHost({ list: vi.fn(async () => [bad]), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn() });
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
        const host = makeHost({ list: vi.fn(), subscribe, getConsoleCaptureEnabled: vi.fn() });
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
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(handler => { capturedHandler = handler; return Promise.resolve(unsubscribe); }), getConsoleCaptureEnabled: vi.fn() });
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
        const host = makeHost({ list: vi.fn(), subscribe, getConsoleCaptureEnabled: vi.fn() });
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
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(handler => { capturedHandler = handler; return Promise.resolve(unsubscribe); }), getConsoleCaptureEnabled: vi.fn() });
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

    it('rejects a subscribe that resolves with a non-function unsubscribe', async () => {
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(async () => ({ not: 'function' })), getConsoleCaptureEnabled: vi.fn() });
        await assertCode(host.subscribeFrontendLogs(vi.fn(), vi.fn()), 'HOST_FRONTEND_LOG_SUBSCRIPTION_INVALID');
    });

    it('rejects a non-boolean console capture status', async () => {
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn(async () => 'yes') });
        await assertCode(host.getHostConsoleCaptureEnabled(), 'HOST_FRONTEND_LOG_STATUS_INVALID');
    });

    it('rejects a console capture status read rejection', async () => {
        const host = makeHost({ list: vi.fn(), subscribe: vi.fn(), getConsoleCaptureEnabled: vi.fn(async () => { throw new Error('boom'); }) });
        await assertCode(host.getHostConsoleCaptureEnabled(), 'HOST_FRONTEND_LOG_STATUS_INVALID');
    });
});
