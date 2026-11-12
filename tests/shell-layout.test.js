import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultShellSettings, parseShellSettings } from '../src/kernel/settings.js';

let ShellController;
let shell;
let saved;
let host;
let log;
const cssLoading = window.happyDOM.settings.disableCSSFileLoading;
const loadingSuccess = window.happyDOM.settings.handleDisabledFileLoadingAsSuccess;

beforeEach(async () => {
    window.happyDOM.settings.disableCSSFileLoading = true;
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.resetModules();
    ({ ShellController } = await import('../src/shell/controller.js'));
    saved = defaultShellSettings();
    host = {
        globalGet: vi.fn(async () => structuredClone(saved)),
        globalSet: vi.fn(async (_key, value) => { saved = structuredClone(value); }),
    };
    log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
});
afterEach(() => {
    shell?.dispose();
    shell = null;
    vi.unstubAllGlobals();
    window.happyDOM.settings.disableCSSFileLoading = cssLoading;
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = loadingSuccess;
});

async function start() {
    shell = new ShellController(host, [], { scoped: () => log });
    await shell.initialize();
    shell.openWorkbench();
    return document.getElementById('tt-toolkit-frame').contentDocument;
}
function button(doc, label) {
    return [...doc.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
}

describe('mobile workspace settings', () => {
    it('upgrades known old settings without borrowing desktop coordinates and round-trips independent layouts', () => {
        const old = defaultShellSettings();
        delete old.workspace.mobile;
        old.workspace.position = { x: 400, y: 200 };
        const next = parseShellSettings(old);
        expect(next.workspace.mobile).toEqual({ mode: 'fullscreen', position: null, size: null });
        next.workspace.mobile = { mode: 'floating', position: { x: 20, y: 80 }, size: { width: 280, height: 480 } };
        expect(parseShellSettings(JSON.parse(JSON.stringify(next))).workspace).toEqual(next.workspace);
    });
    it('upgrades the released layout without size, but rejects present invalid sizes', () => {
        const settings = defaultShellSettings();
        delete settings.workspace.mobile.size;
        expect(parseShellSettings(settings).workspace.mobile.size).toBeNull();
        for (const size of [undefined, [], {}, { width: 0, height: 480 }, { width: 260, height: Infinity }, { width: '260', height: 480 }, { width: 260, height: 480, extra: true }]) {
            settings.workspace.mobile.size = size;
            expect(() => parseShellSettings(settings)).toThrow('尺寸');
        }
    });
    it('reports an unknown mode but rejects damaged mobile layout structures and coordinates', () => {
        const settings = defaultShellSettings();
        settings.workspace.mobile.mode = 'unknown';
        const issues = [];
        expect(parseShellSettings(settings, issue => issues.push(issue)).workspace.mobile.mode).toBe('fullscreen');
        expect(issues).toEqual([{ field: 'workspace.mobile.mode', expected: 'fullscreen|floating', actualType: 'string', fallback: 'fullscreen' }]);
        for (const mobile of [null, undefined, [], {}, { mode: 'floating', position: { x: Infinity, y: 2 } }]) {
            settings.workspace.mobile = mobile;
            expect(() => parseShellSettings(settings)).toThrow();
        }
    });
});

describe('mobile workspace behavior (geometry verified separately in Chromium)', () => {
    it('remembers mode across restart, retains the floating position through fullscreen, and leaves desktop settings intact', async () => {
        saved.workspace.position = { x: 400, y: 200 };
        saved.workspace.mobile.position = { x: 20, y: 80 };
        saved.workspace.mobile.size = { width: 280, height: 480 };
        const doc = await start();
        button(doc, '切换为悬浮窗口').click();
        await vi.waitFor(() => expect(saved.workspace.mobile.mode).toBe('floating'));
        expect(saved.workspace.position).toEqual({ x: 400, y: 200 });
        expect(saved.workspace.size).toBe('standard');
        button(doc, '切换为全屏').click();
        await vi.waitFor(() => expect(saved.workspace.mobile.mode).toBe('fullscreen'));
        expect(saved.workspace.mobile.position).toEqual({ x: 20, y: 80 });
        expect(saved.workspace.mobile.size).toEqual({ width: 280, height: 480 });
        button(doc, '切换为悬浮窗口').click();
        await vi.waitFor(() => expect(saved.workspace.mobile.mode).toBe('floating'));
        shell.dispose();
        const restarted = await start();
        expect(button(restarted, '切换为全屏')).toBeDefined();
        expect([...restarted.querySelectorAll('button')].filter(node => node.getAttribute('aria-label') === '关闭工作台' || node.textContent === '关闭工作台')).toHaveLength(1);
        button(restarted, '关闭工作台').click();
        expect(document.getElementById('tt-toolkit-overlay').style.display).toBe('none');
        shell.openWorkbench();
        expect(button(restarted, '切换为全屏')).toBeDefined();
    });
    it('shows a recoverable save failure without leaking error details and lets the user retry', async () => {
        const doc = await start();
        host.globalSet.mockRejectedValueOnce(new Error('private storage detail'));
        button(doc, '切换为悬浮窗口').click();
        const status = doc.querySelector('[role="status"]');
        await vi.waitFor(() => expect(status.hidden).toBe(false));
        expect(status.textContent).toContain('重启后可能恢复旧布局');
        expect(saved.workspace.mobile.mode).toBe('fullscreen');
        expect(log.warn).toHaveBeenCalledWith('layout.save_failed', { data: expect.objectContaining({ reasonCode: 'LAYOUT_SETTINGS_SAVE_FAILED', result: 'layout_applied_not_saved', recoveryAction: 'retry_layout_save' }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private storage detail');
        button(doc, '重试保存布局').click();
        await vi.waitFor(() => expect(status.hidden).toBe(true));
        expect(saved.workspace.mobile.mode).toBe('floating');
    });
});

describe('workbench overlay mounting and dismissal', () => {
    it('mounts the workbench on the host document root in the top layer and closes it from Escape or an outside click', async () => {
        const doc = await start();
        const overlay = document.getElementById('tt-toolkit-overlay');
        expect(overlay.parentElement).toBe(document.documentElement);
        expect(overlay.style.getPropertyValue('z-index')).toBe('2147483647');
        expect(overlay.style.display).not.toBe('none');
        expect(document.getElementById('tt-toolkit-frame')).toBeTruthy();

        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(overlay.style.display).toBe('none');

        shell.openWorkbench();
        expect(overlay.style.display).not.toBe('none');
        doc.getElementById('tt-toolkit-frame-root').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(overlay.style.display).toBe('none');
    });

    it('keeps the workbench open when the active feature declines to leave', async () => {
        await start();
        const overlay = document.getElementById('tt-toolkit-overlay');
        const requestLeave = vi.fn(async () => false);
        shell.app = { hasLeaveGuard: () => true, requestLeave, unmount: vi.fn() };

        // 点击遮罩、按 Esc、悬浮球再次点击都会汇入 closeWorkbench。
        await shell.closeWorkbench();
        expect(requestLeave).toHaveBeenCalledOnce();
        expect(overlay.style.display).not.toBe('none');

        requestLeave.mockResolvedValue(true);
        await shell.closeWorkbench();
        expect(overlay.style.display).toBe('none');
    });
});
