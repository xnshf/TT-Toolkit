import { describe, expect, it, vi } from 'vitest';
import { mountToolkitApp } from '../src/ui/main.js';

function feature(overrides = {}) {
    const id = overrides.id ?? 'chat-cleaner';
    return {
        id,
        category: { id: 'chat-data', label: '聊天数据', order: 10 },
        label: '聊天清洗',
        description: 'clean',
        icon: 'x',
        order: 10,
        mount: async featureTarget => {
            const page = document.createElement('div');
            page.dataset.test = id;
            page.textContent = `${id} page`;
            featureTarget.replaceChildren(page);
        },
        activate: async () => undefined,
        deactivate: async () => undefined,
        ...overrides,
    };
}

function props(features, overrides = {}) {
    return {
        features,
        enabled: Object.fromEntries(features.map(item => [item.id, false])),
        initialRoute: 'overview',
        version: '9.8.7',
        close: vi.fn(),
        cycleSize: vi.fn(),
        resetLayout: vi.fn(),
        setRoute: vi.fn(async () => undefined),
        setFeatureEnabled: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('toolkit shell', () => {
    it('renders two-level categories, groups the overview, and opens a category first feature', async () => {
        const target = document.createElement('div');
        const features = [
            feature(),
            feature({
                id: 'developer-logs',
                category: { id: 'settings', label: '设置', order: 90 },
                label: '日志',
                icon: 'l',
            }),
        ];
        const appProps = props(features);
        const app = mountToolkitApp(target, appProps);
        expect(target.textContent).toContain(appProps.version);
        expect(target.textContent).toContain('聊天数据');
        expect(target.textContent).toContain('设置');
        expect(target.textContent).not.toContain('清理维护');
        expect(target.textContent).toContain('未启用');
        expect(target.querySelector('[data-overview-feature-id="chat-cleaner"]')).not.toBeNull();
        expect(target.querySelector('[data-overview-feature-id="developer-logs"]')).not.toBeNull();

        target.querySelector('[data-category-id="chat-data"]')?.click();
        await vi.waitFor(() => expect(target.querySelector('[data-test="chat-cleaner"]')).not.toBeNull());
        expect(appProps.setRoute).toHaveBeenCalledWith('chat-cleaner');
        expect(target.querySelector('[data-feature-id="chat-cleaner"]')?.textContent).toContain('未启用');
        app.unmount();
    });

    it('renders every feature in the shared second-level navigation', async () => {
        const target = document.createElement('div');
        const features = [
            feature(),
            feature({ id: 'chat-export', label: '聊天导出', order: 20 }),
        ];
        const appProps = props(features, { initialRoute: 'chat-cleaner' });
        const app = mountToolkitApp(target, appProps);
        expect(target.querySelectorAll('[data-feature-id]')).toHaveLength(2);

        target.querySelector('[data-feature-id="chat-export"]')?.click();
        await vi.waitFor(() => expect(target.querySelector('[data-test="chat-export"]')).not.toBeNull());
        expect(appProps.setRoute).toHaveBeenCalledWith('chat-export');
        app.unmount();
    });

    it('passes the workbench close action to feature pages', async () => {
        const target = document.createElement('div');
        const mount = vi.fn(async () => undefined);
        const viewer = feature({ id: 'chat-viewer', label: '聊天查看', mount });
        const entrySettings = { getState: vi.fn(), setMode: vi.fn(), resetLayout: vi.fn() };
        const appProps = props([viewer], { initialRoute: 'chat-viewer', entrySettings });
        const app = mountToolkitApp(target, appProps);
        await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
        expect(mount.mock.calls[0][1].closeWorkbench).toBe(appProps.close);
        expect(mount.mock.calls[0][1].entrySettings).toBe(entrySettings);
        expect(typeof mount.mock.calls[0][1].setLeaveGuard).toBe('function');
        app.unmount();
    });
});

describe('leaving a feature with unsaved work', () => {
    function guardedFeature(guard) {
        return feature({
            mount: async (featureTarget, props) => {
                const page = document.createElement('div');
                page.dataset.test = 'chat-cleaner';
                featureTarget.replaceChildren(page);
                props.setLeaveGuard(guard);
            },
        });
    }

    it('stays on the current feature when its leave guard declines', async () => {
        const target = document.createElement('div');
        const appProps = props([guardedFeature(async () => false)], { initialRoute: 'chat-cleaner' });
        const app = mountToolkitApp(target, appProps);
        await vi.waitFor(() => expect(target.querySelector('[data-test="chat-cleaner"]')).not.toBeNull());
        expect(app.hasLeaveGuard()).toBe(true);

        target.querySelector('[data-route="overview"]').click();
        await vi.waitFor(() => expect(appProps.setRoute).not.toHaveBeenCalled());
        // 路由未变、功能页 DOM 未被替换，草稿上下文保持不变。
        expect(target.querySelector('[data-test="chat-cleaner"]')).not.toBeNull();
        expect(app.route).toBe('chat-cleaner');
        app.unmount();
    });

    it('leaves the feature once the guard allows it and drops the stale guard', async () => {
        const target = document.createElement('div');
        const appProps = props([guardedFeature(async () => true)], { initialRoute: 'chat-cleaner' });
        const app = mountToolkitApp(target, appProps);
        await vi.waitFor(() => expect(target.querySelector('[data-test="chat-cleaner"]')).not.toBeNull());

        target.querySelector('[data-route="overview"]').click();
        await vi.waitFor(() => expect(appProps.setRoute).toHaveBeenCalledWith('overview'));
        expect(target.querySelector('[data-test="chat-cleaner"]')).toBeNull();
        expect(app.hasLeaveGuard()).toBe(false);
        app.unmount();
    });

    it('asks once when several leave requests arrive during the same confirmation', async () => {
        const target = document.createElement('div');
        let release = null;
        const guard = vi.fn(() => new Promise(resolve => { release = resolve; }));
        const app = mountToolkitApp(target, props([guardedFeature(guard)], { initialRoute: 'chat-cleaner' }));
        await vi.waitFor(() => expect(app.hasLeaveGuard()).toBe(true));

        const first = app.requestLeave();
        const second = app.requestLeave();
        expect(guard).toHaveBeenCalledOnce();
        release(false);
        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(false);
        app.unmount();
    });

    it('falls back to an explicit confirmation when the guard itself throws', async () => {
        const target = document.createElement('div');
        const app = mountToolkitApp(target, props([guardedFeature(async () => { throw new Error('private detail'); })], { initialRoute: 'chat-cleaner' }));
        await vi.waitFor(() => expect(app.hasLeaveGuard()).toBe(true));

        const asking = app.requestLeave();
        await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
        expect(document.querySelector('dialog').textContent).toContain('继续离开可能丢弃当前改动');
        expect(document.body.textContent).not.toContain('private detail');
        // 取消时保持工作台，不去猜草稿状态。
        document.querySelector('dialog button').click();
        await expect(asking).resolves.toBe(false);
        app.unmount();
    });
});
