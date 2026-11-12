import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountWorldInfoAiPage } from '../src/features/world-info-ai/WorldInfoAiPage.js';
import { confirmDanger } from '../src/ui/confirm.js';
import { serializeConfigExchange } from '../src/features/world-info-ai/schema.js';

vi.mock('../src/ui/confirm.js', () => ({ confirmDanger: vi.fn() }));

function makeRuntime() {
    const listeners = new Set();
    const state = {
        worldNames: ['Lore', 'Other'],
        activeWorlds: [{ name: 'Lore', source: 'character', routerEnabled: true, configuredAiEntries: 1, eligibleAiEntries: 1 }],
        activeWorldsError: '', selectedWorld: 'Lore',
        worldData: { entries: {
            1: { uid: 1, comment: 'Rain', content: 'rain body', order: 10 },
            2: { uid: 2, comment: 'Constant', content: 'always', constant: true, order: 5 },
            3: { uid: 3, comment: 'Vector', content: 'semantic', vectorized: true, order: 1 },
            4: { uid: 4, comment: 'Template', content: '@@if variables.ready\n<%- variables.x %>', order: 0 },
            5: { uid: 5, comment: 'Blocked', content: '@@dont_activate\nno activation', order: -1 },
        } },
        config: { schemaVersion: 2, enabled: true, entries: {
            1: { mode: 'ai', aiDescription: 'When rain is discussed', threshold: null },
            2: { mode: 'native', aiDescription: 'In the city', threshold: 0 },
            3: { mode: 'native', aiDescription: '', threshold: null },
        } },
        settings: { schemaVersion: 2, presetId: null, threshold: 0.7, historyRounds: 3, timeoutMs: 10000 },
        storageBackend: 'world-extension', activePresetId: 'p1',
        presetOptions: [{ id: 'p1', name: 'Decision', model: 'jev' }],
        presetError: '', settingsError: '', busy: false, testBusy: false,
        status: 'ready', warning: '', error: '', rounds: [],
    };
    const emit = () => { for (const listener of listeners) listener(state); };
    return {
        state, emit,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        refreshWorlds: vi.fn(async () => { emit(); }),
        selectWorld: vi.fn(async name => {
            state.selectedWorld = name;
            state.worldData = { entries: { 9: { uid: 9, comment: 'Other entry', content: 'other' } } };
            state.config = { schemaVersion: 2, enabled: false, entries: {} };
            emit();
        }),
        saveConfig: vi.fn(async value => { state.config = structuredClone(value); emit(); }),
        saveSettings: vi.fn(async value => { state.settings = structuredClone(value); emit(); }),
        resetSettings: vi.fn(async () => {
            state.settingsError = '';
            state.settings = { schemaVersion: 2, presetId: null, threshold: 0.7, historyRounds: 3, timeoutMs: 10000 };
            emit();
        }),
        resetConfig: vi.fn(async () => {
            state.config = { schemaVersion: 2, enabled: false, entries: {} }; state.error = ''; emit();
        }),
        testConditions: vi.fn(async () => undefined), cancelTest: vi.fn(),
        clearCache: vi.fn(), clearRounds: vi.fn(() => { state.rounds = []; emit(); }),
        exportConfig: vi.fn(async () => undefined),
    };
}
const disposers = [];
async function mount(runtime = makeRuntime()) {
    const target = document.createElement('div');
    document.body.append(target);
    const setEnabled = vi.fn(async () => undefined);
    disposers.push(mountWorldInfoAiPage(target, { runtime, enabled: true, setEnabled }));
    await vi.waitFor(() => expect(target.textContent).toContain('Rain'));
    await Promise.resolve();
    return { target, runtime, setEnabled };
}
const byControl = (target, key) => target.querySelector(`[data-control="${key}"]`);
const click = (target, text) => {
    const button = [...target.querySelectorAll('button')].find(node => node.textContent === text);
    expect(button, `button ${text}`).toBeTruthy();
    button.click();
};
function input(target, key, value, event = 'input') {
    const node = byControl(target, key);
    node.value = value;
    node.dispatchEvent(new Event(event, { bubbles: true }));
}
function check(target, key, value = true) {
    const node = byControl(target, key);
    node.checked = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => { vi.mocked(confirmDanger).mockReset().mockResolvedValue(true); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });

describe('decision activation management', () => {
    it('allows constant/vector takeover but keeps template and dont_activate entries native', async () => {
        const { target, runtime } = await mount();
        expect(byControl(target, 'mode-2').disabled).toBe(false);
        expect(byControl(target, 'mode-3').disabled).toBe(false);
        expect(byControl(target, 'mode-4').disabled).toBe(true);
        expect(byControl(target, 'mode-5').disabled).toBe(true);
        input(target, 'mode-2', 'ai', 'change');
        input(target, 'condition-3', 'A semantic topic');
        input(target, 'mode-3', 'ai', 'change');
        click(target, '保存世界书配置');
        await vi.waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledOnce());
        const saved = runtime.saveConfig.mock.calls[0][0];
        expect(saved.entries['2']).toEqual({ mode: 'ai', aiDescription: 'In the city', threshold: 0 });
        expect(saved.entries['3'].mode).toBe('ai');
        expect(saved.entries['4'].mode).toBe('native');
        expect(saved.entries['5'].mode).toBe('native');
    });

    it('preserves draft, focus, open body and save failure across runtime notifications', async () => {
        const { target, runtime } = await mount();
        const condition = byControl(target, 'condition-1');
        condition.focus();
        condition.value = 'unsaved condition';
        condition.setSelectionRange(3, 3);
        condition.dispatchEvent(new Event('input'));
        target.querySelector('[data-detail="body-1"]').open = true;
        runtime.saveConfig.mockRejectedValue(new Error('Write failed; retry'));
        click(target, '保存世界书配置');
        await vi.waitFor(() => expect(target.textContent).toContain('Write failed; retry'));
        runtime.state.config.entries['1'].aiDescription = 'runtime old value';
        runtime.state.status = 'new generation';
        runtime.emit();
        expect(byControl(target, 'condition-1').value).toBe('unsaved condition');
        expect(document.activeElement).toBe(byControl(target, 'condition-1'));
        expect(document.activeElement.selectionStart).toBe(3);
        expect(target.querySelector('[data-detail="body-1"]').open).toBe(true);
        expect(target.textContent).toContain('Write failed; retry');
        expect(target.textContent).toContain('条目配置未保存');
    });

    it('prompts before switching dirty worlds, supports cancellation and then loads the chosen book', async () => {
        const { target, runtime } = await mount();
        input(target, 'condition-1', 'draft');
        input(target, 'scope', 'all', 'change');
        vi.mocked(confirmDanger).mockResolvedValueOnce(false);
        input(target, 'world', 'Other', 'change');
        await vi.waitFor(() => expect(confirmDanger).toHaveBeenCalledOnce());
        expect(runtime.selectWorld).not.toHaveBeenCalled();
        expect(byControl(target, 'condition-1').value).toBe('draft');
        input(target, 'world', 'Other', 'change');
        await vi.waitFor(() => expect(target.textContent).toContain('Other entry'));
        expect(runtime.selectWorld).toHaveBeenCalledWith('Other');
        expect(target.textContent).not.toContain('Rain');
    });

    it('retains a dirty draft after external target changes and refuses writes to the wrong book', async () => {
        const { target, runtime } = await mount();
        input(target, 'condition-1', 'keep this draft');
        runtime.state.selectedWorld = 'Other';
        runtime.state.worldData = { entries: { 9: { uid: 9, comment: 'Other entry', content: 'x' } } };
        runtime.emit();
        expect(byControl(target, 'condition-1').value).toBe('keep this draft');
        click(target, '保存世界书配置');
        await vi.waitFor(() => expect(target.textContent).toContain('编辑目标已变化'));
        expect(runtime.saveConfig).not.toHaveBeenCalled();
        click(target, '重置当前世界书决策配置');
        await Promise.resolve();
        expect(runtime.resetConfig).not.toHaveBeenCalled();
        expect(confirmDanger).not.toHaveBeenCalled();
    });

    it('batch pause preserves conditions, discloses hidden selection, and clears only independent thresholds', async () => {
        const { target, runtime } = await mount();
        check(target, 'select-1');
        check(target, 'select-2');
        input(target, 'search', 'rain');
        expect(target.textContent).toContain('1 项被筛选隐藏');
        click(target, '批量暂停接管');
        await vi.waitFor(() => expect(byControl(target, 'mode-1').value).toBe('native'));
        input(target, 'batch-threshold', '1');
        click(target, '设置所选阈值');
        await vi.waitFor(() => expect(byControl(target, 'threshold-1').value).toBe('1'));
        click(target, '清除所选阈值（继承）');
        await vi.waitFor(() => expect(byControl(target, 'inherit-1').checked).toBe(true));
        click(target, '保存世界书配置');
        await vi.waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledOnce());
        expect(runtime.saveConfig.mock.calls[0][0].entries['1']).toEqual({ mode: 'native', aiDescription: 'When rain is discussed', threshold: null });
        expect(runtime.saveConfig.mock.calls[0][0].entries['2']).toEqual({ mode: 'native', aiDescription: 'In the city', threshold: null });
    });

    it('blocks empty AI conditions and invalid thresholds without discarding entered text', async () => {
        const { target, runtime } = await mount();
        input(target, 'condition-1', '');
        check(target, 'inherit-1', false);
        input(target, 'threshold-1', '1.2');
        click(target, '保存世界书配置');
        await vi.waitFor(() => expect(target.textContent).toContain('接管条件不能为空'));
        expect(target.textContent).toContain('独立阈值须为 0–1');
        expect(runtime.saveConfig).not.toHaveBeenCalled();
        expect(byControl(target, 'threshold-1').value).toBe('1.2');
        input(target, 'condition-1', 'fixed');
        input(target, 'threshold-1', '0');
        click(target, '保存世界书配置');
        await vi.waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledOnce());
        expect(runtime.saveConfig.mock.calls[0][0].entries['1'].threshold).toBe(0);
    });

    it('keeps settings draft separate from persisted runtime settings and validates before saving', async () => {
        const { target, runtime } = await mount();
        input(target, 'setting-threshold', '1');
        input(target, 'setting-historyRounds', '0');
        input(target, 'preset', 'p1', 'change');
        runtime.emit();
        expect(byControl(target, 'setting-threshold').value).toBe('1');
        expect(runtime.saveSettings).not.toHaveBeenCalled();
        click(target, '保存全局设置');
        await vi.waitFor(() => expect(target.textContent).toContain('最近轮数须为 1–100'));
        expect(runtime.saveSettings).not.toHaveBeenCalled();
        input(target, 'setting-historyRounds', '8');
        click(target, '保存全局设置');
        await vi.waitFor(() => expect(runtime.saveSettings).toHaveBeenCalledWith({
            schemaVersion: 2, presetId: 'p1', threshold: 1, historyRounds: 8, timeoutMs: 10000,
        }));
    });

    it('requires explicit test confirmation, defaults to saved configs and only sends drafts when chosen', async () => {
        const { target, runtime } = await mount();
        input(target, 'condition-1', 'unsaved');
        vi.mocked(confirmDanger).mockResolvedValueOnce(false);
        click(target, '测试已保存配置');
        await vi.waitFor(() => expect(confirmDanger).toHaveBeenCalledOnce());
        expect(runtime.testConditions).not.toHaveBeenCalled();
        expect(confirmDanger.mock.calls[0][1].message).toContain('可能产生费用');
        expect(confirmDanger.mock.calls[0][1].message).toContain('常驻背景正文');
        click(target, '测试已保存配置');
        await vi.waitFor(() => expect(runtime.testConditions).toHaveBeenCalledWith());
        click(target, '测试本书未保存草稿');
        await vi.waitFor(() => expect(runtime.testConditions).toHaveBeenCalledTimes(2));
        expect(runtime.testConditions.mock.calls[1][0].entries['1'].aiDescription).toBe('unsaved');
        expect(runtime.saveConfig).not.toHaveBeenCalled();
        runtime.state.testBusy = true;
        runtime.emit();
        click(target, '取消测试');
        await vi.waitFor(() => expect(runtime.cancelTest).toHaveBeenCalledOnce());
    });

    it('previews UID import and applies matched entries to draft only, without changing the book switch', async () => {
        const { target, runtime } = await mount();
        const imported = { schemaVersion: 2, enabled: false, entries: {
            1: { mode: 'native', aiDescription: 'imported rain condition', threshold: 0.9 },
            4: { mode: 'ai', aiDescription: 'must not apply to template', threshold: null },
            99: { mode: 'ai', aiDescription: 'unknown UID', threshold: null },
        } };
        const file = byControl(target, 'import');
        Object.defineProperty(file, 'files', { value: [{ text: async () => serializeConfigExchange(imported) }] });
        file.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(target.textContent).toContain('匹配 1 项，跳过 2 项'));
        expect(byControl(target, 'condition-1').value).toBe('When rain is discussed');
        click(target, '应用匹配项到草稿');
        await vi.waitFor(() => expect(byControl(target, 'condition-1').value).toBe('imported rain condition'));
        expect(byControl(target, 'world-enabled').checked).toBe(true);
        expect(byControl(target, 'condition-4').value).toBe('');
        expect(runtime.saveConfig).not.toHaveBeenCalled();
        click(target, '导出当前草稿配置');
        await vi.waitFor(() => expect(runtime.exportConfig).toHaveBeenCalledOnce());
        expect(runtime.exportConfig.mock.calls[0][0].entries['1'].threshold).toBe(0.9);
        expect(Object.keys(runtime.exportConfig.mock.calls[0][0])).toEqual(['schemaVersion', 'enabled', 'entries']);
    });

    it('keeps damaged schemas blocked until an explicitly confirmed reset', async () => {
        const runtime = makeRuntime();
        runtime.state.settings = null;
        runtime.state.settingsError = 'Unsupported settings schema';
        runtime.state.config = null;
        runtime.state.error = 'Damaged world schema';
        const target = document.createElement('div');
        document.body.append(target);
        disposers.push(mountWorldInfoAiPage(target, { runtime, enabled: true, setEnabled: vi.fn() }));
        expect(target.textContent).toContain('请显式重置');
        expect(byControl(target, 'setting-threshold')).toBeNull();
        vi.mocked(confirmDanger).mockResolvedValueOnce(false);
        click(target, '重置全局设置');
        await vi.waitFor(() => expect(confirmDanger).toHaveBeenCalledOnce());
        expect(runtime.resetSettings).not.toHaveBeenCalled();
        click(target, '重置全局设置');
        await vi.waitFor(() => expect(byControl(target, 'setting-threshold').value).toBe('0.7'));
        click(target, '重置当前世界书决策配置');
        await vi.waitFor(() => expect(runtime.resetConfig).toHaveBeenCalledOnce());
        expect(target.textContent).toContain('Rain');
        expect(runtime.saveConfig).not.toHaveBeenCalled();
    });

    it('shows probability separately from final injection and never requests a background test', async () => {
        const { target, runtime } = await mount();
        runtime.state.rounds = [{ type: 'generation', candidateCount: 2, selectedCount: 2, requestCount: 1, cached: false,
            createdAt: '2026-01-01T00:00:00Z', outcome: 'completed', usage: { inputTokens: 20, outputTokens: 2 }, results: [
                { id: 'a', worldName: 'Lore', uid: 1, title: 'Rain', probability: 0.8, threshold: 0.7, passed: true, injected: false },
                { id: 'b', worldName: 'Lore', uid: 2, title: 'Constant', probability: 1, threshold: 0, passed: true, injected: true },
            ] }, { type: 'test', candidateCount: 1, selectedCount: 1, requestCount: 0, cached: true, results: [
                { worldName: 'Lore', uid: 1, probability: 0.9, threshold: 0.7, passed: true, injected: null },
            ] }];
        runtime.emit();
        expect(target.textContent).toContain('0.800');
        expect(target.textContent).toContain('通过');
        expect(target.textContent).toContain('最终未注入');
        expect(target.textContent).toContain('最终已注入');
        expect(target.textContent).toContain('测试：不注入');
        expect(runtime.testConditions).not.toHaveBeenCalled();
        click(target, '清除最近判定');
        await vi.waitFor(() => expect(target.textContent).toContain('尚无判定记录'));
    });
});
