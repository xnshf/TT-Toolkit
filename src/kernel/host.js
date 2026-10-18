import { ToolkitError } from './errors.js';
import { CONTEXT_URL, GROUP_URL, SCRIPT_URL, WORLD_INFO_URL, dynamicImport, requireAbi } from './host-abi.js';
import { entryMethods } from './host-entry.js';
import { storeMethods } from './host-store.js';
import { chatMethods } from './host-chat.js';
import { generationMethods } from './host-generation.js';
import { worldInfoMethods } from './host-world-info.js';
import { promptMethods } from './host-prompt.js';

export class TauriTavernHost {
    namespace = 'tt-toolkit';
    abi;
    contextModule;
    scriptModule;
    groupModule;
    worldInfoModule;
    extensionsModule;
    log = null;
    chatAliases = new Map();
    setLogger(log) { this.log = log; }
    chatAlias(stableId) {
        let alias = this.chatAliases.get(stableId);
        if (!alias) {
            alias = `chat-${this.chatAliases.size + 1}`;
            this.chatAliases.set(stableId, alias);
        }
        return alias;
    }
    async initialize() {
        this.abi = requireAbi();
        if (this.abi.ready)
            await this.abi.ready;
        [this.contextModule, this.scriptModule, this.groupModule, this.worldInfoModule] = await Promise.all([
            dynamicImport(CONTEXT_URL),
            dynamicImport(SCRIPT_URL),
            dynamicImport(GROUP_URL),
            dynamicImport(WORLD_INFO_URL),
        ]);
        if (typeof this.contextModule.getContext !== 'function'
            || typeof this.scriptModule.saveChat !== 'function'
            || typeof this.scriptModule.reloadCurrentChat !== 'function'
            || typeof this.groupModule.saveGroupChat !== 'function'
            || typeof this.worldInfoModule.loadWorldInfo !== 'function'
            || typeof this.worldInfoModule.saveWorldInfo !== 'function') {
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 必需 legacy 导出不可用，TT-Toolkit 已停止初始化。');
        }
    }
    get context() {
        const context = this.contextModule.getContext();
        if (!Array.isArray(context.chat))
            throw new ToolkitError('NO_CHAT', '当前没有可用聊天。');
        return context;
    }
    // abiVersion 是宿主 ABI 版本常量，只用于诊断收集，不能用来识别宿主构建。
    hostAbiVersion() {
        const value = this.abi?.abiVersion;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
}

// 能力方法按文件分组后挂回原型，运行时类型与拆分前完全一致。
Object.assign(TauriTavernHost.prototype, entryMethods, storeMethods, chatMethods, generationMethods, worldInfoMethods, promptMethods);
