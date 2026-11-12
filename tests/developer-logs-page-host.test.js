import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountDeveloperLogsPage } from '../src/features/developer-logs/DeveloperLogsPage.js';

function button(target, text) {
    return [...target.querySelectorAll('button')].find(item => item.textContent === text);
}

function hostEvent(overrides = {}) {
    return {
        sequence: 2,
        timestamp: '2026-08-14T00:00:02.000Z',
        level: 'error',
        featureId: 'system',
        source: 'host-frontend',
        event: 'host.frontend_log',
        data: { hostEntryId: 1, hostTimestampMs: 100, hostLevel: 'error', messagePresent: true },
        privacyMode: 'redacted',
        truncated: false,
        ...overrides,
    };
}

function runtime(overrides = {}) {
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
            currentEntries: [],
            configurationError: '', persistenceError: '', legacyLogsDetected: false,
            hostConsoleCaptureEnabled: false, hostConsoleCaptureError: '',
            hostFrontendStatus: { phase: 'idle', code: '', message: '', importedCount: 0 },
            ...overrides.state,
        },
        subscribe: vi.fn(() => () => undefined),
        loadSession: vi.fn(async () => []),
        refreshHostConsoleCaptureStatus: vi.fn(async () => undefined),
        exportEntries: vi.fn((_entries, format) => format === 'json' ? '{"ok":true}' : 'one log line\n'),
        resetSettings: vi.fn(), saveSettings: vi.fn(), clearLogs: vi.fn(),
    };
}

function mount(options) {
    const target = document.createElement('div');
    document.body.append(target);
    const log = { info: vi.fn(), warn: vi.fn() };
    const exportFile = options.exportFile ?? vi.fn(async () => ({ status: 'saved', mode: 'mobile-native', message: '导出成功。' }));
    mountDeveloperLogsPage(target, {
        runtime: options.runtime,
        exportFile,
        enabled: true,
        setEnabled: vi.fn(),
        log,
        featureCatalog: [{ id: 'chat-cleaner', label: '聊天清洗' }],
    });
    return { target, log, exportFile };
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('developer log host stream UI', () => {
    it('marks host records as 系统 / host-frontend and expands redacted entries with the privacy notice', () => {
        const logger = runtime();
        logger.state.currentEntries.push(hostEvent());
        const { target } = mount({ runtime: logger });
        expect(target.textContent).toContain('host.frontend_log');
        const row = [...target.querySelectorAll('button')].find(item => item.textContent.includes('host.frontend_log'));
        expect(row.textContent).toContain('系统');
        expect(row.textContent).toContain('host-frontend');
        row.click();
        expect(target.textContent).toContain('消息因隐私模式未保存');
        expect(target.textContent).not.toContain('message-1');
    });

    it('shows message and target for full-mode host entries', () => {
        const logger = runtime();
        logger.state.currentEntries.push(hostEvent({
            privacyMode: 'full',
            sensitive: { message: 'host body text', target: 'main' },
        }));
        const { target } = mount({ runtime: logger });
        const row = [...target.querySelectorAll('button')].find(item => item.textContent.includes('host.frontend_log'));
        row.click();
        expect(target.textContent).toContain('host body text');
        expect(target.textContent).toContain('来源：main');
    });

    it('lists host-frontend as a filterable source', () => {
        const logger = runtime();
        logger.state.currentEntries.push(hostEvent());
        const { target } = mount({ runtime: logger });
        const source = target.querySelector('[data-control="source-filter"]');
        expect([...source.options].map(option => option.value)).toContain('host-frontend');
        source.value = 'host-frontend';
        source.dispatchEvent(new Event('change'));
        expect(target.textContent).toContain('host.frontend_log');
        expect(target.textContent).not.toContain('没有匹配的日志');
    });

    it('shows a distinct host ABI error when the log feature cannot start', () => {
        const logger = runtime({ state: { hostFrontendStatus: { phase: 'unavailable', code: 'HOST_FRONTEND_LOGS_MISSING', message: '缺少必需方法', importedCount: 0 } } });
        const { target } = mount({ runtime: logger });
        expect(target.textContent).toContain('宿主前端日志不可用');
        expect(target.textContent).toContain('缺少必需方法');
        expect(target.textContent).toContain('暂无匹配的日志');
        expect(target.textContent).not.toContain('没有匹配的日志');
    });

    it('shows a degraded host stream while Toolkit events remain visible', () => {
        const logger = runtime();
        logger.state.currentEntries.push({ sequence: 1, timestamp: '2026-08-14T00:00:01.000Z', level: 'info', featureId: 'system', source: 'logger', event: 'session.started', data: {}, privacyMode: 'redacted' });
        const { target } = mount({ runtime: logger, state: {} });
        logger.state.hostFrontendStatus = { phase: 'degraded', code: 'HOST_FRONTEND_LOG_ENTRY_INVALID', message: '宿主前端日志条目非法', importedCount: 0 };
        logger.subscribe.mock.calls[0][0](logger.state);
        expect(target.textContent).toContain('宿主日志流已停止');
        expect(target.textContent).toContain('session.started');
    });

    it('keeps persistence errors separate from host stream errors', () => {
        const logger = runtime({ state: { persistenceError: '日志持久化失败：disk full', hostFrontendStatus: { phase: 'degraded', code: '', message: '', importedCount: 0 } } });
        const { target } = mount({ runtime: logger });
        expect(target.textContent).toContain('日志持久化失败：disk full');
        expect(target.textContent).toContain('宿主日志流已停止');
    });

    it('shows unknown console capture state with an independent error', () => {
        const logger = runtime({ state: { hostConsoleCaptureEnabled: null, hostConsoleCaptureError: '读取失败：boom' } });
        const { target } = mount({ runtime: logger });
        expect(target.textContent).toContain('宿主 console 捕获：未知');
        expect(target.textContent).toContain('读取失败：boom');
    });

    it('logs host write failures at warn before displaying the notice', async () => {
        const logger = runtime();
        const exportFile = vi.fn(async () => { throw new Error('disk write error'); });
        const { target, log } = mount({ runtime: logger, exportFile });
        button(target, '导出文件')?.click();
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledOnce());
        expect(log.warn).toHaveBeenCalledWith('export.file_failed', { data: expect.objectContaining({ operation: 'export.file', outcome: 'not-confirmed' }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('disk write error');
        await vi.waitFor(() => expect(target.textContent).toContain('disk write error'));
    });

    it('logs serialization failures as export.serialize_failed', async () => {
        const logger = runtime();
        logger.exportEntries = vi.fn(() => { throw new Error('serialize broken'); });
        const { target, log, exportFile } = mount({ runtime: logger });
        button(target, '导出文件')?.click();
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledOnce());
        expect(log.warn).toHaveBeenCalledWith('export.serialize_failed', { data: expect.objectContaining({ operation: 'export.serialize', sourceLocation: 'developer-logs/DeveloperLogsPage.js' }) });
        expect(exportFile).not.toHaveBeenCalled();
    });

    it('logs copy failures as export.copy_failed', async () => {
        const logger = runtime();
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('clipboard denied'); }) } });
        const { target, log } = mount({ runtime: logger });
        button(target, '复制到剪贴板')?.click();
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledOnce());
        expect(log.warn).toHaveBeenCalledWith('export.copy_failed', { data: expect.objectContaining({ operation: 'export.copy' }) });
        await vi.waitFor(() => expect(target.textContent).toContain('clipboard denied'));
    });

    it('records an ambiguous AbortError instead of silently treating it as cancellation', async () => {
        const logger = runtime();
        const exportFile = vi.fn(async () => { throw new DOMException('host export aborted', 'AbortError'); });
        const { target, log } = mount({ runtime: logger, exportFile });
        button(target, '导出文件')?.click();
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith('export.file_failed', { data: expect.objectContaining({ kind: 'AbortError' }) }));
        expect(target.textContent).not.toContain('已取消导出');
        expect(logger.exportEntries).toHaveBeenCalledOnce();
    });

    it('exports host-frontend events through both JSON and LOG formats', async () => {
        const logger = runtime();
        logger.state.currentEntries.push(hostEvent());
        const { target, exportFile } = mount({ runtime: logger });
        const selectFormat = value => {
            const format = target.querySelector('[data-control="export-format"]');
            format.value = value;
            format.dispatchEvent(new Event('change'));
        };
        selectFormat('json');
        button(target, '导出文件')?.click();
        await vi.waitFor(() => expect(logger.exportEntries).toHaveBeenCalledTimes(1));
        expect(logger.exportEntries).toHaveBeenLastCalledWith([
            expect.objectContaining({ sessionId: 'session-1', event: expect.objectContaining({ source: 'host-frontend' }) }),
        ], 'json');
        await vi.waitFor(() => expect(target.textContent).toContain('导出成功'));
        selectFormat('log');
        button(target, '导出文件')?.click();
        await vi.waitFor(() => expect(logger.exportEntries).toHaveBeenCalledTimes(2));
        expect(logger.exportEntries).toHaveBeenLastCalledWith([
            expect.objectContaining({ sessionId: 'session-1', event: expect.objectContaining({ source: 'host-frontend' }) }),
        ], 'log');
        await vi.waitFor(() => expect(exportFile).toHaveBeenCalledTimes(2));
        expect(exportFile.mock.calls[0][2]).toBe('application/json');
        expect(exportFile.mock.calls[1][2]).toBe('text/plain;charset=utf-8');
    });
});
