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
    let listener = null;
    return {
        notify() { listener?.(); },
        state: {
            settings: { privacyMode: 'redacted', minimumLevel: 'debug', consoleLevel: 'off', maxBytes: 20 * 1024 * 1024 },
            currentSessionId: session.id,
            sessions: [session],
            currentEntries: [{
                sequence: 1, timestamp: '2026-08-14T00:00:01.000Z', level: 'warn',
                featureId: 'chat-cleaner', source: 'transaction', event: 'sample', data: { count: 1 },
            }],
            configurationError: '', persistenceError: '', legacyLogsDetected: false,
        },
        subscribe: vi.fn(callback => {
            listener = callback;
            return () => { listener = null; };
        }),
        loadSession: vi.fn(async () => ({ events: [], unreadableChunks: [] })),
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

function record(logger, event, source = 'transaction') {
    const entries = logger.state.currentEntries;
    entries.push({ ...entries[0], sequence: entries.length + 1, event, source });
    logger.state.sessions[0].eventCount = entries.length;
    logger.notify();
}

describe('live developer logs', () => {
    it('updates rows and filter options without removing focus from settings or log controls', () => {
        const logger = runtime();
        const { target, dispose } = mount(logger);
        const max = target.querySelector('input[type="number"]');
        max.value = '';
        max.dispatchEvent(new Event('input'));
        for (const [index, control] of [max, button(target, '清空日志'), target.querySelector('.log-levels input')].entries()) {
            control.focus();
            record(logger, `live-${index}`, 'new-source');
            expect(target.querySelector('.log-list').textContent).toContain(`live-${index}`);
            expect(document.activeElement).toBe(control);
        }
        expect(max.value).toBe('');
        expect([...target.querySelector('[aria-label="按来源筛选日志"]').options].map(option => option.value)).toContain('new-source');
        dispose();
    });

    it('keeps the composing search node and caret while showing new logs, then applies the committed query', () => {
        const logger = runtime();
        const { target, dispose } = mount(logger);
        const search = target.querySelector('input[type="search"]');
        search.focus();
        search.dispatchEvent(new CompositionEvent('compositionstart'));
        search.value = 'ri';
        search.setSelectionRange(1, 2);
        search.dispatchEvent(new InputEvent('input', { isComposing: true }));
        record(logger, '实时更新');
        expect(document.activeElement).toBe(search);
        expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['ri', 1, 2]);
        expect(target.querySelector('.log-list').textContent).toContain('sample');
        expect(target.querySelector('.log-list').textContent).toContain('实时更新');

        search.value = '实时';
        search.dispatchEvent(new CompositionEvent('compositionend', { data: '实时' }));
        expect(document.activeElement).toBe(search);
        expect(target.querySelector('.log-list').textContent).not.toContain('sample');
        expect(target.querySelector('.log-list').textContent).toContain('实时更新');
        dispose();
    });

    it('keeps the expanded focused row readable across live and paused updates', () => {
        const logger = runtime();
        const { target, dispose } = mount(logger);
        const row = target.querySelector('.log-row');
        row.focus();
        row.click();
        const detail = row.querySelector('pre');
        expect(detail).not.toBeNull();
        record(logger, 'before-pause');
        expect(document.activeElement).toBe(row);
        expect(detail.isConnected).toBe(true);
        button(target, '暂停实时更新').click();
        record(logger, 'while-paused');
        expect(target.querySelector('.log-list').textContent).not.toContain('while-paused');
        button(target, '继续实时更新').click();
        expect(target.querySelector('.log-list').textContent).toContain('while-paused');
        dispose();
    });

    it('updates the page count without discarding focus on an available page button', () => {
        const logger = runtime();
        for (let index = 2; index <= 200; index += 1)
            record(logger, `event-${index}`);
        const { target, dispose } = mount(logger);
        const next = button(target, '下一页');
        next.focus();
        expect(target.querySelector('.pager').textContent).toContain('1 / 2');
        record(logger, 'third-page');
        expect(target.querySelector('.pager').textContent).toContain('1 / 3');
        expect(document.activeElement).toBe(next);
        next.click();
        expect(target.querySelector('.log-list').textContent).toContain('event-200');
        next.click();
        expect(target.querySelector('.log-list').textContent).toContain('third-page');
        expect(next.disabled).toBe(true);
        dispose();
    });
});

describe('developer log actions', () => {
    it('requires confirmation to clear logs and keeps an actionable error free of raw host details', async () => {
        const logger = runtime();
        logger.clearLogs.mockRejectedValueOnce(new Error('private-storage-detail'));
        const { target, dispose } = mount(logger);
        try {
            button(target, '清空日志').click();
            button(document.querySelector('dialog[open]'), '取消').click();
            expect(logger.clearLogs).not.toHaveBeenCalled();
            button(target, '清空日志').click();
            button(document.querySelector('dialog[open]'), '确认清空').click();
            await vi.waitFor(() => expect(target.textContent).toContain('清空日志未完成，请检查日志存储后重试'));
            expect(logger.clearLogs).toHaveBeenCalledOnce();
            expect(target.textContent).not.toContain('private-storage-detail');
            expect(target.querySelector('.log-list').textContent).toContain('sample');
        }
        finally { dispose(); }
    });

    it('marks omissions by session, and confirms only when the export range includes an affected session', async () => {
        const logger = runtime();
        const [live] = logger.state.sessions;
        const [sample] = logger.state.currentEntries;
        const closed = { ...live, endedAt: '2026-08-14T00:00:02.000Z' };
        logger.state.sessions.unshift({ ...closed, id: 'private-affected', eventCount: 4 }, { ...closed, id: 'private-healthy' });
        const delayed = Promise.withResolvers();
        logger.loadSession.mockImplementation(async id => id === 'private-affected' ? delayed.promise : {
            events: [{ ...sample, event: 'healthy-history' }], unreadableChunks: [],
        });
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        const { target, exportFile, dispose } = mount(logger);
        const select = target.querySelector('[data-control="session-filter"]');
        const choose = id => { select.value = id; select.dispatchEvent(new Event('change')); };
        const list = target.querySelector('.log-list');
        try {
            choose('');
            await vi.waitFor(() => expect(list.textContent).toContain('healthy-history'));
            button(target, '导出文件').click();
            await vi.waitFor(() => expect(target.textContent).toContain('正在读取历史会话，请稍后再试'));
            expect(exportFile).not.toHaveBeenCalled();
            delayed.resolve({ events: [{ ...sample, event: 'readable-from-affected' }], unreadableChunks: [{
                chunkIndex: 1, chunkSequence: 5, firstSequence: 8, lastSequence: 10, eventCount: 3, code: 'STORE_BLOB_NOT_FOUND',
            }] });
            await vi.waitFor(() => expect(list.textContent).toContain('readable-from-affected'));
            expect(list.textContent).toContain('healthy-history');
            expect(target.textContent).toContain('会话 #1：1 个分块不可读');
            expect(target.textContent).toContain('分块 #5：事件 8–10（索引预计 3 条），存储中不存在');
            expect(target.textContent).not.toContain('private-affected');

            const search = target.querySelector('input[type="search"]');
            search.value = 'healthy-history';
            search.dispatchEvent(new Event('input'));
            button(target, '复制到剪贴板').click();
            const confirmation = document.querySelector('dialog[open]');
            expect(confirmation.textContent).toContain('会话 #1：1 个分块不可读');
            expect(confirmation.textContent).toContain('仅输出当前筛选匹配的 1 条可读事件');
            expect(confirmation.textContent).toContain('会话 #1 · 分块 #5：事件 8–10（索引预计 3 条），存储中不存在');
            button(confirmation, '取消').click();
            expect(writeText).not.toHaveBeenCalled();
            button(target, '导出文件').click();
            button(document.querySelector('dialog[open]'), '继续').click();
            await vi.waitFor(() => expect(exportFile).toHaveBeenCalledOnce());
            expect(logger.exportEntries).toHaveBeenCalledWith([{ sessionId: 'private-healthy', event: expect.objectContaining({ event: 'healthy-history' }) }], 'log');

            choose('private-healthy');
            await vi.waitFor(() => expect(list.textContent).toContain('healthy-history'));
            expect(target.textContent).not.toContain('分块不可读');
            button(target, '复制到剪贴板').click();
            expect(document.querySelector('dialog[open]')).toBeNull();
            await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        }
        finally {
            dispose();
        }
    });
    it('offers the stopped memory tail for export before the disk prefix finishes loading', async () => {
        const logger = runtime();
        const { target, exportFile, dispose } = mount(logger);
        try {
            const id = logger.state.currentSessionId;
            record(logger, 'after-persistence-failed');
            const tail = logger.state.currentEntries.slice(1);
            const read = Promise.withResolvers();
            logger.loadSession.mockReturnValueOnce(read.promise);
            logger.state.sessions[0] = { ...logger.state.sessions[0], interrupted: true, endedAt: '2026-08-14T00:00:02.000Z' };
            logger.state.stoppedMemorySession = { id, entries: tail };
            logger.state.currentSessionId = null;
            logger.state.currentEntries = [];
            logger.notify();

            expect(target.querySelector('.log-list').textContent).toContain('after-persistence-failed');
            expect(target.textContent).toContain('当前可读 1 / 共记录 2 条');
            button(target, '导出文件').click();
            const dialog = document.querySelector('dialog[open]');
            expect(dialog.textContent).toContain('共记录 2 条，当前可读 1 条');
            button(dialog, '取消').click();
            await vi.waitFor(() => expect(button(target, '导出文件').disabled).toBe(false));
            expect(exportFile).not.toHaveBeenCalled();
            button(target, '导出文件').click();
            button(document.querySelector('dialog[open]'), '继续').click();
            await vi.waitFor(() => expect(exportFile).toHaveBeenCalledOnce());
            expect(logger.exportEntries).toHaveBeenCalledWith([{ sessionId: id, event: tail[0] }], 'log');
            read.resolve({ events: [{ ...tail[0], sequence: 1, event: 'stored-prefix' }, ...tail], unreadableChunks: [] });
            await vi.waitFor(() => expect(target.querySelector('.log-list').textContent).toContain('stored-prefix'));
            expect(target.textContent).toContain('当前可读 2 / 共记录 2 条');
        }
        finally {
            dispose();
        }
    });
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
