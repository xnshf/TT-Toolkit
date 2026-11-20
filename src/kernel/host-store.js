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
        try {
            return await this.abi.api.extension.store.getBlob({ namespace: this.namespace, table, key });
        }
        catch (error) {
            // The public host API throws a plain Error for the explicit absent result.
            if (error instanceof Error && error.message === `Extension store entry not found: ${this.namespace}:${table ?? 'main'}/${key}`)
                throw new ToolkitError('STORE_BLOB_NOT_FOUND', '扩展存储分块不存在。');
            throw error;
        }
    },
    async storeDeleteBlob(table, key) {
        await this.abi.api.extension.store.deleteBlob({ namespace: this.namespace, table, key });
    },
    async storeDeleteTable(table) {
        try {
            await this.abi.api.extension.store.deleteTable({ namespace: this.namespace, table });
        }
        catch (error) {
            // safeInvoke wraps the serialized Rust command error in Error.cause.
            if (error instanceof Error && error.cause?.NotFound === `Extension store table not found: ${this.namespace}:${table}`)
                throw new ToolkitError('STORE_TABLE_NOT_FOUND', '扩展存储表不存在。');
            throw error;
        }
    },
    async storeListBlobKeys(table) {
        return this.abi.api.extension.store.listBlobKeys({ namespace: this.namespace, table });
    },
    assertFrontendLogsCapability() {
        const frontendLogs = this.abi?.api?.dev?.frontendLogs;
        // TauriTavern 2.4.0's console-capture getter can change capture globally.
        const missing = ['list', 'subscribe'].filter(name => typeof frontendLogs?.[name] !== 'function');
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
    async subscribeFrontendLogs(onEntry, onContractError) {
        if (typeof onEntry !== 'function' || typeof onContractError !== 'function')
            throw new TypeError('宿主前端日志订阅需要 onEntry 与 onContractError 回调');
        const frontendLogs = this.assertFrontendLogsCapability();
        let stopped = false;
        let underlying = null;
        const cancel = () => {
            stopped = true;
            // A stop can precede registration's reply; consume the handle whenever it arrives.
            const unsubscribe = underlying;
            underlying = null;
            unsubscribe?.();
        };
        const cancelOnFailure = () => {
            try {
                cancel();
            }
            catch {
                // A failed removal cannot resume delivery or replace the contract failure.
            }
        };
        const wrapped = entry => {
            if (stopped)
                return;
            let validated;
            try {
                validated = this.validateFrontendLogEntry(entry);
            }
            catch (error) {
                cancelOnFailure();
                onContractError(error);
                return;
            }
            onEntry(validated);
        };
        let unsubscribe;
        try {
            unsubscribe = await frontendLogs.subscribe(wrapped);
        }
        catch {
            stopped = true;
            throw new ToolkitError('HOST_FRONTEND_LOG_SUBSCRIBE_FAILED', '订阅宿主前端日志失败，请检查宿主后重试。');
        }
        if (typeof unsubscribe !== 'function') {
            stopped = true;
            throw new ToolkitError('HOST_FRONTEND_LOG_SUBSCRIPTION_INVALID', '宿主前端日志订阅返回的取消函数必须是函数。');
        }
        underlying = unsubscribe;
        if (stopped)
            cancelOnFailure();
        return cancel;
    }
};
