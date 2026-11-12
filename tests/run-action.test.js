import { describe, expect, it, vi } from 'vitest';
import { createActionRunner } from '../src/ui/run-action.js';

function noticeAdapter() {
    const state = { notice: '', kind: '', clears: 0 };
    return {
        state,
        adapter: {
            clear: () => { state.clears += 1; state.notice = ''; state.kind = ''; },
            show: (message, kind) => { state.notice = message; state.kind = kind; },
        },
    };
}

describe('action runner', () => {
    it('renders once after a successful task and leaves no message', async () => {
        const { state, adapter } = noticeAdapter();
        const render = vi.fn();
        const run = createActionRunner({ notice: adapter, render });
        await run(async () => undefined);
        expect(render).toHaveBeenCalledTimes(1);
        expect(state.notice).toBe('');
    });

    it('turns a failure into a message instead of throwing, and still renders', async () => {
        const { state, adapter } = noticeAdapter();
        const render = vi.fn();
        const run = createActionRunner({ notice: adapter, render, failureKind: 'warning' });
        await expect(run(async () => { throw new Error('写入失败'); })).resolves.toBeUndefined();
        expect(state.notice).toBe('写入失败');
        expect(state.kind).toBe('warning');
        expect(render).toHaveBeenCalledTimes(1);
    });

    it('clears the previous message before running, or after success when asked', async () => {
        const { state, adapter } = noticeAdapter();
        state.notice = '旧提示';
        const before = createActionRunner({ notice: adapter, render: vi.fn() });
        await before(async () => {
            expect(state.notice).toBe('');
        });

        state.notice = '旧提示';
        let observed = '';
        const after = createActionRunner({ notice: adapter, render: vi.fn(), clearOnSuccess: true });
        await after(async () => { observed = state.notice; });
        expect(observed).toBe('旧提示');
        expect(state.notice).toBe('');
    });

    it('uses the notice controller with the configured kind', async () => {
        const notices = { clear: vi.fn(), show: vi.fn() };
        const run = createActionRunner({ notices, render: vi.fn(), failureKind: 'danger' });
        await run(async () => { throw new Error('no chat'); });
        expect(notices.clear).toHaveBeenCalledTimes(1);
        expect(notices.show).toHaveBeenCalledWith('no chat', 'danger');
    });
});
