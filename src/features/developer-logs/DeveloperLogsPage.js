import { actionButton, callout, h } from '../../ui/dom.js';
import { errorMessage } from '../../kernel/errors.js';
import { MIB } from '../../kernel/logging/schema.js';
import { confirmDanger } from '../../ui/confirm.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';

const PAGE_SIZE = 100;
const LEVELS = ['debug', 'info', 'warn', 'error'];

function documentContext(target) {
    const ownerDocument = target.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    try {
        if (ownerWindow?.top?.document)
            return { document: ownerWindow.top.document, window: ownerWindow.top };
    }
    catch {
        // Cross-origin embedding is not expected, but the iframe document remains usable.
    }
    return { document: ownerDocument, window: ownerWindow ?? globalThis };
}

function exportFilename(extension) {
    return `tt-toolkit-logs-${new Date().toISOString().replaceAll(':', '-')}.${extension}`;
}

function pickerOptions(filename, extension) {
    const json = extension === 'json';
    return {
        suggestedName: filename,
        types: [{
            description: json ? 'JSON 日志' : '纯文本日志',
            accept: { [json ? 'application/json' : 'text/plain']: [`.${extension}`] },
        }],
    };
}

async function chooseExportDestination(target, extension) {
    const context = documentContext(target);
    const filename = exportFilename(extension);
    if (typeof context.window.showSaveFilePicker !== 'function')
        return { kind: 'download', filename };
    try {
        const handle = await context.window.showSaveFilePicker(pickerOptions(filename, extension));
        return { kind: 'file', filename, handle };
    }
    catch (error) {
        if (error?.name === 'AbortError')
            return { kind: 'cancelled', filename };
        throw error;
    }
}

function downloadText(target, text, extension, filename) {
    const context = documentContext(target);
    const BlobConstructor = context.window.Blob ?? Blob;
    const urlApi = context.window.URL ?? URL;
    const blob = new BlobConstructor([text], { type: extension === 'json' ? 'application/json' : 'text/plain' });
    const url = urlApi.createObjectURL(blob);
    const link = context.document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    context.document.body.append(link);
    link.click();
    context.window.setTimeout(() => {
        link.remove();
        urlApi.revokeObjectURL(url);
    }, 1000);
    return filename;
}

async function writeExportFile(destination, text) {
    const writable = await destination.handle.createWritable();
    try {
        await writable.write(text);
        await writable.close();
    }
    catch (error) {
        try {
            await writable.abort?.();
        }
        catch {
            // Preserve the original write error.
        }
        throw error;
    }
}

async function copyText(target, text) {
    const context = documentContext(target);
    let clipboardError = null;
    try {
        if (context.window.navigator?.clipboard?.writeText) {
            await context.window.navigator.clipboard.writeText(text);
            return;
        }
    }
    catch (error) {
        clipboardError = error;
    }
    const textarea = context.document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    context.document.body.append(textarea);
    textarea.focus();
    textarea.select();
    const copied = context.document.execCommand?.('copy') === true;
    textarea.remove();
    if (!copied)
        throw clipboardError ?? new Error('当前 WebView 不允许访问剪贴板');
}

function option(value, text, selected = false) {
    return h('option', { value, text, selected });
}

export function mountDeveloperLogsPage(target, props) {
    const runtime = props.runtime;
    const log = props.log ?? null;
    const featureCatalog = [{ id: 'system', label: '系统' }, ...(props.featureCatalog ?? [])];
    const featureLabels = new Map(featureCatalog.map(feature => [feature.id, feature.label]));
    const reportFailure = (event, operation, error) => {
        if (error?.name === 'AbortError')
            return;
        log?.fail?.(event, operation, error);
    };
    const hostStatusIssues = () => {
        const issues = [];
        const status = runtime.state.hostFrontendStatus;
        if (status?.phase === 'unavailable')
            issues.push('宿主前端日志不可用');
        if (status?.phase === 'degraded')
            issues.push('宿主日志流已降级');
        if (runtime.state.persistenceError)
            issues.push('持久化失败');
        if (runtime.state.configurationError)
            issues.push('日志设置损坏');
        if (runtime.state.legacyLogsDetected)
            issues.push('旧版日志结构');
        if (runtime.state.hostConsoleCaptureError)
            issues.push('宿主 console 状态未知');
        return issues;
    };
    const view = {
        enabled: props.enabled,
        draft: structuredClone(runtime.state.settings),
        maxMiB: runtime.state.settings.maxBytes / MIB,
        selectedSession: runtime.state.currentSessionId ?? runtime.state.sessions.at(-1)?.id ?? '',
        loadedSessions: new Map(),
        levels: { debug: true, info: true, warn: true, error: true },
        featureFilter: '',
        sourceFilter: '',
        search: '',
        exportFormat: 'log',
        page: 0,
        expanded: null,
        actionNotice: null,
        completedAction: '',
        paused: false,
        pausedEntries: [],
    };
    let disposed = false;
    let actionNoticeTimer = null;
    const notices = createNoticeController(() => render());

    function setActionNotice(notice) {
        if (actionNoticeTimer !== null)
            clearTimeout(actionNoticeTimer);
        actionNoticeTimer = null;
        view.actionNotice = notice;
        if (notice && (notice.kind === 'success' || notice.kind === 'neutral')) {
            actionNoticeTimer = setTimeout(() => {
                actionNoticeTimer = null;
                view.actionNotice = null;
                render();
            }, notice.kind === 'success' ? 4500 : 3000);
        }
    }

    const selectedSessions = () => view.selectedSession
        ? runtime.state.sessions.filter(session => session.id === view.selectedSession)
        : runtime.state.sessions;
    const entries = () => selectedSessions().flatMap(session => {
        const sessionEntries = session.id === runtime.state.currentSessionId
            ? view.paused ? view.pausedEntries : runtime.state.currentEntries
            : view.loadedSessions.get(session.id) ?? [];
        return sessionEntries.map(event => ({ sessionId: session.id, event }));
    });
    const filtered = () => entries().filter(({ event }) => view.levels[event.level]
        && (!view.featureFilter || event.featureId === view.featureFilter)
        && (!view.sourceFilter || event.source === view.sourceFilter)
        && (!view.search || JSON.stringify(event).toLowerCase().includes(view.search.toLowerCase())));

    const run = async (task, action = null) => {
        notices.clear();
        if (action) {
            setActionNotice({ kind: 'progress', text: action.progress });
            view.completedAction = '';
            render();
        }
        try {
            await task();
        }
        catch (error) {
            const message = errorMessage(error);
            if (action)
                setActionNotice({ kind: 'error', text: message });
            else
                notices.show(message, 'danger');
        }
        render();
    };

    async function reloadSession() {
        view.paused = false;
        view.page = 0;
        view.expanded = null;
        view.loadedSessions = new Map();
        const closedSessions = selectedSessions().filter(session => session.id !== runtime.state.currentSessionId);
        const loaded = await Promise.all(closedSessions.map(async session => [session.id, await runtime.loadSession(session.id)]));
        view.loadedSessions = new Map(loaded);
    }

    function togglePause() {
        if (!view.paused)
            view.pausedEntries = structuredClone(runtime.state.currentEntries);
        view.paused = !view.paused;
        render();
    }

    async function exportDownload(records, format, actionId) {
        // Invoke the picker before log generation awaits so transient user activation is retained.
        let destination;
        try {
            destination = await chooseExportDestination(target, format);
        }
        catch (error) {
            reportFailure('export.file_failed', 'export.file', error);
            throw error;
        }
        if (destination.kind === 'cancelled') {
            setActionNotice({ kind: 'neutral', text: '已取消导出。' });
            return;
        }
        let text;
        try {
            text = runtime.exportEntries(records, format);
        }
        catch (error) {
            reportFailure('export.serialize_failed', 'export.serialize', error);
            throw error;
        }
        try {
            if (destination.kind === 'file') {
                await writeExportFile(destination, text);
                setActionNotice({ kind: 'success', text: `导出成功：${destination.handle.name || destination.filename}` });
            }
            else {
                downloadText(target, text, format, destination.filename);
                setActionNotice({ kind: 'success', text: `当前 WebView 不支持选择保存位置，已下载到默认目录：${destination.filename}` });
            }
            view.completedAction = actionId;
        }
        catch (error) {
            reportFailure('export.file_failed', 'export.file', error);
            throw error;
        }
    }

    async function exportCopy(records, format, actionId) {
        let text;
        try {
            text = runtime.exportEntries(records, format);
        }
        catch (error) {
            reportFailure('export.serialize_failed', 'export.serialize', error);
            throw error;
        }
        try {
            await copyText(target, text);
        }
        catch (error) {
            reportFailure('export.copy_failed', 'export.copy', error);
            throw error;
        }
        setActionNotice({ kind: 'success', text: `复制成功：${format.toUpperCase()} 日志已写入剪贴板。` });
        view.completedAction = actionId;
    }

    function completedLabel(actionId, label) {
        return view.completedAction === actionId ? `${label} ✓` : label;
    }

    function logActionStatus() {
        if (!view.actionNotice)
            return null;
        const kind = view.actionNotice.kind;
        return h('div', {
            className: `log-action-status ${kind}`,
            text: view.actionNotice.text,
            attrs: { role: 'status', 'aria-live': kind === 'error' ? 'assertive' : 'polite' },
        });
    }

    function settingsGrid() {
        const privacy = h('select', { dataset: { control: 'privacy' } },
            option('redacted', '脱敏', view.draft.privacyMode === 'redacted'),
            option('full', '完整（不脱敏）', view.draft.privacyMode === 'full'),
        );
        privacy.addEventListener('change', () => { view.draft.privacyMode = privacy.value; render(); });
        const minimum = h('select', {}, LEVELS.map(level => option(level, level, view.draft.minimumLevel === level)));
        minimum.addEventListener('change', () => { view.draft.minimumLevel = minimum.value; });
        const consoleLevel = h('select', {}, ['off', ...LEVELS].map(level => option(level, level, view.draft.consoleLevel === level)));
        consoleLevel.addEventListener('change', () => { view.draft.consoleLevel = consoleLevel.value; });
        const max = h('input', { type: 'number', min: 1, max: 200, step: 1, value: view.maxMiB });
        max.addEventListener('input', () => { view.maxMiB = Number(max.value); });
        return h('div', { className: 'log-settings-grid' },
            h('label', {}, '隐私模式', privacy),
            h('label', {}, '最低记录级别', minimum),
            h('label', {}, 'console 同步', consoleLevel),
            h('label', {}, '容量上限（MiB）', max),
        );
    }

    function toolbar() {
        const features = h('select', { dataset: { control: 'feature-filter' } },
            option('', '全部功能', !view.featureFilter),
            featureCatalog.map(feature => option(feature.id, feature.label, view.featureFilter === feature.id)),
        );
        features.addEventListener('change', () => { view.featureFilter = features.value; view.page = 0; render(); });
        const sessions = h('select', { dataset: { control: 'session-filter' } }, option('', '全部会话', !view.selectedSession), runtime.state.sessions.map(session => option(
            session.id,
            `${session.startedAt} · ${session.privacyMode}${session.interrupted ? ' · 中断' : ''}`,
            view.selectedSession === session.id,
        )));
        sessions.addEventListener('change', () => {
            view.selectedSession = sessions.value;
            void run(reloadSession);
        });
        const sources = [...new Set(entries().map(({ event }) => event.source))].sort();
        const source = h('select', { dataset: { control: 'source-filter' } }, option('', '全部来源', !view.sourceFilter), sources.map(value => option(value, value, view.sourceFilter === value)));
        source.addEventListener('change', () => { view.sourceFilter = source.value; view.page = 0; render(); });
        const search = h('input', { value: view.search, placeholder: '搜索事件或数据', dataset: { control: 'search' } });
        search.addEventListener('input', () => {
            view.search = search.value;
            view.page = 0;
            render('search');
        });
        return h('div', { className: 'log-toolbar' }, features, sessions, source, search);
    }

    function logList() {
        const results = filtered();
        const pageCount = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
        view.page = Math.min(view.page, pageCount - 1);
        const visible = results.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
        const list = h('div', { className: 'log-list' });
        for (const record of visible) {
            const { sessionId: entrySessionId, event: entry } = record;
            const entryKey = `${entrySessionId}:${entry.sequence}`;
            const row = actionButton('', () => {
                view.expanded = view.expanded === entryKey ? null : entryKey;
                render();
            }, { className: `log-row level-${entry.level}` });
            row.append(
                h('span', { text: entry.timestamp.slice(11, 23) }),
                h('b', { text: entry.level }),
                h('em', { className: 'log-feature', text: featureLabels.get(entry.featureId) ?? entry.featureId }),
                h('i', { text: entry.source }),
                h('strong', { text: entry.event }),
            );
            if (view.expanded === entryKey) {
                if (entry.featureId === 'system' && entry.source === 'host-frontend') {
                    const details = h('div', { className: 'log-expanded-host' },
                        h('pre', { text: JSON.stringify({
                            hostEntryId: entry.data?.hostEntryId,
                            hostTimestampMs: entry.data?.hostTimestampMs,
                            hostLevel: entry.data?.hostLevel,
                            messagePresent: entry.data?.messagePresent,
                        }, null, 2) }),
                    );
                    if (entry.privacyMode === 'full') {
                        if (typeof entry.sensitive?.message === 'string')
                            details.append(h('p', { className: 'log-host-message', text: entry.sensitive.message }));
                        if (typeof entry.sensitive?.target === 'string')
                            details.append(h('p', { className: 'log-host-target', text: `来源：${entry.sensitive.target}` }));
                    }
                    else {
                        details.append(h('p', { className: 'log-host-redacted', text: '消息因隐私模式未保存' }));
                    }
                    row.append(details);
                }
                else {
                    row.append(h('pre', { text: JSON.stringify({ sessionId: entrySessionId, ...entry }, null, 2) }));
                }
            }
            list.append(row);
        }
        if (!visible.length) {
            list.append(h('p', { className: 'empty-state', text: hostStatusIssues().length ? '暂无匹配的日志。' : '没有匹配的日志。' }));
        }
        return [list, h('div', { className: 'pager' },
            actionButton('上一页', () => { view.page -= 1; render(); }, { disabled: view.page === 0 }),
            h('span', { text: `${view.page + 1} / ${pageCount}` }),
            actionButton('下一页', () => { view.page += 1; render(); }, { disabled: view.page + 1 >= pageCount }),
        )];
    }

    function render(focusControl = '') {
        if (disposed)
            return;
        const root = h('section', { className: 'feature-page developer-logs-page' });
        const toggle = h('input', { type: 'checkbox', checked: view.enabled });
        toggle.addEventListener('change', () => {
            const next = toggle.checked;
            void run(async () => {
                await props.setEnabled(next);
                view.enabled = next;
            });
        });
        root.append(h('header', { className: 'feature-header' },
            h('div', {},
                h('p', { className: 'eyebrow', text: '设置' }),
                h('h2', { text: '日志' }),
                h('p', { text: '记录、筛选并导出 TT-Toolkit 的结构化诊断事件。' }),
            ),
            h('label', { className: 'master-toggle' }, toggle, h('span', { text: view.enabled ? '记录中' : '已关闭' })),
        ));
        if (view.draft.privacyMode === 'full')
            root.append(callout('完整模式会记录相关聊天正文、规则和 before/after，导出文件可能包含敏感内容。', 'danger'));
        const hostStatus = runtime.state.hostFrontendStatus;
        if (hostStatus?.phase === 'unavailable')
            root.append(callout(`宿主前端日志不可用：${hostStatus.message}。日志功能无法启动，其它工具不受影响。`, 'danger'));
        if (hostStatus?.phase === 'degraded')
            root.append(callout(`宿主日志流已停止：${hostStatus.message || '运行期宿主日志契约错误'}。当前会话继续记录 TT-Toolkit 自身事件，不会自动重连；请关闭后重新启用日志。`, 'warning'));
        if (runtime.state.configurationError)
            root.append(callout(`日志设置损坏：${runtime.state.configurationError}`, 'danger'));
        if (runtime.state.legacyLogsDetected)
            root.append(callout('检测到旧版日志结构。旧日志不会被推断归类；请清空日志后重新启用记录。', 'danger'));
        if (runtime.state.persistenceError)
            root.append(callout(runtime.state.persistenceError, 'danger'));
        if (runtime.state.hostConsoleCaptureError)
            root.append(callout(`宿主 console 捕获状态未知：${runtime.state.hostConsoleCaptureError}`, 'warning'));
        const notice = noticeBanner(notices.current, () => notices.clear(true));
        if (notice)
            root.append(notice);
        root.append(settingsGrid());
        const usedBytes = runtime.state.sessions.reduce((sum, session) => sum + session.bytes, 0);
        const capture = runtime.state.hostConsoleCaptureEnabled;
        root.append(h('div', { className: 'log-summary' },
            h('span', { text: `已用 ${(usedBytes / MIB).toFixed(2)} / ${view.maxMiB} MiB` }),
            h('span', { text: `${runtime.state.sessions.length} 个会话` }),
            h('span', { text: `宿主 console 捕获：${capture === null ? '未知' : capture ? '开启' : '关闭'}` }),
        ));
        root.append(h('div', { className: 'actions' },
            actionButton('重置设置', () => { void run(async () => { await runtime.resetSettings(); view.draft = structuredClone(runtime.state.settings); view.maxMiB = view.draft.maxBytes / MIB; notices.show('日志设置已重置。', 'success'); }); }, { className: 'secondary' }),
            actionButton('保存设置', () => { void run(async () => { view.draft.maxBytes = Math.round(view.maxMiB * MIB); await runtime.saveSettings(structuredClone(view.draft)); view.draft = structuredClone(runtime.state.settings); notices.show('日志设置已保存。隐私模式变化时已自动开启新会话。', 'success'); }); }, { className: 'primary' }),
        ));
        root.append(h('hr'), toolbar());
        root.append(h('div', { className: 'log-levels' }, LEVELS.map(level => {
            const checkbox = h('input', { type: 'checkbox', checked: view.levels[level] });
            checkbox.addEventListener('change', () => { view.levels[level] = checkbox.checked; view.page = 0; render(); });
            return h('label', {}, checkbox, level);
        })));
        const selectedMeta = runtime.state.sessions.find(session => session.id === view.selectedSession);
        root.append(h('div', { className: 'log-summary' },
            selectedMeta
                ? h('span', { text: `${selectedMeta.eventCount} 条事件 · ${(selectedMeta.bytes / 1024).toFixed(1)} KiB · 已淘汰 ${(selectedMeta.droppedBytes / 1024).toFixed(1)} KiB` })
                : h('span', { text: `${filtered().length} 条匹配事件 · ${runtime.state.sessions.length} 个会话` }),
            actionButton(view.paused ? '继续实时更新' : '暂停实时更新', togglePause, {
                className: 'secondary',
                disabled: !runtime.state.currentSessionId || (view.selectedSession && view.selectedSession !== runtime.state.currentSessionId),
            }),
        ));
        const format = h('select', { dataset: { control: 'export-format' } },
            option('log', 'LOG 文本', view.exportFormat === 'log'),
            option('json', 'JSON', view.exportFormat === 'json'),
        );
        format.addEventListener('change', () => { view.exportFormat = format.value; view.completedAction = ''; render(); });
        root.append(h('div', { className: 'actions log-actions' },
            h('label', { className: 'log-export-format' }, '格式', format),
            actionButton(completedLabel('export-filtered', '导出文件'), () => {
                const records = filtered();
                void run(() => exportDownload(records, view.exportFormat, 'export-filtered'), { progress: `正在选择 ${view.exportFormat.toUpperCase()} 保存位置…` });
            }, { className: 'secondary' }),
            actionButton(completedLabel('copy-filtered', '复制到剪贴板'), () => {
                const records = filtered();
                void run(() => exportCopy(records, view.exportFormat, 'copy-filtered'), { progress: `正在复制 ${view.exportFormat.toUpperCase()}…` });
            }, { className: 'secondary' }),
            actionButton('清空日志', () => {
                void run(async () => {
                    const confirmed = await confirmDanger(target.ownerDocument, {
                        title: '清空日志',
                        message: '将永久删除 TT-Toolkit 的全部日志会话，确定继续吗？',
                        confirmLabel: '确认清空',
                    });
                    if (!confirmed)
                        return;
                    await runtime.clearLogs();
                    view.selectedSession = runtime.state.currentSessionId ?? '';
                    await reloadSession();
                });
            }, { className: 'danger-button' }),
        ), logActionStatus());
        root.append(...logList());
        target.replaceChildren(root);
        if (focusControl) {
            const control = target.querySelector(`[data-control="${focusControl}"]`);
            control?.focus();
            if (control instanceof HTMLInputElement)
                control.setSelectionRange(control.value.length, control.value.length);
        }
    }

    const unsubscribe = runtime.subscribe(() => render());
    render();
    void run(async () => {
        await reloadSession();
        await runtime.refreshHostConsoleCaptureStatus();
    });
    return () => {
        disposed = true;
        notices.dispose();
        if (actionNoticeTimer !== null)
            clearTimeout(actionNoticeTimer);
        actionNoticeTimer = null;
        unsubscribe();
        target.replaceChildren();
    };
}
