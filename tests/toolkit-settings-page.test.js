import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountToolkitSettingsPage } from '../src/features/toolkit-settings/index.js';
import { featureRegistrations } from '../src/features/registry.js';
import { ToolkitError } from '../src/kernel/errors.js';

const disposers = [];
afterEach(() => {
    disposers.splice(0).forEach(dispose => dispose());
    document.body.replaceChildren();
    vi.useRealTimers();
});

function setup(initial = { mode: 'floating', warning: '' }, initialTheme = 'host') {
    let state = { ...initial };
    let themeState = { theme: initialTheme, scheme: 'dark' };
    const entrySettings = {
        getState: () => ({ ...state }),
        setMode: vi.fn(async mode => { state = { mode, warning: '' }; }),
        resetLayout: vi.fn(),
    };
    const themeSettings = {
        getState: () => ({ ...themeState }),
        setTheme: vi.fn(async theme => { themeState = { theme, scheme: themeState.scheme }; }),
    };
    const target = document.createElement('div');
    document.body.append(target);
    const dispose = mountToolkitSettingsPage(target, { entrySettings, themeSettings });
    disposers.push(dispose);
    return {
        target, entrySettings, themeSettings, dispose,
        radio: mode => target.querySelector(`input[value="${mode}"]`),
        save: target.querySelector('.ttk-settings-save'),
        reset: target.querySelector('.ttk-settings-reset'),
        status: target.querySelector('.ttk-settings-status'),
        entryRadios: () => [...target.querySelectorAll('.ttk-settings-entry-grid input[type="radio"]')],
        themeRadios: () => [...target.querySelectorAll('.ttk-settings-theme-grid input[type="radio"]')],
    };
}

describe('card-based interface and entry settings', () => {
    it('registers under Settings as enabled by default', () => {
        expect(featureRegistrations.find(item => item.id === 'toolkit-settings'))
            .toMatchObject({ category: { id: 'settings' }, defaultEnabled: true });
    });
    it('uses three labelled native radio cards instead of a select, with Save before the choices', () => {
        const { target, radio, save, entryRadios } = setup({ mode: 'wand', warning: '' });
        expect(target.querySelector('select')).toBeNull();
        expect(entryRadios()).toHaveLength(3);
        expect(target.querySelector('legend').textContent).toBe('唤起入口方式');
        expect(radio('wand').checked).toBe(true);
        expect(radio('wand').labels[0].dataset.mode).toBe('wand');
        expect(radio('wand').getAttribute('aria-label')).toBe('魔棒菜单');
        expect(save.compareDocumentPosition(target.querySelector('fieldset')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(target.querySelector('.ttk-settings-status').textContent).toBe('当前生效：魔棒菜单');
    });
    it('distinguishes unsaved selection from active settings without saving on selection or replacing controls', async () => {
        const { radio, save, status, entrySettings } = setup();
        radio('both').labels[0].click();
        radio('both').focus();
        expect(radio('both').checked).toBe(true);
        expect(radio('floating').checked).toBe(false);
        expect(status.textContent).toContain('已选择：两者都显示（未保存）');
        expect(status.textContent).toContain('当前生效：悬浮球');
        expect(entrySettings.setMode).not.toHaveBeenCalled();
        const original = radio('both');
        save.click();
        await vi.waitFor(() => expect(save.textContent).toBe('已保存并生效'));
        expect(entrySettings.setMode).toHaveBeenCalledWith('both');
        expect(status.textContent).toBe('当前生效：两者都显示');
        expect(radio('both')).toBe(original);
        expect(document.activeElement).toBe(original);
    });
    it('locks choices and actions during save and rejects double submission', async () => {
        const { target, radio, save, reset, entrySettings } = setup();
        let finish;
        entrySettings.setMode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        radio('wand').click();
        save.click();
        save.click();
        expect(entrySettings.setMode).toHaveBeenCalledOnce();
        expect(save.textContent).toBe('正在保存……');
        expect(target.querySelector('.ttk-settings').getAttribute('aria-busy')).toBe('true');
        expect([...target.querySelectorAll('input')].every(input => input.disabled)).toBe(true);
        expect(reset.disabled).toBe(true);
        radio('both').click();
        expect(radio('wand').checked).toBe(true);
        finish();
        await vi.waitFor(() => expect(save.disabled).toBe(false));
        expect(reset.disabled).toBe(false);
        expect(target.querySelector('.ttk-settings').getAttribute('aria-busy')).toBe('false');
    });
    it('points a missing host wand capability at the host build instead of asking for a reload', async () => {
        const { target, radio, save, status, entrySettings } = setup();
        entrySettings.setMode.mockRejectedValueOnce(new ToolkitError('HOST_WAND_EXPORT_MISSING', 'private unknown detail'));
        radio('wand').click();
        save.click();
        await vi.waitFor(() => expect(target.textContent).toContain('未提供魔棒菜单接口'));
        expect(target.textContent).toContain('升级或更换 TauriTavern 构建');
        expect(target.textContent).not.toContain('重载宿主，并在');
        expect(target.textContent).not.toContain('private unknown detail');
        expect(radio('wand').checked).toBe(true);
        expect(status.textContent).toContain('当前生效：悬浮球');
        save.click();
        await vi.waitFor(() => expect(status.textContent).toBe('当前生效：魔棒菜单'));
    });
    it('preserves the draft for retry after a recoverable failure and does not leak unknown error details', async () => {
        const { target, radio, save, status, entrySettings } = setup();
        entrySettings.setMode.mockRejectedValueOnce(new ToolkitError('HOST_WAND_DOM_MISSING', 'private unknown detail'));
        radio('wand').click();
        save.click();
        await vi.waitFor(() => expect(target.textContent).toContain('宿主魔棒菜单挂载点缺失'));
        expect(target.textContent).not.toContain('private unknown detail');
        expect(radio('wand').checked).toBe(true);
        expect(status.textContent).toContain('当前生效：悬浮球');
        expect(save.disabled).toBe(false);
        save.click();
        await vi.waitFor(() => expect(status.textContent).toBe('当前生效：魔棒菜单'));
        expect(entrySettings.setMode).toHaveBeenNthCalledWith(2, 'wand');
        expect(target.textContent).not.toContain('入口切换失败');
    });
    it('does not falsely call a degraded saved wand entrance active and permits retrying the same mode', async () => {
        const { target, radio, status, save, entrySettings } = setup({ mode: 'wand', warning: '魔棒暂不可用，已保留悬浮球' });
        expect(status.textContent).toBe('已保存，入口待恢复：魔棒菜单');
        expect(radio('wand').checked).toBe(true);
        expect(save.disabled).toBe(false);
        expect(target.querySelector('.ttk-settings-warning').hidden).toBe(false);
        save.click();
        await vi.waitFor(() => expect(status.textContent).toBe('当前生效：魔棒菜单'));
        expect(entrySettings.setMode).toHaveBeenCalledWith('wand');
        expect(target.querySelector('.ttk-settings-warning').hidden).toBe(true);
    });
    it('expires success feedback and disposes timers while preserving persistent saved state', async () => {
        vi.useFakeTimers();
        const { target, radio, save, status, dispose } = setup();
        radio('both').click();
        save.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(target.querySelector('.feature-notice.success')).not.toBeNull();
        await vi.advanceTimersByTimeAsync(4500);
        expect(target.querySelector('.feature-notice')).toBeNull();
        expect(save.textContent).toBe('保存入口设置');
        expect(status.textContent).toBe('当前生效：两者都显示');
        save.click();
        await vi.advanceTimersByTimeAsync(0);
        dispose();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(4500);
        expect(target.childElementCount).toBe(0);
    });
    it('keeps error feedback until dismissed or retried and leaves saved settings unchanged', async () => {
        vi.useFakeTimers();
        const { target, radio, save, status, entrySettings } = setup();
        entrySettings.setMode.mockRejectedValueOnce(new Error('private details'));
        radio('both').click();
        save.click();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(6000);
        expect(target.querySelector('.feature-notice.warning')).not.toBeNull();
        expect(target.textContent).not.toContain('private details');
        target.querySelector('.notice-dismiss').click();
        expect(target.querySelector('.feature-notice')).toBeNull();
        expect(status.textContent).toContain('当前生效：悬浮球');
    });
    it('resets only layout, retaining unsaved choices and never claiming that layout reset saved the entry draft', () => {
        const { target, radio, status, save, reset, entrySettings } = setup();
        radio('both').click();
        reset.click();
        expect(entrySettings.resetLayout).toHaveBeenCalledOnce();
        expect(entrySettings.setMode).not.toHaveBeenCalled();
        expect(radio('both').checked).toBe(true);
        expect(status.textContent).toContain('未保存');
        expect(save.textContent).toBe('保存入口设置');
        expect(target.textContent).toContain('入口方式与功能设置保持不变');
    });
    it('does not remount the page when an in-flight save finishes after navigation', async () => {
        const { target, save, dispose, entrySettings } = setup();
        let finish;
        entrySettings.setMode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        save.click();
        dispose();
        finish();
        await Promise.resolve();
        expect(target.childElementCount).toBe(0);
    });
});
