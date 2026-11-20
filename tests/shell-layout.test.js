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

async function start(features = []) {
    shell = new ShellController(host, features, { scoped: () => log });
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

describe('workbench navigation', () => {
    const chat = { id: 'chat-data', label: '聊天数据', order: 10 };
    const settings = { id: 'settings', label: '设置', order: 20 };
    function feature(id, label, order, category, guard) {
        return {
            id, label, order, category, icon: '○',
            mount: (target, { setLeaveGuard }) => {
                const title = target.ownerDocument.createElement('h2');
                title.textContent = label;
                target.replaceChildren(title);
                if (guard)
                    setLeaveGuard(guard);
            },
        };
    }

    it('preserves keyboard focus in both navigation levels and announces the new page', async () => {
        const doc = await start([
            feature('chat-cleaner', '聊天清洗', 10, chat),
            feature('chat-viewer', '聊天查看', 20, chat),
        ]);
        const category = () => doc.querySelector('[data-category-id="chat-data"]');
        const second = () => doc.querySelector('[data-feature-id="chat-viewer"]');
        category().focus();
        category().click();
        await vi.waitFor(() => expect(doc.querySelector('main h2')?.textContent).toBe('聊天清洗'));
        expect(doc.activeElement).toBe(category());
        expect(category().getAttribute('aria-current')).toBe('page');
        expect(doc.querySelector('[aria-live="polite"]').textContent).toContain('聊天清洗');

        second().focus();
        second().click();
        await vi.waitFor(() => expect(doc.querySelector('main h2')?.textContent).toBe('聊天查看'));
        expect(doc.activeElement).toBe(second());
        expect(second().getAttribute('aria-current')).toBe('page');
        expect(doc.querySelector('[aria-live="polite"]').textContent).toContain('聊天查看');
    });

    it('keeps the current feature and draft when reselecting its category, but guards real navigation', async () => {
        saved.lastRoute = 'chat-viewer';
        const guard = vi.fn(async () => false);
        const doc = await start([
            feature('chat-cleaner', '聊天清洗', 10, chat),
            feature('chat-viewer', '聊天查看', 20, chat, guard),
            feature('toolkit-settings', '界面与入口', 10, settings),
        ]);
        host.globalSet.mockClear();
        const title = doc.querySelector('main h2');
        const category = doc.querySelector('[data-category-id="chat-data"]');
        category.focus();
        category.click();
        await Promise.resolve();
        expect(guard).not.toHaveBeenCalled();
        expect(doc.activeElement).toBe(category);
        expect(doc.querySelector('main h2')).toBe(title);
        expect(host.globalSet).not.toHaveBeenCalled();

        const other = doc.querySelector('[data-category-id="settings"]');
        other.focus();
        other.click();
        await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
        expect(doc.activeElement).toBe(other);
        expect(doc.querySelector('main h2')).toBe(title);
        expect(host.globalSet).not.toHaveBeenCalled();
    });

    it('puts focus on the named page when navigation replaces the focused overview card', async () => {
        const doc = await start([feature('chat-cleaner', '聊天清洗', 10, chat)]);
        const card = doc.querySelector('[data-overview-feature-id="chat-cleaner"]');
        card.focus();
        card.click();
        await vi.waitFor(() => expect(doc.querySelector('main h2')?.textContent).toBe('聊天清洗'));
        expect(doc.activeElement).toBe(doc.querySelector('main'));
        expect(doc.activeElement.getAttribute('aria-label')).toBe('聊天清洗');
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
        // 点击透过全幅 iframe 命中其 body，而不是定位窗口的挂载点。
        doc.body.click();
        expect(overlay.style.display).toBe('none');
    });

    it('does not dismiss from workbench content or while an iframe dialog is open', async () => {
        const doc = await start();
        const overlay = document.getElementById('tt-toolkit-overlay');
        doc.querySelector('main h1').click();
        expect(overlay.style.display).not.toBe('none');

        const dialog = doc.createElement('dialog');
        doc.body.append(dialog);
        dialog.showModal();
        dialog.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(overlay.style.display).not.toBe('none');
        dialog.click();
        doc.body.click();
        expect(overlay.style.display).not.toBe('none');
        dialog.close();
        dialog.remove();

        doc.body.click();
        expect(overlay.style.display).toBe('none');
    });

    it.each([{ isComposing: true }, { keyCode: 229 }])('lets the IME handle Escape (%j) without moving focus or asking to leave', async (imeSignal) => {
        const requestLeave = vi.fn(async () => false);
        saved.lastRoute = 'chat-cleaner';
        const doc = await start([{
            id: 'chat-cleaner', label: '聊天清洗', icon: 'x', order: 10,
            category: { id: 'chat-data', label: '聊天数据', order: 10 },
            mount: (target, { setLeaveGuard }) => {
                target.append(target.ownerDocument.createElement('textarea'));
                setLeaveGuard(requestLeave);
            },
        }]);
        const overlay = document.getElementById('tt-toolkit-overlay');
        const input = doc.querySelector('textarea');
        input.focus();
        const escape = init => input.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true, ...init,
        }));

        expect(escape(imeSignal)).toBe(true);
        expect(requestLeave).not.toHaveBeenCalled();
        expect(doc.activeElement).toBe(input);
        expect(overlay.style.display).not.toBe('none');

        escape();
        await vi.waitFor(() => expect(requestLeave).toHaveBeenCalledOnce());
        expect(overlay.style.display).not.toBe('none');
    });

    it('asks before dismissing via the backdrop and stays open if the feature declines', async () => {
        const requestLeave = vi.fn(async () => false);
        saved.lastRoute = 'chat-cleaner';
        const doc = await start([{
            id: 'chat-cleaner', label: '聊天清洗', icon: 'x', order: 10,
            category: { id: 'chat-data', label: '聊天数据', order: 10 },
            mount: (_target, { setLeaveGuard }) => setLeaveGuard(requestLeave),
        }]);
        const overlay = document.getElementById('tt-toolkit-overlay');

        doc.body.click();
        await vi.waitFor(() => expect(requestLeave).toHaveBeenCalledOnce());
        expect(overlay.style.display).not.toBe('none');

        requestLeave.mockResolvedValue(true);
        doc.body.click();
        await vi.waitFor(() => expect(overlay.style.display).toBe('none'));
    });
});
