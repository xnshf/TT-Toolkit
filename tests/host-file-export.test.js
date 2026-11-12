import { afterEach, describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { ToolkitError } from '../src/kernel/errors.js';
import { logFileExportFailure } from '../src/kernel/file-export.js';

function hostWith(result) {
    const host = new TauriTavernHost();
    host.fileExportModule = { download: vi.fn(async () => result) };
    return host;
}
const exportText = host => host.exportFile('document body', 'document.log', 'text/plain;charset=utf-8');

afterEach(() => vi.unstubAllGlobals());

describe('host file export adapter', () => {
    it.each([
        [true, 'saved', '导出成功'],
        [false, 'cancelled', '已取消'],
    ])('normalizes delivered=%j without inventing platform details', async (delivered, status, message) => {
        const host = hostWith({ delivered, savedPath: 'private destination' });
        const result = await exportText(host);
        expect(result).toEqual({ status, mode: 'host-download', message: expect.stringContaining(message) });
        expect(host.fileExportModule.download).toHaveBeenCalledExactlyOnceWith(
            'document body', 'document.log', 'text/plain;charset=utf-8', { throwOnFailure: true },
        );
        expect(JSON.stringify(result)).not.toContain('private destination');
    });

    it('lazily imports the retained frontend interface, never the delivery implementation', async () => {
        const host = new TauriTavernHost();
        host.dynamicImport = vi.fn(async () => hostWith({ delivered: true }).fileExportModule);
        await exportText(host);
        await exportText(host);
        expect(host.dynamicImport).toHaveBeenCalledExactlyOnceWith('/scripts/utils.js');
    });

    it('fails only the operation when the module or export is unavailable', async () => {
        for (const module of [{}, null, { download: 'invalid' }]) {
            const host = new TauriTavernHost();
            host.dynamicImport = vi.fn(async () => module);
            await expect(exportText(host)).rejects.toMatchObject({ code: 'FILE_EXPORT_UNAVAILABLE' });
        }
        const host = new TauriTavernHost();
        host.dynamicImport = vi.fn(async () => { throw new Error('private module path'); });
        await expect(exportText(host)).rejects.toMatchObject({ code: 'FILE_EXPORT_UNAVAILABLE' });
    });

    it.each([null, undefined, {}, { delivered: 'yes' }, { delivered: 0 }, { mode: 'browser', savedPath: '' }])('rejects an unverified result %j', async raw => {
        await expect(exportText(hostWith(raw))).rejects.toMatchObject({ code: 'FILE_EXPORT_RESULT_INVALID' });
    });

    it('does not equate a rejected export with user cancellation or retry it', async () => {
        const host = hostWith(null);
        host.fileExportModule.download.mockRejectedValue(new DOMException('secret payload', 'AbortError'));
        await expect(exportText(host)).rejects.toMatchObject({ code: 'FILE_EXPORT_ABORTED', message: expect.stringContaining('无法确认') });
        expect(host.fileExportModule.download).toHaveBeenCalledOnce();
    });

    it('propagates a safe failure without retaining unknown error text', async () => {
        const host = hostWith(null);
        host.fileExportModule.download.mockRejectedValue(new Error('private key or path'));
        try { await exportText(host); }
        catch (error) {
            expect(error.code).toBe('FILE_EXPORT_FAILED');
            expect(JSON.stringify(error)).not.toContain('private key or path');
            expect(error.message).not.toContain('private key or path');
            return;
        }
        throw new Error('expected rejection');
    });

    it('validates text export inputs before calling the host', async () => {
        const host = hostWith({ delivered: true });
        await expect(host.exportFile(null, 'x.log', 'text/plain')).rejects.toMatchObject({ code: 'FILE_EXPORT_INPUT_INVALID', context: { field: 'content', expected: 'string', actualType: 'null' } });
        expect(host.fileExportModule.download).not.toHaveBeenCalled();
    });

    it('waits for host delivery and leaves notifications to the host', async () => {
        let finish;
        const host = hostWith(null);
        host.fileExportModule.download.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const success = vi.fn();
        const info = vi.fn();
        vi.stubGlobal('toastr', { success, info });
        let settled = false;
        const task = exportText(host).then(result => { settled = true; return result; });
        await Promise.resolve();
        expect(settled).toBe(false);
        finish({ delivered: true });
        await expect(task).resolves.toMatchObject({ status: 'saved' });
        expect(success).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('records allowlisted diagnostics at warn without unknown error or context', () => {
        const log = { warn: vi.fn() };
        const error = new ToolkitError('FILE_EXPORT_ABORTED', 'secret', { reason: 'secret', stage: 'secret' });
        logFileExportFailure(log, 'export.file_failed', 'export.file', error, 'test-boundary');
        expect(log.warn).toHaveBeenCalledWith('export.file_failed', { data: expect.objectContaining({
            code: 'FILE_EXPORT_ABORTED', stage: 'export.write', reason: 'host-export-aborted', sourceLocation: 'test-boundary', nextAction: 'inspect-destination-and-retry',
        }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
    });
});
