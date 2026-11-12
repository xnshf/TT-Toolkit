import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountDeveloperLogsPage } from '../src/features/developer-logs/DeveloperLogsPage.js';

function button(target, text) {
    return [...target.querySelectorAll('button')].find(item => item.textContent === text);
}

function runtime() {
    const session = {
        id: 'session-1', startedAt: '2026-08-14T00:00:00.000Z', endedAt: null,
        interrupted: false, privacyMode: 'redacted', eventCount: 1, bytes: 20,
        droppedBytes: 0, chunks: [],
    };
    return {
        state: {
            settings: { privacyMode: 'redacted', minimumLevel: 'debug', consoleLevel: 'off', maxBytes: 20 * 1024 * 1024 },
            currentSessionId: session.id,
            sessions: [session],
            currentEntries: [{
                sequence: 1, timestamp: '2026-08-14T00:00:01.000Z', level: 'warn',
                featureId: 'chat-cleaner', source: 'transaction', event: 'sample', data: { count: 1 },
            }],
            configurationError: '', persistenceError: '', legacyLogsDetected: false, hostConsoleCaptureEnabled: false,
        },
        subscribe: vi.fn(() => () => undefined),
        loadSession: vi.fn(async () => []),
        refreshHostConsoleCaptureStatus: vi.fn(async () => undefined),
        exportEntries: vi.fn((_entries, format) => format === 'json' ? '{"ok":true}' : 'one log line\n'),
        resetSettings: vi.fn(), saveSettings: vi.fn(), clearLogs: vi.fn(),
    };
}

function mount(logger, exportFile = vi.fn(async () => ({ status: 'started', mode: 'browser', message: '已发起下载，请查看系统默认下载位置。' }))) {
    const target = document.createElement('div');
    document.body.append(target);
    const log = { info: vi.fn(), warn: vi.fn() };
    const dispose = mountDeveloperLogsPage(target, {
        runtime: logger, exportFile, log, enabled: true, setEnabled: vi.fn(),
        featureCatalog: [{ id: 'chat-cleaner', label: '聊天清洗' }],
    });
    return { target, exportFile, log, dispose };
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('developer log actions', () => {
    it('uses the host export instead of the browser save picker', async () => {
        const logger = runtime();
        const picker = vi.fn(() => { throw new DOMException('unsupported', 'AbortError'); });
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
        const { target, exportFile, dispose } = mount(logger);
        const exportButton = button(target, '导出文件');
        const firstRow = [...target.querySelectorAll('button')].find(node => node.textContent.includes('sample'));
        expect(exportButton.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        button(target, '导出文件').click();
        await vi.waitFor(() => expect(exportFile).toHaveBeenCalledOnce());
        expect(picker).not.toHaveBeenCalled();
        expect(logger.exportEntries).toHaveBeenCalledWith([
            expect.objectContaining({ sessionId: 'session-1', event: expect.objectContaining({ featureId: 'chat-cleaner' }) }),
        ], 'log');
        expect(exportFile).toHaveBeenCalledWith('one log line\n', expect.stringMatching(/^tt-toolkit-logs-.*\.log$/), 'text/plain;charset=utf-8');
        await vi.waitFor(() => expect(target.textContent).toContain('已发起下载'));
        expect(target.textContent).not.toContain('导出成功');
        dispose();
    });

    it('does not report success or allow duplicate exports before native saving finishes', async () => {
        let finish;
        const exporter = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const { target, dispose } = mount(runtime(), exporter);
        button(target, '导出文件').click();
        await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());
        expect(button(target, '导出文件').disabled).toBe(true);
        button(target, '导出文件').click();
        expect(exporter).toHaveBeenCalledOnce();
        expect(target.textContent).not.toContain('导出成功');
        finish({ status: 'saved', mode: 'mobile-native', message: '导出成功，文件已保存到系统公共下载目录。' });
        await vi.waitFor(() => expect(target.textContent).toContain('导出成功'));
        const reenabled = [...target.querySelectorAll('button')].find(node => node.textContent.startsWith('导出文件'));
        expect(reenabled.disabled).toBe(false);
        dispose();
    });

    it('records explicit host cancellation without marking the action completed', async () => {
        const exporter = vi.fn(async () => ({ status: 'cancelled', mode: 'android-document-picker', message: '已取消导出。' }));
        const { target, log, dispose } = mount(runtime(), exporter);
        button(target, '导出文件').click();
        await vi.waitFor(() => expect(target.textContent).toContain('已取消导出'));
        expect(log.info).toHaveBeenCalledWith('export.file_completed', { data: expect.objectContaining({ outcome: 'cancelled' }) });
        expect(log.warn).not.toHaveBeenCalled();
        dispose();
    });

    it('copies the selected session through the top-level clipboard', async () => {
        const logger = runtime();
        const { target, dispose } = mount(logger);
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        button(target, '复制到剪贴板').click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('one log line\n'));
        expect(logger.exportEntries).toHaveBeenCalledWith([
            expect.objectContaining({ sessionId: 'session-1' }),
        ], 'log');
        await vi.waitFor(() => expect(target.textContent).toContain('复制成功'));
        dispose();
    });

    it('filters the visible and exported events by feature', async () => {
        const logger = runtime();
        logger.state.currentEntries.push({
            sequence: 2, timestamp: '2026-08-14T00:00:02.000Z', level: 'info',
            featureId: 'system', source: 'host', event: 'chat.saved', data: { count: 1 },
        });
        const { target, dispose } = mount(logger);
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        const feature = target.querySelector('[data-control="feature-filter"]');
        feature.value = 'system';
        feature.dispatchEvent(new Event('change'));
        expect(target.textContent).toContain('chat.saved');
        expect(target.textContent).not.toContain('sample');
        button(target, '复制到剪贴板').click();
        await vi.waitFor(() => expect(logger.exportEntries).toHaveBeenCalled());
        expect(logger.exportEntries.mock.calls.at(-1)[0]).toEqual([
            expect.objectContaining({ event: expect.objectContaining({ featureId: 'system' }) }),
        ]);
        dispose();
    });

    it('asks before leaving only after the log settings were edited', async () => {
        const logger = runtime();
        let guard = null;
        const target = document.createElement('div');
        document.body.append(target);
        const dispose = mountDeveloperLogsPage(target, {
            runtime: logger, exportFile: vi.fn(), log: { info: vi.fn(), warn: vi.fn() },
            enabled: true, setEnabled: vi.fn(), featureCatalog: [],
            setLeaveGuard: value => { guard = value; },
        });
        await expect(guard()).resolves.toBe(true);

        const max = target.querySelector('input[type="number"]');
        max.value = '42';
        max.dispatchEvent(new Event('input'));
        const asking = guard();
        await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
        expect(document.querySelector('dialog').textContent).toContain('容量上限');
        [...document.querySelectorAll('dialog button')].find(node => node.textContent === '取消').click();
        await expect(asking).resolves.toBe(false);
        dispose();
    });
});
