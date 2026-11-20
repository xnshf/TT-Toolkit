import { actionButton, callout, h } from '../../ui/dom.js';
import { searchField } from '../../ui/search-field.js';
import { errorMessage } from '../../kernel/errors.js';
import { logFileExportFailure } from '../../kernel/file-export.js';
import { MIB } from '../../kernel/logging/schema.js';
import { confirmDanger } from '../../ui/confirm.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';
import { unsavedChangesGuard } from '../../ui/leave-guard.js';
import { createLogList } from './log-list.js';
import { createLogHistory, historyWarnings, sessionLabel } from './log-history.js';
import { createSettingsForm, LEVELS } from './settings-form.js';

import { confirmPartialLogs, copyText, exportFilename, isMemorySession } from './log-export.js';

function option(value, text, selected = false) {
    return h('option', { value, text, selected });
}

function setText(element, text) {
    if (element.textContent !== text)
        element.textContent = text;
}

// 使用锚点保持原有 grid 布局，仅替换发生变化的提示，不移动相邻控件。
function slot(document) {
    const anchor = document.createComment('log-slot');
    let nodes = [];
    let shown;
    return {
        anchor,
        update(key, build) {
            if (key === shown)
                return;
            shown = key;
            nodes.forEach(node => node.remove());
            nodes = build().filter(Boolean);
            anchor.before(...nodes);
        },
    };
}

function optionUpdater(select, emptyLabel) {
    let previousOptions;
    return (options, selected) => {
        const key = JSON.stringify(options);
        if (previousOptions !== key) {
            previousOptions = key;
            select.replaceChildren(option('', emptyLabel), ...options.map(([value, label]) => option(value, label)));
        }
        const value = options.some(([value]) => value === selected) ? selected : '';
        if (select.value !== value)
            select.value = value;
    };
}

export function mountDeveloperLogsPage(target, props) {
    const runtime = props.runtime;
    const log = props.log ?? null;
    const featureCatalog = [{ id: 'system', label: '系统' }, ...(props.featureCatalog ?? [])];
    const featureLabels = new Map(featureCatalog.map(feature => [feature.id, feature.label]));
    const reportFailure = (event, operation, error) => {
        logFileExportFailure(log, event, operation, error, 'developer-logs/DeveloperLogsPage.js');
    };
    const view = {
        enabled: props.enabled,
        draft: structuredClone(runtime.state.settings),
        maxMiB: runtime.state.settings.maxBytes / MIB,
        selectedSession: runtime.state.currentSessionId ?? runtime.state.sessions.at(-1)?.id ?? '',
        levels: { debug: true, info: true, warn: true, error: true },
        featureFilter: '',
        sourceFilter: '',
        search: '',
        exportFormat: 'log',
        exporting: false,
        page: 0,
        expanded: null,
        actionNotice: null,
        completedAction: '',
        paused: false,
        pausedEntries: [],
    };
    let disposed = false;
    let actionNoticeTimer = null;
    const notices = createNoticeController(() => renderNotices());
    const history = createLogHistory(runtime, () => renderRuntime());

    // 日志设置只有点“保存设置”才落盘；容量输入是独立的 MiB 数值，需要并回草稿再比较。
    props.setLeaveGuard?.(unsavedChangesGuard(target.ownerDocument, {
        isDirty: () => JSON.stringify({ ...view.draft, maxBytes: Math.round(view.maxMiB * MIB) }) !== JSON.stringify(runtime.state.settings),
        title: '有未保存的日志设置',
        message: '隐私模式、最低记录级别或容量上限的改动尚未保存，继续离开不会写入。已记录的日志不会被删除。',
    }));

    function setActionNotice(notice) {
        if (actionNoticeTimer !== null)
            clearTimeout(actionNoticeTimer);
        actionNoticeTimer = null;
        view.actionNotice = notice;
        if (notice && (notice.kind === 'success' || notice.kind === 'neutral')) {
            actionNoticeTimer = setTimeout(() => {
                actionNoticeTimer = null;
                view.actionNotice = null;
                renderNotices();
            }, notice.kind === 'success' ? 4500 : 3000);
        }
    }

    const selectedSessions = () => view.selectedSession
        ? runtime.state.sessions.filter(session => session.id === view.selectedSession)
        : runtime.state.sessions;
    const entries = () => selectedSessions().flatMap(session => {
        const { currentSessionId, stoppedMemorySession } = runtime.state;
        const sessionEntries = session.id === currentSessionId
            ? view.paused ? view.pausedEntries : runtime.state.currentEntries
            : history.entries(session.id) ?? (session.id === stoppedMemorySession?.id ? stoppedMemorySession.entries : []);
        return sessionEntries.map(event => ({ sessionId: session.id, event }));
    });
    const filtered = (records = entries()) => {
        const query = view.search.toLowerCase();
        return records.filter(({ event }) => view.levels[event.level]
            && (!view.featureFilter || event.featureId === view.featureFilter)
            && (!view.sourceFilter || event.source === view.sourceFilter)
            && (!query || JSON.stringify(event).toLowerCase().includes(query)));
    };

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
        view.pausedEntries = [];
        view.page = 0;
        view.expanded = null;
        await history.reload(selectedSessions().filter(session => session.id !== runtime.state.currentSessionId));
    }

    function togglePause() {
        // 内核只增删事件，不修改已记录事件对象。保留引用以复用仍可见的行。
        view.pausedEntries = view.paused ? [] : runtime.state.currentEntries.slice();
        view.paused = !view.paused;
        renderViewer();
    }

    async function withExportRecords(action) {
        const sessions = selectedSessions();
        if (sessions.some(history.pending)) {
            setActionNotice({ kind: 'neutral', text: '正在读取历史会话，请稍后再试。' });
            return;
        }
        const records = entries();
        const matches = filtered(records);
        const confirmation = confirmPartialLogs(target.ownerDocument, runtime.state, sessions, records, history.issues(sessions), matches.length);
        if (confirmation && (!await confirmation || disposed)) {
            setActionNotice(null);
            return;
        }
        const available = new Set(runtime.state.sessions.map(session => session.id));
        if (sessions.some(session => !available.has(session.id))) {
            setActionNotice({ kind: 'error', text: '输出范围内的会话已变化，请重新选择后再试。' });
            return;
        }
        await action(matches);
    }

    async function exportDownload(records, format, actionId) {
        log?.info?.('export.file_started', { data: {
            operation: 'export.file', stage: 'export.serialize', format, recordCount: records.length,
            sourceLocation: 'developer-logs/DeveloperLogsPage.js', outcome: 'pending',
        } });
        let text;
        try {
            text = runtime.exportEntries(records, format);
        }
        catch (error) {
            reportFailure('export.serialize_failed', 'export.serialize', error);
            throw error;
        }
        try {
            const result = await props.exportFile(text, exportFilename(format), format === 'json' ? 'application/json' : 'text/plain;charset=utf-8');
            log?.info?.('export.file_completed', { data: {
                operation: 'export.file', stage: 'export.result', format, recordCount: records.length,
                mode: result.mode, outcome: result.status, sourceLocation: 'developer-logs/DeveloperLogsPage.js',
            } });
            setActionNotice({ kind: result.status === 'saved' ? 'success' : 'neutral', text: result.message });
            if (result.status !== 'cancelled')
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

    function toolbar() {
        const features = h('select', { dataset: { control: 'feature-filter' }, attrs: { 'aria-label': '按功能筛选日志' } },
            option('', '全部功能', !view.featureFilter),
            featureCatalog.map(feature => option(feature.id, feature.label, view.featureFilter === feature.id)),
        );
        features.addEventListener('change', () => { view.featureFilter = features.value; view.page = 0; renderViewer(); });
        const sessions = h('select', { dataset: { control: 'session-filter' }, ariaLabel: '选择日志会话' });
        sessions.addEventListener('change', () => {
            view.selectedSession = sessions.value;
            void run(reloadSession);
        });
        const source = h('select', { dataset: { control: 'source-filter' }, ariaLabel: '按来源筛选日志' });
        source.addEventListener('change', () => { view.sourceFilter = source.value; view.page = 0; renderViewer(); });
        const search = searchField({
            value: view.search,
            placeholder: '搜索事件或数据',
            ariaLabel: '搜索日志事件或数据',
            dataset: { control: 'search' },
            onQuery: value => {
                view.search = value;
                view.page = 0;
                renderViewer();
            },
        });
        return {
            element: h('div', { className: 'log-toolbar' }, features, sessions, source, search),
            updateSessions: optionUpdater(sessions, '全部会话'),
            updateSources: optionUpdater(source, '全部来源'),
        };
    }

    const root = h('section', { className: 'feature-page developer-logs-page' });
    const toggle = h('input', { type: 'checkbox', checked: view.enabled, dataset: { control: 'enabled' } });
    const enabledStatus = h('span');
    toggle.addEventListener('change', () => {
        const next = toggle.checked;
        void run(async () => {
            try {
                await props.setEnabled(next);
                view.enabled = next;
            }
            finally {
                toggle.checked = view.enabled;
            }
        });
    });
    root.append(h('header', { className: 'feature-header' },
        h('div', {},
            h('p', { className: 'eyebrow', text: '设置' }),
            h('h2', { text: '日志' }),
            h('p', { text: '记录、筛选并导出 TT-Toolkit 的结构化诊断事件。' }),
        ),
        h('label', { className: 'master-toggle' }, toggle, enabledStatus),
    ));
    const privacyWarning = slot(target.ownerDocument);
    const warnings = slot(target.ownerDocument);
    const notice = slot(target.ownerDocument);
    const resultNotice = slot(target.ownerDocument);
    const settings = createSettingsForm({
        draft: view.draft,
        maxMiB: view.maxMiB,
        onEdit(patch, maxMiB = view.maxMiB) {
            Object.assign(view.draft, patch);
            view.maxMiB = maxMiB;
            renderStatus();
        },
    });
    function applySavedSettings() {
        view.draft = structuredClone(runtime.state.settings);
        view.maxMiB = view.draft.maxBytes / MIB;
        settings.apply(view.draft, view.maxMiB);
    }
    const used = h('span');
    const sessionCount = h('span');
    const hostCapture = h('span', {}, '宿主 console 捕获：请在宿主设置中查看');
    root.append(privacyWarning.anchor, warnings.anchor, notice.anchor, settings.element,
        h('div', { className: 'log-summary' }, used, sessionCount, hostCapture),
        h('div', { className: 'actions' },
            actionButton('重置设置', () => { void run(async () => {
                await runtime.resetSettings();
                applySavedSettings();
                notices.show('日志设置已重置。', 'success');
            }); }, { className: 'secondary', dataset: { control: 'reset-settings' } }),
            actionButton('保存设置', () => { void run(async () => {
                await runtime.saveSettings({ ...view.draft, maxBytes: Math.round(view.maxMiB * MIB) });
                applySavedSettings();
                notices.show('日志设置已保存。隐私模式变化时已自动开启新会话。', 'success');
            }); }, { className: 'primary', dataset: { control: 'save-settings' } }),
        ));
    const filters = toolbar();
    const historyNotice = slot(target.ownerDocument);
    const eventCount = h('span');
    const pause = actionButton('', togglePause, { className: 'secondary', dataset: { control: 'pause' } });
    root.append(h('hr'), filters.element,
        h('div', { className: 'log-levels' }, LEVELS.map(level => {
            const checkbox = h('input', { type: 'checkbox', checked: view.levels[level], dataset: { control: `level-${level}` } });
            checkbox.addEventListener('change', () => { view.levels[level] = checkbox.checked; view.page = 0; renderViewer(); });
            return h('label', {}, checkbox, level);
        })),
        h('div', { className: 'log-summary' }, eventCount, pause), historyNotice.anchor,
    );
    const format = h('select', { dataset: { control: 'export-format' } },
        option('log', 'LOG 文本', view.exportFormat === 'log'),
        option('json', 'JSON', view.exportFormat === 'json'),
    );
    format.addEventListener('change', () => { view.exportFormat = format.value; view.completedAction = ''; renderNotices(); });
    const exportButton = actionButton('', () => {
        if (view.exporting)
            return;
        const format = view.exportFormat;
        view.exporting = true;
        void run(async () => {
            try { await withExportRecords(records => exportDownload(records, format, 'export-filtered')); }
            finally { view.exporting = false; }
        }, { progress: `正在导出 ${format.toUpperCase()} 文件…` });
    }, { className: 'secondary', dataset: { control: 'export-file' } });
    const copyButton = actionButton('', () => {
        const format = view.exportFormat;
        void run(() => withExportRecords(records => exportCopy(records, format, 'copy-filtered')), { progress: `正在复制 ${format.toUpperCase()}…` });
    }, { className: 'secondary', dataset: { control: 'copy' } });
    const clearButton = actionButton('清空日志', () => {
        void run(async () => {
            const confirmed = await confirmDanger(target.ownerDocument, {
                title: '清空日志',
                message: '将永久删除 TT-Toolkit 的全部日志会话，确定继续吗？',
                confirmLabel: '确认清空',
            });
            if (!confirmed)
                return;
            try { await runtime.clearLogs(); }
            catch { throw new Error('清空日志未完成，请检查日志存储后重试。如提示空索引写入失败，请重新加载工具箱。'); }
            view.selectedSession = runtime.state.currentSessionId ?? '';
            await reloadSession();
        });
    }, { className: 'danger-button', dataset: { control: 'clear' } });
    const logList = createLogList({
        featureLabels,
        onToggle(key) { view.expanded = view.expanded === key ? null : key; renderViewer(); },
        onPrevious() { view.page -= 1; renderViewer(); },
        onNext() { view.page += 1; renderViewer(); },
    });
    root.append(h('div', { className: 'actions log-actions' },
        h('label', { className: 'log-export-format' }, '格式', format), exportButton, copyButton, clearButton,
    ), resultNotice.anchor, ...logList.elements);

    function renderStatus() {
        const { sessions, hostFrontendStatus: hostStatus, configurationError, legacyLogsDetected, persistenceError } = runtime.state;
        const issues = [
            hostStatus?.phase === 'unavailable' && [`宿主前端日志不可用：${hostStatus.message}。日志功能无法启动，其它工具不受影响。`, 'danger'],
            hostStatus?.phase === 'degraded' && [`宿主日志流已停止：${hostStatus.message || '运行期宿主日志契约错误'}。当前会话继续记录 TT-Toolkit 自身事件，不会自动重连；请关闭后重新启用日志。`, 'warning'],
            configurationError && [`日志设置损坏：${configurationError}`, 'danger'],
            legacyLogsDetected && ['检测到旧版日志结构。旧日志不会被推断归类；请清空日志后重新启用记录。', 'danger'],
            persistenceError && [persistenceError, 'danger'],
        ].filter(Boolean);
        hasRuntimeIssues = issues.length > 0;
        warnings.update(JSON.stringify(issues), () => issues.map(([message, kind]) => callout(message, kind)));
        const full = view.draft.privacyMode === 'full';
        privacyWarning.update(full, () => full ? [callout('完整模式会记录相关聊天正文、规则和 before/after，导出文件可能包含敏感内容。', 'danger')] : []);
        setText(enabledStatus, view.enabled ? '记录中' : '已关闭');
        const usedBytes = sessions.reduce((sum, session) => sum + session.bytes, 0);
        setText(used, `已用 ${(usedBytes / MIB).toFixed(2)} / ${view.maxMiB} MiB`);
        setText(sessionCount, `${sessions.length} 个会话`);
    }

    function renderNotices() {
        if (disposed)
            return;
        notice.update(notices.current, () => [noticeBanner(notices.current, () => notices.clear(true))]);
        resultNotice.update(view.actionNotice, () => [logActionStatus()]);
        setText(exportButton, completedLabel('export-filtered', '导出文件'));
        setText(copyButton, completedLabel('copy-filtered', '复制到剪贴板'));
        if (exportButton.disabled !== view.exporting)
            exportButton.disabled = view.exporting;
    }

    function renderViewer() {
        const { sessions, currentSessionId } = runtime.state;
        const records = entries();
        const results = filtered(records);
        const issues = history.issues(selectedSessions());
        const loading = selectedSessions().some(history.pending);
        historyNotice.update(JSON.stringify([loading, issues]), () => [
            loading ? callout('正在读取历史会话…', 'neutral') : null, ...historyWarnings(issues),
        ]);
        filters.updateSessions(sessions.map((session, index) => [session.id, `${sessionLabel(index)} · ${session.startedAt} · ${session.privacyMode}${session.interrupted ? ' · 中断' : ''}`]), view.selectedSession);
        const sources = [...new Set(records.map(({ event }) => event.source))].sort();
        filters.updateSources(sources.map(value => [value, value]), view.sourceFilter);
        const selected = sessions.find(session => session.id === view.selectedSession);
        const count = isMemorySession(runtime.state, selected) || (selected && issues.length)
            ? `当前可读 ${records.length} / 共记录 ${selected.eventCount} 条` : `${selected?.eventCount} 条事件`;
        setText(eventCount, selected
            ? `${count} · ${(selected.bytes / 1024).toFixed(1)} KiB · 已淘汰 ${(selected.droppedBytes / 1024).toFixed(1)} KiB`
            : `${results.length} 条匹配事件 · ${sessions.length} 个会话`);
        setText(pause, view.paused ? '继续实时更新' : '暂停实时更新');
        const disabled = !currentSessionId || Boolean(view.selectedSession && view.selectedSession !== currentSessionId);
        if (pause.disabled !== disabled)
            pause.disabled = disabled;
        view.page = logList.update(results, view.page, view.expanded, loading ? '正在读取历史日志。' : hasRuntimeIssues || issues.length ? '暂无匹配的日志。' : '没有匹配的日志。');
    }

    function renderRuntime() {
        if (disposed)
            return;
        renderStatus();
        renderViewer();
    }

    function render() {
        renderRuntime();
        renderNotices();
    }

    let hasRuntimeIssues = false;
    target.replaceChildren(root);
    let stoppedSession = runtime.state.stoppedMemorySession;
    const unsubscribe = runtime.subscribe(() => {
        const stopped = runtime.state.stoppedMemorySession;
        if (stopped !== stoppedSession) {
            if (stoppedSession)
                history.forget(stoppedSession.id);
            stoppedSession = stopped;
            if (stopped) {
                view.paused = false;
                view.pausedEntries = [];
                if (selectedSessions().some(session => session.id === stopped.id))
                    void history.load(stopped.id);
            }
        }
        renderRuntime();
    });
    render();
    void run(reloadSession);
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
