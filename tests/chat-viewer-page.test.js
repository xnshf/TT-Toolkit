import { describe, expect, it, vi } from 'vitest';
import { buildChatViewModel } from '../src/features/chat-viewer/model.js';
import { highlightedText, mountChatViewerPage } from '../src/features/chat-viewer/ChatViewerPage.js';

const model = buildChatViewModel({
    identity: { stableId: 'chat-1', label: '当前聊天', ref: { kind: 'character' } },
    messages: [{ is_user: true, is_system: false, name: 'User', mes: '<img src=x> Alpha [one]' }],
});

function runtime() {
    const state = { active: true, busy: false, stale: false, model, status: '已读取', error: '' };
    return {
        state,
        subscribe: vi.fn(() => vi.fn()),
        refresh: vi.fn(async () => model),
        range: vi.fn(async () => ({ model, items: model.items })),
        search: vi.fn(async () => ({ model, items: model.items })),
        jump: vi.fn(async () => model.items[0]),
    };
}

describe('chat viewer page', () => {
    it('highlights literal matches as safe DOM text', () => {
        const target = document.createElement('div');
        target.append(highlightedText('<img src=x> Alpha [one]', 'alpha [one]'));
        expect(target.querySelector('img')).toBeNull();
        expect(target.querySelector('mark')?.textContent).toBe('Alpha [one]');
        expect(target.textContent).toBe('<img src=x> Alpha [one]');
    });

    it('searches in the iframe page and closes the workbench only after a successful jump', async () => {
        const target = document.createElement('div');
        const viewerRuntime = runtime();
        const closeWorkbench = vi.fn();
        const dispose = mountChatViewerPage(target, {
            enabled: true,
            runtime: viewerRuntime,
            closeWorkbench,
            setEnabled: vi.fn(async () => undefined),
        });
        await vi.waitFor(() => expect(target.querySelector('[data-absolute-index]')).not.toBeNull());

        [...target.querySelectorAll('button')].find(button => button.textContent === '正文搜索')?.click();
        const input = target.querySelector('input[aria-label="正文关键词"]');
        input.value = 'alpha [one]';
        input.dispatchEvent(new Event('input'));
        target.querySelector('[data-viewer-search]')?.click();
        await vi.waitFor(() => expect(target.querySelector('mark')?.textContent).toBe('Alpha [one]'));

        [...target.querySelectorAll('button')].find(button => button.textContent === '跳转')?.click();
        await vi.waitFor(() => expect(viewerRuntime.jump).toHaveBeenCalledOnce());
        expect(closeWorkbench).toHaveBeenCalledOnce();
        dispose();
    });

    it('shows an unreadable placeholder without blocking healthy cards or mislabeling swipe metadata', async () => {
        const target = document.createElement('div');
        const viewerRuntime = runtime();
        const degraded = buildChatViewModel({ identity: model.identity, messages: [null, { is_user: true, mes: 'healthy', swipes: ['healthy'], swipe_id: 5 }] });
        viewerRuntime.state.model = degraded;
        viewerRuntime.refresh = vi.fn(async () => degraded);
        const dispose = mountChatViewerPage(target, { enabled: true, runtime: viewerRuntime, closeWorkbench: vi.fn(), setEnabled: vi.fn() });
        await vi.waitFor(() => expect(target.querySelectorAll('[data-absolute-index]')).toHaveLength(2));
        const cards = target.querySelectorAll('[data-absolute-index]');
        expect(cards[0].textContent).toContain('原始索引 0');
        expect([...cards[0].querySelectorAll('button')].every(button => button.disabled)).toBe(true);
        expect(cards[1].textContent).toContain('healthy');
        expect(cards[1].textContent).toContain('swipe ?/1');
        expect([...cards[1].querySelectorAll('button')].find(button => button.textContent === '跳转').disabled).toBe(false);
        expect(target.textContent).toContain('搜索结果不包含这些楼层');
        dispose();
    });

    it('keeps the workbench open when the host jump fails', async () => {
        const target = document.createElement('div');
        const viewerRuntime = runtime();
        viewerRuntime.jump = vi.fn(async () => { throw new Error('jump failed'); });
        const closeWorkbench = vi.fn();
        const dispose = mountChatViewerPage(target, {
            enabled: true,
            runtime: viewerRuntime,
            closeWorkbench,
            setEnabled: vi.fn(async () => undefined),
        });
        await vi.waitFor(() => expect(target.querySelector('[data-absolute-index]')).not.toBeNull());
        [...target.querySelectorAll('button')].find(button => button.textContent === '跳转')?.click();
        await vi.waitFor(() => expect(target.textContent).toContain('jump failed'));
        expect(closeWorkbench).not.toHaveBeenCalled();
        dispose();
    });
});
