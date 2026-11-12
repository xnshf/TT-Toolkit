import { describe, expect, it, vi } from 'vitest';
import { mountChatCleanerPage } from '../src/features/chat-cleaner/ChatCleanerPage.js';
import { createDefaultSettings } from '../src/features/chat-cleaner/schema.js';

function button(target, text) {
    return [...target.querySelectorAll('button')].find(item => item.textContent === text);
}

function runtime() {
    const plan = {
        stats: {
            totalMessages: 2, eligibleMessages: 2, excludedSystemMessages: 0,
            excludedToolMessages: 0, hiddenEligibleMessages: 0, compactEligibleMessages: 0,
            scannedMessages: 2, changedMessages: 1, bodyRemovedChars: 4,
            reasoningRemovedChars: 0,
        },
        warnings: [],
        changes: [{
            messageIndex: 0,
            bodyPatches: [{ swipeIndex: 0, before: '<x>text</x>', after: 'text' }],
            reasoningPatches: [],
            emptySwipeIndexes: [],
        }],
    };
    return {
        state: {
            settings: createDefaultSettings(), currentPlan: plan, busy: false,
            error: '', status: '清洗完成。', progress: null,
        },
        subscribe: vi.fn(() => () => undefined),
        loadProgress: vi.fn(async () => undefined),
        previewManual: vi.fn(async () => plan),
        commitManual: vi.fn(async () => undefined),
        saveSettings: vi.fn(async () => undefined),
        resetProgress: vi.fn(async () => undefined),
        resetSettings: vi.fn(async () => undefined),
        clearError: vi.fn(),
    };
}

describe('chat cleaner high-risk actions', () => {
    it('shows a default-off candidate clearing control with save before options', async () => {
        const cleaner = runtime();
        const target = document.createElement('div');
        mountChatCleanerPage(target, { runtime: cleaner, enabled: true, setEnabled: vi.fn() });
        button(target, '规则设置').click();
        const input = [...target.querySelectorAll('input[type="checkbox"]')]
            .find(node => node.parentElement?.textContent.includes('清除其它 swipes'));
        expect(input.checked).toBe(false);
        expect(input.parentElement.textContent).toContain('手动和自动');
        const save = button(target, '保存规则');
        expect(save.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        button(target, '保存规则').click();
        await vi.waitFor(() => expect(cleaner.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ clearSwipes: true })));
    });
    it('shows candidate-only changes and every warning before confirmation', async () => {
        const cleaner = runtime();
        cleaner.state.currentPlan.stats.removedSwipes = 2;
        cleaner.state.currentPlan.changes[0].bodyPatches = [];
        cleaner.state.currentPlan.changes[0].clearSwipesPatch = { currentSwipe: 1, removedCount: 2 };
        cleaner.state.currentPlan.warnings = Array.from({ length: 7 }, (_, index) => `楼层 ${index}：异常保留`);
        const target = document.createElement('div');
        mountChatCleanerPage(target, { runtime: cleaner, enabled: true, setEnabled: vi.fn() });
        button(target, '扫描并预览').click();
        await vi.waitFor(() => expect(button(target, '永久提交清洗').disabled).toBe(false));
        expect(target.textContent).toContain('清除 2 个候选');
        expect(target.textContent).toContain('楼层 6：异常保留');
        button(target, '永久提交清洗').click();
        await vi.waitFor(() => expect(document.body.textContent).toContain('将删除 2 个其它候选及其 swipe_info'));
        expect(document.body.textContent).toContain('请先自行备份');
        button(document.body, '确认永久提交').click();
        await vi.waitFor(() => expect(cleaner.commitManual).toHaveBeenCalledWith(false, cleaner.state.currentPlan));
    });
    it('keeps commit above the preview and invalidates it when scan inputs change', async () => {
        const cleaner = runtime();
        const target = document.createElement('div');
        document.body.append(target);
        mountChatCleanerPage(target, { runtime: cleaner, enabled: true, setEnabled: vi.fn() });

        button(target, '扫描并预览').click();
        await vi.waitFor(() => expect(button(target, '永久提交清洗').disabled).toBe(false));
        const commit = button(target, '永久提交清洗');
        const firstPreviewRow = [...target.querySelectorAll('button')].find(node => node.textContent.startsWith('楼层 '));
        expect(commit.compareDocumentPosition(firstPreviewRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        const keep = target.querySelector('.number-input');
        keep.value = '2';
        keep.dispatchEvent(new Event('input'));
        keep.dispatchEvent(new Event('change'));
        expect(button(target, '永久提交清洗').disabled).toBe(true);
        expect(target.textContent).toContain('请重新扫描后再永久提交');
    });
});
