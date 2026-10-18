import { ToolkitError } from './errors.js';

// storeMethods: 由 host.js 按宿主能力拆分，方法体与拆分前一致。
export const storeMethods = {
    async globalGet(key) {
        const result = await this.abi.api.extension.store.tryGetJson({ namespace: this.namespace, key });
        this.log?.debug('store.global_read', { data: { key, found: result.found } });
        return result.found ? result.value : undefined;
    },
    async globalSet(key, value) {
        await this.abi.api.extension.store.setJson({ namespace: this.namespace, key, value: structuredClone(value) });
        this.log?.debug('store.global_written', { data: { key } });
    },
    async globalDelete(key) {
        await this.abi.api.extension.store.deleteJson({ namespace: this.namespace, key });
        this.log?.warn('store.global_deleted', { data: { key } });
    },
    async storeTryGetJson(table, key) {
        const result = await this.abi.api.extension.store.tryGetJson({ namespace: this.namespace, table, key });
        return result.found ? result.value : undefined;
    },
    async storeSetJson(table, key, value) {
        await this.abi.api.extension.store.setJson({ namespace: this.namespace, table, key, value: structuredClone(value) });
    },
    async storeDeleteJson(table, key) {
        await this.abi.api.extension.store.deleteJson({ namespace: this.namespace, table, key });
    },
    async storeSetBlob(table, key, data) {
        await this.abi.api.extension.store.setBlob({ namespace: this.namespace, table, key, data });
    },
    async storeGetBlob(table, key) {
        return this.abi.api.extension.store.getBlob({ namespace: this.namespace, table, key });
    },
    async storeDeleteBlob(table, key) {
        await this.abi.api.extension.store.deleteBlob({ namespace: this.namespace, table, key });
    },
    async storeDeleteTable(table) {
        await this.abi.api.extension.store.deleteTable({ namespace: this.namespace, table });
    },
    async getHostConsoleCaptureEnabled() {
        const frontendLogs = this.assertFrontendLogsCapability();
        let enabled;
        try {
            enabled = await frontendLogs.getConsoleCaptureEnabled();
        }
        catch {
            throw new ToolkitError('HOST_FRONTEND_LOG_STATUS_INVALID', '读取宿主 console 捕获状态失败。');
        }
        if (typeof enabled !== 'boolean')
            throw new ToolkitError('HOST_FRONTEND_LOG_STATUS_INVALID', '宿主 console 捕获状态必须是 boolean。');
        return enabled;
    },
    assertFrontendLogsCapability() {
        const frontendLogs = this.abi?.api?.dev?.frontendLogs;
        const required = { list: 'list', subscribe: 'subscribe', getConsoleCaptureEnabled: 'getConsoleCaptureEnabled' };
        const missing = Object.entries(required)
            .filter(([, name]) => typeof frontendLogs?.[name] !== 'function')
            .map(([, name]) => name);
        if (missing.length)
            throw new ToolkitError('HOST_FRONTEND_LOGS_MISSING', `TauriTavern 前端日志 ABI 缺少必需方法：${missing.join('、')}。`);
        return frontendLogs;
    },
    validateFrontendLogEntry(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志条目必须是对象。');
        const candidate = value;
        if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0)
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志 id 必须是大于零的安全整数。');
        if (!Number.isSafeInteger(candidate.timestampMs) || candidate.timestampMs < 0)
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志时间戳必须是大于等于零的安全整数。');
        if (!['debug', 'info', 'warn', 'error'].includes(candidate.level))
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志级别非法。');
        if (typeof candidate.message !== 'string')
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志 message 必须是字符串。');
        if (candidate.target !== undefined && typeof candidate.target !== 'string')
            throw new ToolkitError('HOST_FRONTEND_LOG_ENTRY_INVALID', '宿主前端日志 target 必须是字符串。');
        return {
            id: candidate.id,
            timestampMs: candidate.timestampMs,
            level: candidate.level,
            message: candidate.message,
            ...(candidate.target !== undefined ? { target: candidate.target } : {}),
        };
    },
    async listFrontendLogs() {
        const frontendLogs = this.assertFrontendLogsCapability();
        let value;
        try {
            value = await frontendLogs.list();
        }
        catch {
            throw new ToolkitError('HOST_FRONTEND_LOG_LIST_INVALID', '读取宿主前端日志尾部失败。');
        }
        if (!Array.isArray(value))
            throw new ToolkitError('HOST_FRONTEND_LOG_LIST_INVALID', '宿主前端日志尾部必须是数组。');
        return value.map(entry => this.validateFrontendLogEntry(entry));
    },
    subscribeFrontendLogs(onEntry, onContractError) {
        if (typeof onEntry !== 'function' || typeof onContractError !== 'function')
            throw new TypeError('宿主前端日志订阅需要 onEntry 与 onContractError 回调');
        const frontendLogs = this.assertFrontendLogsCapability();
        let pendingCancel = false;
        let underlying = null;
        let cancelCalled = false;
        let notified = false;
        let stopped = false;
        const cancel = () => {
            if (cancelCalled)
                return;
            cancelCalled = true;
            if (underlying)
                underlying();
            else
                pendingCancel = true;
        };
        const wrapped = entry => {
            if (cancelCalled || stopped)
                return;
            let validated;
            try {
                validated = this.validateFrontendLogEntry(entry);
            }
            catch (error) {
                if (!notified) {
                    notified = true;
                    stopped = true;
                    onContractError(error);
                }
                return;
            }
            if (pendingCancel)
                return;
            onEntry(validated);
        };
        return frontendLogs.subscribe(wrapped).then(unsubscribe => {
            if (typeof unsubscribe !== 'function')
                throw new ToolkitError('HOST_FRONTEND_LOG_SUBSCRIPTION_INVALID', '宿主前端日志订阅返回的取消函数必须是函数。');
            underlying = unsubscribe;
            if (pendingCancel) {
                pendingCancel = false;
                cancel();
            }
            return cancel;
        });
    }
};
