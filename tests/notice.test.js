import { describe, expect, it, vi } from 'vitest';
import { createNoticeController, noticeBanner } from '../src/ui/notice.js';

function fakeTimer() {
    let callback = null;
    return {
        setTimeout: vi.fn(fn => { callback = fn; return 1; }),
        clearTimeout: vi.fn(),
        expire: () => callback?.(),
    };
}

describe('notice lifecycle', () => {
    it('automatically removes success feedback and requests a render', () => {
        const timer = fakeTimer();
        const render = vi.fn();
        const notices = createNoticeController(render, timer);
        notices.show('已保存', 'success');
        expect(notices.current).toEqual({ text: '已保存', kind: 'success' });
        timer.expire();
        expect(notices.current).toBeNull();
        expect(render).toHaveBeenCalledOnce();
    });

    it('keeps actionable errors visible until dismissed', () => {
        const timer = fakeTimer();
        const render = vi.fn();
        const notices = createNoticeController(render, timer);
        notices.show('保存失败', 'danger');
        expect(timer.setTimeout).not.toHaveBeenCalled();
        const banner = noticeBanner(notices.current, () => notices.clear(true));
        expect(banner.getAttribute('role')).toBe('alert');
        expect(banner.textContent).toContain('保存失败');
        banner.querySelector('button').click();
        expect(notices.current).toBeNull();
        expect(render).toHaveBeenCalledOnce();
    });
});
