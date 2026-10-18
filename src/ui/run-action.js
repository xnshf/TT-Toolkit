import { errorMessage } from '../kernel/errors.js';

// 统一的“执行一次异步操作 → 写提示 → 重绘”封装。
// 约定：失败不抛给调用方，而是转成用户可见提示；无论成功失败都重绘一次，
// 避免调用方在每条分支上自己记得 render()，也避免错误文案绕过 errorMessage()。
// notices：createNoticeController() 实例；notice：{ clear(), show(message, kind) } 适配器，二选一。
export function createActionRunner({ render, notices, notice, failureKind = 'danger', clearOnSuccess = false }) {
    const clear = () => {
        if (notices)
            notices.clear();
        else
            notice?.clear();
    };
    const show = (message, kind) => {
        if (notices)
            notices.show(message, kind);
        else
            notice?.show(message, kind);
    };
    return async task => {
        if (!clearOnSuccess)
            clear();
        try {
            await task();
            if (clearOnSuccess)
                clear();
        }
        catch (error) {
            show(errorMessage(error), failureKind);
        }
        render();
    };
}
