import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';
import { defaultShellSettings, parseShellSettings } from '../src/kernel/settings.js';
import { ToolkitError } from '../src/kernel/errors.js';

let ShellController;
let shells = [];
const previousCssLoading = window.happyDOM.settings.disableCSSFileLoading;
const previousLoadingSuccess = window.happyDOM.settings.handleDisabledFileLoadingAsSuccess;
beforeEach(async () => {
    window.happyDOM.settings.disableCSSFileLoading = true;
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    ({ ShellController } = await import('../src/shell/controller.js'));
});
afterEach(() => {
    shells.forEach(shell => shell.dispose());
    shells = [];
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    window.happyDOM.settings.disableCSSFileLoading = previousCssLoading;
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = previousLoadingSuccess;
});

function hostMenu() {
    document.body.innerHTML = '<button id="extensionsMenuButton">魔棒</button><div id="extensionsMenu"><div id="other-entry">其它工具</div></div>';
    const host = new TauriTavernHost();
    host.extensionsModule = {
        ensureExtensionsUiReady: vi.fn(async () => undefined),
        showHideExtensionsMenu: vi.fn(),
    };
    return host;
}
function controller(host = hostMenu()) {
    host.globalSet = vi.fn(async () => undefined);
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    const shell = new ShellController(host, [], { scoped: () => log });
    shell.settings = defaultShellSettings();
    shell.mountLauncher();
    shell.overlay = document.createElement('div');
    shell.overlay.style.display = 'none';
    shell.workspace = document.createElement('div');
    shells.push(shell);
    return { shell, host, log };
}

describe('toolkit entry settings schema', () => {
    it('defaults and explicitly upgrades known old v1 settings to floating', () => {
        expect(parseShellSettings(undefined).entryMode).toBe('floating');
        const old = defaultShellSettings();
        delete old.entryMode;
        expect(parseShellSettings(old).entryMode).toBe('floating');
        for (const entryMode of ['floating', 'wand', 'both'])
            expect(parseShellSettings({ ...old, entryMode }).entryMode).toBe(entryMode);
    });
    it('degrades unrecognized enum values with a report while still rejecting damaged schema', () => {
        // 取值异常只影响观感：回退到安全默认并上报，不阻断启动。
        for (const entryMode of [null, undefined, '', 'magic', 1, {}, false]) {
            const issues = [];
            const settings = parseShellSettings({ ...defaultShellSettings(), entryMode }, issue => issues.push(issue));
            expect(settings.entryMode).toBe('floating');
            expect(issues).toEqual([{
                field: 'entryMode',
                expected: 'floating|wand|both',
                actualType: typeof entryMode,
                fallback: 'floating',
            }]);
        }
        const sizeIssues = [];
        expect(parseShellSettings({ ...defaultShellSettings(), workspace: { position: null, size: 'huge' } }, issue => sizeIssues.push(issue))
            .workspace.size).toBe('standard');
        expect(sizeIssues.map(issue => issue.field)).toEqual(['workspace.size']);

        // 结构损坏仍然显式报错，不静默猜测。
        expect(() => parseShellSettings({ ...defaultShellSettings(), schemaVersion: 99 })).toThrow('不支持');
        expect(() => parseShellSettings({ ...defaultShellSettings(), enabledFeatures: [] })).toThrow('enabledFeatures');
    });
});

describe('verified host wand adapter', () => {
    it('awaits menu readiness, mounts an accessible entry, bubbles clicks, and cleans up only its own entry', async () => {
        const host = hostMenu();
        const open = vi.fn();
        const bubble = vi.fn();
        document.getElementById('extensionsMenu').addEventListener('click', bubble);
        const entry = await host.mountToolkitWandEntry(open);
        expect(host.extensionsModule.ensureExtensionsUiReady).toHaveBeenCalledOnce();
        expect(entry.element.textContent.trim().length).toBeGreaterThan(0);
        expect(entry.element.getAttribute('role')).toBe('button');
        expect(entry.element.tabIndex).toBe(0);
        entry.element.click();
        entry.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        entry.element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
        expect(open).toHaveBeenCalledTimes(3);
        expect(open).toHaveBeenCalledWith(document.getElementById('extensionsMenuButton'));
        expect(bubble).toHaveBeenCalledTimes(3);
        entry.dispose();
        entry.element.click();
        expect(open).toHaveBeenCalledTimes(3);
        expect(document.getElementById('tt-toolkit-wand-entry')).toBeNull();
        expect(document.getElementById('other-entry')).not.toBeNull();
        expect(host.extensionsModule.showHideExtensionsMenu).toHaveBeenCalledTimes(2);
    });
    it('rejects missing exports, missing DOM, duplicate entries, and readiness failures', async () => {
        const host = hostMenu();
        host.extensionsModule.ensureExtensionsUiReady = undefined;
        await expect(host.mountToolkitWandEntry(vi.fn())).rejects.toMatchObject({
            code: 'HOST_WAND_EXPORT_MISSING',
            message: expect.stringContaining('重载宿主无法恢复'),
        });
        host.extensionsModule.ensureExtensionsUiReady = vi.fn(async () => undefined);
        document.getElementById('extensionsMenu').remove();
        await expect(host.mountToolkitWandEntry(vi.fn())).rejects.toMatchObject({ code: 'HOST_WAND_DOM_MISSING' });
        const readyHost = hostMenu();
        const entry = await readyHost.mountToolkitWandEntry(vi.fn());
        await expect(readyHost.mountToolkitWandEntry(vi.fn())).rejects.toMatchObject({ code: 'HOST_WAND_ENTRY_DUPLICATE' });
        entry.dispose();
        readyHost.extensionsModule.ensureExtensionsUiReady.mockRejectedValue(new Error('private details'));
        await expect(readyHost.mountToolkitWandEntry(vi.fn())).rejects.toThrow('private details');
        expect(document.getElementById('tt-toolkit-wand-entry')).toBeNull();
    });
});

describe('shell entry switching', () => {
    it('switches modes without duplicating entries and keeps the same workspace with proper return focus', async () => {
        const { shell, host } = controller();
        const workspace = shell.workspace;
        await shell.setEntryMode('wand');
        expect(shell.launcher.style.display).toBe('none');
        document.getElementById('tt-toolkit-wand-entry').click();
        expect(shell.overlay.style.display).toBe('block');
        expect(shell.workspace).toBe(workspace);
        shell.closeWorkbench();
        expect(document.activeElement.id).toBe('extensionsMenuButton');
        await shell.setEntryMode('both');
        await shell.setEntryMode('both');
        expect(document.querySelectorAll('#tt-toolkit-wand-entry')).toHaveLength(1);
        expect(shell.launcher.style.display).toBe('block');
        await shell.setEntryMode('floating');
        expect(document.getElementById('tt-toolkit-wand-entry')).toBeNull();
        expect(host.globalSet).toHaveBeenLastCalledWith('shell-settings-v1', expect.objectContaining({ entryMode: 'floating' }));
    });
    it('reports a host build without the wand exports as a capability gap instead of a retryable failure', async () => {
        const { shell, host, log } = controller();
        host.mountToolkitWandEntry = vi.fn().mockRejectedValue(new ToolkitError('HOST_WAND_EXPORT_MISSING', 'secret'));
        await expect(shell.setEntryMode('wand')).rejects.toThrow();
        expect(log.warn).toHaveBeenCalledWith('entry.failed', { data: expect.objectContaining({
            reasonCode: 'HOST_WAND_EXPORT_MISSING', result: 'previous_entry_retained',
            recoveryAction: 'upgrade_or_replace_host_build', hostAbiVersion: null,
        }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
        shell.disposeLauncherDrag();
        shell.launcher.remove();
        host.globalGet = vi.fn(async () => ({ ...defaultShellSettings(), entryMode: 'wand' }));
        shell.mountWorkbench = vi.fn(async () => undefined);
        await shell.initialize();
        expect(shell.entryWarning).toContain('已保留悬浮球');
        expect(shell.entryWarning).toContain('升级或更换宿主构建');
        expect(shell.entryWarning).not.toContain('重载宿主');
    });
    it('preserves previous entrances and mode on setup or persistence failure, logs safe warn diagnostics', async () => {
        const { shell, host, log } = controller();
        host.mountToolkitWandEntry = vi.fn().mockRejectedValue(new ToolkitError('HOST_WAND_DOM_MISSING', 'secret'));
        await expect(shell.setEntryMode('wand')).rejects.toThrow();
        expect(shell.settings.entryMode).toBe('floating');
        expect(shell.launcher.style.display).not.toBe('none');
        expect(host.globalSet).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith('entry.failed', { data: expect.objectContaining({
            reasonCode: 'HOST_WAND_DOM_MISSING', phase: 'change', result: 'previous_entry_retained',
            sourceLocation: 'src/shell/controller.js', hostAbiVersion: null,
            recoveryAction: 'retry_settings_or_reload',
        }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
        host.mountToolkitWandEntry = TauriTavernHost.prototype.mountToolkitWandEntry;
        host.globalSet.mockRejectedValue(new Error('sensitive storage details'));
        await expect(shell.setEntryMode('wand')).rejects.toMatchObject({ code: 'ENTRY_SETTINGS_SAVE_FAILED' });
        expect(shell.settings.entryMode).toBe('floating');
        expect(document.getElementById('tt-toolkit-wand-entry')).toBeNull();
        host.globalSet.mockResolvedValue(undefined);
        await shell.setEntryMode('wand');
        host.globalSet.mockRejectedValue(new Error('save failed'));
        await expect(shell.setEntryMode('floating')).rejects.toThrow();
        expect(shell.settings.entryMode).toBe('wand');
        expect(document.getElementById('tt-toolkit-wand-entry')).not.toBeNull();
        expect(shell.launcher.style.display).toBe('none');
    });
    it('retains a visible recovery launcher if the saved wand entrance cannot initialize', async () => {
        const { shell, host, log } = controller();
        shell.disposeLauncherDrag();
        shell.launcher.remove();
        host.globalGet = vi.fn(async () => ({ ...defaultShellSettings(), entryMode: 'wand' }));
        shell.mountWorkbench = vi.fn(async () => undefined);
        host.mountToolkitWandEntry = vi.fn().mockRejectedValue(new Error('unknown sensitive details'));
        await shell.initialize();
        expect(shell.settings.entryMode).toBe('wand');
        expect(shell.launcher.style.display).not.toBe('none');
        expect(shell.entryWarning).toContain('已保留悬浮球');
        expect(log.warn).toHaveBeenCalledWith('entry.failed', { data: expect.objectContaining({ reasonCode: 'ENTRY_SETUP_FAILED', result: 'floating_retained' }) });
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('unknown sensitive');
    });
    it('restores a saved wand choice and removes listeners and entries when disposed', async () => {
        const { shell, host } = controller();
        shell.disposeLauncherDrag();
        shell.launcher.remove();
        host.globalGet = vi.fn(async () => ({ ...defaultShellSettings(), entryMode: 'wand' }));
        shell.mountWorkbench = vi.fn(async () => undefined);
        await shell.initialize();
        expect(shell.launcher.style.display).toBe('none');
        const entry = shell.wandEntry.element;
        shell.dispose();
        entry.click();
        expect(shell.overlay.style.display).toBe('none');
        expect(document.getElementById('tt-toolkit-wand-entry')).toBeNull();
    });
});

