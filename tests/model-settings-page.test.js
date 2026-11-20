import { describe, expect, it, vi } from 'vitest';
import { mountModelSettingsPage } from '../src/features/model-settings/ModelSettingsPage.js';
import { ModelSettingsRuntime } from '../src/features/model-settings/runtime.js';

function runtime() {
    const state = {
        settings: {
            schemaVersion: 1,
            activePresetId: 'one',
            presets: [{ id: 'one', name: 'Primary', apiUrl: 'https://api.example.invalid/v1', model: 'model-a', apiKey: 'secret-key' }],
        },
        busy: false,
        loaded: true,
        status: '',
        error: '',
    };
    return {
        state,
        subscribe: vi.fn(() => () => undefined),
        protectDraft: vi.fn(),
        load: vi.fn(async () => undefined),
        save: vi.fn(async value => { state.settings = structuredClone(value); }),
        fetchModels: vi.fn(async () => ['model-b', 'model-a']),
        testConnection: vi.fn(async () => ({ modelCount: 2 })),
        reset: vi.fn(async () => { state.settings = { schemaVersion: 1, activePresetId: null, presets: [] }; state.damaged = false; state.loaded = true; state.error = ''; }),
    };
}

describe('model settings page', () => {
    it('offers retry instead of an empty editable document when loading fails', async () => {
        const target = document.createElement('div');
        const host = {
            globalGet: vi.fn().mockRejectedValueOnce(new Error('storage down')).mockResolvedValue(runtime().state.settings),
            globalSet: vi.fn(),
        };
        const logger = { protectValues: vi.fn(), scoped: () => ({ fail: vi.fn() }) };
        const dispose = mountModelSettingsPage(target, { runtime: new ModelSettingsRuntime(host, logger) });
        const button = label => [...target.querySelectorAll('button')].find(node => node.textContent === label);
        await vi.waitFor(() => expect(button('重新加载')).toBeDefined());
        expect(button('添加预设').disabled).toBe(true);
        expect(button('保存模型预设').disabled).toBe(true);
        expect(button('重置模型预设').disabled).toBe(true);
        expect(target.textContent).not.toContain('尚无模型预设');
        button('重新加载').click();
        await vi.waitFor(() => expect(button('保存模型预设').disabled).toBe(false));
        expect(target.querySelector('input[type=password]').value).toBe('secret-key');
        expect(host.globalSet).not.toHaveBeenCalled();
        dispose();
    });

    it('places save/reset actions before cards and saves the chosen System One protocol', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        mountModelSettingsPage(target, { runtime: modelRuntime });
        await Promise.resolve();
        const save = [...target.querySelectorAll('button')].find(button => button.textContent === '保存模型预设');
        const protocol = target.querySelector('select[aria-label="服务协议"]');
        expect(save.compareDocumentPosition(protocol) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(protocol.value).toBe('openai');
        protocol.value = 'systemone';
        protocol.dispatchEvent(new Event('change'));
        expect(target.textContent).toContain('不发送付费判断');
        [...target.querySelectorAll('button')].find(button => button.textContent === '保存模型预设').click();
        await vi.waitFor(() => expect(modelRuntime.save).toHaveBeenCalledOnce());
        expect(modelRuntime.save.mock.calls[0][0].presets[0].protocol).toBe('systemone');
    });

    it('requires explicit confirmation to reset damaged data and offers cancellation', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        modelRuntime.state.damaged = true;
        modelRuntime.state.loaded = false;
        modelRuntime.state.error = '损坏的模型预设';
        mountModelSettingsPage(target, { runtime: modelRuntime });
        await Promise.resolve();
        const button = text => [...target.querySelectorAll('button')].find(button => button.textContent === text);
        expect(button('保存模型预设').disabled).toBe(true);
        button('重置损坏的模型预设').click();
        expect(target.textContent).toContain('无法撤销');
        expect(modelRuntime.reset).not.toHaveBeenCalled();
        button('取消重置').click();
        expect(button('确认清除模型预设')).toBeUndefined();
        button('重置损坏的模型预设').click();
        button('确认清除模型预设').click();
        await vi.waitFor(() => expect(modelRuntime.reset).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(target.querySelectorAll('select[aria-label="服务协议"]')).toHaveLength(0));
    });
    it('masks persisted keys by default and can reveal them explicitly', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        const dispose = mountModelSettingsPage(target, { runtime: modelRuntime });
        await Promise.resolve();
        const key = target.querySelector('input[autocomplete="new-password"]');
        expect(key?.type).toBe('password');
        expect(key?.value).toBe('secret-key');
        const show = [...target.querySelectorAll('button')].find(button => button.textContent === '显示');
        show?.click();
        expect(target.querySelector('input[autocomplete="new-password"]')?.type).toBe('text');
        dispose();
    });

    it('adds multiple presets and saves URL/model/key as one settings document', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        mountModelSettingsPage(target, { runtime: modelRuntime });
        await Promise.resolve();
        [...target.querySelectorAll('button')].find(button => button.textContent === '添加预设')?.click();
        expect(target.querySelectorAll('select[aria-label="服务协议"]')).toHaveLength(2);
        [...target.querySelectorAll('button')].find(button => button.textContent === '保存模型预设')?.click();
        await vi.waitFor(() => expect(modelRuntime.save).toHaveBeenCalledOnce());
        expect(modelRuntime.save.mock.calls[0][0].presets).toHaveLength(2);
    });

    it('fetches model names for a preset and exposes them as model input suggestions', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        mountModelSettingsPage(target, { runtime: modelRuntime });
        await Promise.resolve();

        [...target.querySelectorAll('button')].find(button => button.textContent === '获取模型')?.click();
        await vi.waitFor(() => expect(modelRuntime.fetchModels).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(target.querySelectorAll('datalist option')).toHaveLength(2));

        expect(modelRuntime.fetchModels).toHaveBeenCalledWith(expect.objectContaining({
            apiUrl: 'https://api.example.invalid/v1',
            model: 'model-a',
            apiKey: 'secret-key',
        }));
        expect([...target.querySelectorAll('datalist option')].map(option => option.value)).toEqual(['model-b', 'model-a']);
        expect(target.textContent).toContain('已从服务端获取 2 个模型名称');
    });

    it('tests preset connectivity through the runtime', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        mountModelSettingsPage(target, { runtime: modelRuntime });
        await Promise.resolve();

        [...target.querySelectorAll('button')].find(button => button.textContent === '测试连接')?.click();
        await vi.waitFor(() => expect(modelRuntime.testConnection).toHaveBeenCalledOnce());

        expect(modelRuntime.testConnection).toHaveBeenCalledWith(expect.objectContaining({
            apiUrl: 'https://api.example.invalid/v1',
            apiKey: 'secret-key',
        }));
        expect(target.textContent).toContain('连接成功；服务端返回 2 个模型');
    });

    it('asks before leaving only when the preset draft differs from what is saved', async () => {
        const target = document.createElement('div');
        const modelRuntime = runtime();
        let guard = null;
        const dispose = mountModelSettingsPage(target, { runtime: modelRuntime, setLeaveGuard: value => { guard = value; } });
        await Promise.resolve();
        await Promise.resolve();
        await expect(guard()).resolves.toBe(true);

        [...target.querySelectorAll('button')].find(button => button.textContent === '添加预设').click();
        const asking = guard();
        await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
        expect(document.querySelector('dialog').textContent).toContain('模型预设');
        // 取消则留在当前页面，不猜测草稿状态。
        [...document.querySelectorAll('dialog button')].find(node => node.textContent === '取消').click();
        await expect(asking).resolves.toBe(false);
        dispose();
    });
});
