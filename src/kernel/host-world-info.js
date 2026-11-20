import { ToolkitError } from './errors.js';
import { sha256Hex } from './hash.js';
import { valueType } from './chat-diagnostics.js';
import { WORLD_INFO_LORE_LISTS, WORLD_INFO_SNAPSHOT_INCOMPLETE } from './world-info.js';

// worldInfoMethods: 由 host.js 按宿主能力拆分，方法体与拆分前一致。
export const worldInfoMethods = {
    listWorldInfoNames() {
        return Array.isArray(this.worldInfoModule.world_names)
            ? [...this.worldInfoModule.world_names]
            : [];
    },
    async loadWorldInfo(name) {
        const data = await this.worldInfoModule.loadWorldInfo(String(name));
        return data ? structuredClone(data) : null;
    },
    async loadWorldInfoFresh(name) {
        const context = this.context;
        if (typeof context.getRequestHeaders !== 'function') {
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 缺少世界书读取请求头接口。');
        }
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ name: String(name) }),
            cache: 'no-cache',
        });
        if (!response.ok)
            throw new ToolkitError('WORLD_INFO_READ_FAILED', `世界书读取失败（HTTP ${response.status}）。`);
        return structuredClone(await response.json());
    },
    async saveWorldInfo(name, data) {
        await this.worldInfoModule.saveWorldInfo(String(name), structuredClone(data), true);
    },
    activeWorldInfoNames() {
        return this.activeWorldInfoBindings().map(binding => binding.name);
    },
    activeWorldInfoBindings() {
        const context = this.context;
        const bindings = [];
        const activeNames = new Set();
        const add = (value, source) => {
            if (typeof value === 'string' && value && !activeNames.has(value)) {
                activeNames.add(value);
                bindings.push({ name: value, source });
            }
        };
        for (const name of this.worldInfoModule.selected_world_info ?? [])
            add(name, 'global');
        add(context.chatMetadata?.world_info, 'chat');
        add(context.powerUserSettings?.persona_description_lorebook, 'persona');
        const character = context.characters?.[context.characterId];
        add(character?.data?.extensions?.world, 'character');
        const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
        const fileName = avatar.replace(/\.[^/.]+$/, '');
        const extra = this.worldInfoModule.world_info?.charLore?.find(item => item?.name === fileName);
        for (const name of extra?.extraBooks ?? [])
            add(name, 'character');
        return bindings;
    },
    validateWorldInfoEntriesPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new ToolkitError('HOST_EVENT_INVALID', 'WORLDINFO_ENTRIES_LOADED 负载必须是对象。', {
                field: 'payload', expected: 'record', actualType: valueType(payload),
            });
        for (const listName of WORLD_INFO_LORE_LISTS) {
            if (!Array.isArray(payload[listName]))
                throw new ToolkitError('HOST_EVENT_INVALID', `WORLDINFO_ENTRIES_LOADED 缺少或包含非法 ${listName} 数组。`, {
                    field: listName, expected: 'array', actualType: valueType(payload[listName]),
                });
        }
        return payload;
    },
    subscribeWorldInfoEntriesLoaded(listener, onContractError, options = {}) {
        if (typeof listener !== 'function' || typeof onContractError !== 'function')
            throw new TypeError('世界书条目加载订阅需要 listener 与 onContractError 回调');
        const wrapped = payload => {
            let validated;
            try {
                validated = this.validateWorldInfoEntriesPayload(payload);
            }
            catch (error) {
                return onContractError(error);
            }
            // The host awaits this result before scanning the same mutable arrays.
            return listener(validated);
        };
        if (options.last !== true)
            return this.onHostEvent('WORLDINFO_ENTRIES_LOADED', wrapped);
        const context = this.context;
        const event = context.eventTypes?.WORLDINFO_ENTRIES_LOADED;
        const emitter = context.eventSource;
        const remove = typeof emitter?.off === 'function'
            ? emitter.off.bind(emitter)
            : typeof emitter?.removeListener === 'function' ? emitter.removeListener.bind(emitter) : null;
        if (!event || typeof emitter?.makeLast !== 'function' || typeof remove !== 'function')
            throw new ToolkitError('HOST_EVENT_MISSING', '宿主缺少世界书末位监听或事件移除接口。');
        // makeLast itself registers; do not call on first (it could auto-fire twice).
        emitter.makeLast(event, wrapped);
        return () => remove(event, wrapped);
    },
    async getMountedWorldInfoEntries() {
        const cache = this.worldInfoModule?.worldInfoCache;
        if (!cache || typeof cache.get !== 'function')
            throw new ToolkitError('HOST_EXPORT_MISSING', 'TauriTavern 缺少世界书缓存访问接口。');
        const groups = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
        const bySource = { global: 'globalLore', character: 'characterLore', chat: 'chatLore', persona: 'personaLore' };
        const uncached = [];
        const unreadable = [];
        for (const { name, source } of this.activeWorldInfoBindings()) {
            const listName = bySource[source];
            if (!listName)
                continue;
            const data = cache.get(name);
            const entries = data?.entries;
            if (data === undefined) {
                uncached.push(name);
                continue;
            }
            if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
                unreadable.push(name);
                continue;
            }
            for (const entry of Object.values(entries)) {
                if (!entry || typeof entry !== 'object')
                    continue;
                groups[listName].push({ ...entry, world: name });
            }
        }
        if (uncached.length || unreadable.length) {
            const books = names => names.map(name => `「${name}」`).join('、');
            const details = [uncached.length ? `未加载：${books(uncached)}` : '',
                unreadable.length ? `条目列表不可读取：${books(unreadable)}` : ''].filter(Boolean).join('；');
            throw new ToolkitError(WORLD_INFO_SNAPSHOT_INCOMPLETE,
                `挂载世界书来源不完整（${details}）。请在宿主打开这些书，确认能正常读取后重试。`,
                { uncachedCount: uncached.length, unreadableCount: unreadable.length });
        }
        return groups;
    },
    async expandPromptConflictSourceMacros(content) {
        return this.macroProcess(content);
    },
    async promptConflictWorldDigest(worldName) {
        return sha256Hex(worldName);
    }
};
