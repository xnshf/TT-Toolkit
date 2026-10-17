import { ToolkitError } from '../../kernel/errors.js';
import { sha256Hex } from '../../kernel/hash.js';
import { embedWorldInfoAiConfig, parseWorldInfoAiConfig, readEmbeddedWorldInfoAiConfig,
    WORLD_INFO_EXTENSION_KEY, WORLD_INFO_ROUTER_FIELD } from './schema.js';

const TABLE = 'world-info-ai';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function legacyKey(name) {
    return name === name.trim() && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) ? name : null;
}
export async function worldInfoFallbackKey(name) { return `world-${await sha256Hex(name)}`; }

export class WorldInfoAiConfigStore {
    constructor(host, log) { this.host = host; this.log = log; }
    async fallback(name) {
        const key = await worldInfoFallbackKey(name);
        let value = await this.host.storeTryGetJson(TABLE, key);
        if (value === undefined && legacyKey(name)) value = await this.host.storeTryGetJson(TABLE, legacyKey(name));
        return value;
    }
    async load(name, worldData = null) {
        const data = worldData ?? await this.host.loadWorldInfoFresh(name);
        if (!data || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries))
            throw new ToolkitError('WORLD_INFO_NOT_FOUND', '世界书条目集合不可用，请重新读取。');
        // A fallback is authoritative until a verified embedded save removes it.
        const fallback = await this.fallback(name);
        const embedded = readEmbeddedWorldInfoAiConfig(data);
        return { data, config: parseWorldInfoAiConfig(fallback !== undefined ? fallback : embedded),
            backend: fallback !== undefined ? 'extension-store' : embedded === undefined ? 'default' : 'world-extension' };
    }
    async assertUnchanged(name, expected) {
        const fresh = await this.host.loadWorldInfoFresh(name);
        if (!fresh || (expected && !same(fresh, expected)))
            throw new ToolkitError('WORLD_INFO_STALE', '世界书已被其它操作修改，草稿已保留；请重新读取后核对，不会覆盖新内容。');
        return fresh;
    }
    async save(name, config, worldData) {
        const validated = parseWorldInfoAiConfig(config);
        const data = await this.assertUnchanged(name, worldData);
        let fresh;
        try {
            await this.host.saveWorldInfo(name, embedWorldInfoAiConfig(data, validated));
            fresh = await this.host.loadWorldInfoFresh(name);
            const embedded = readEmbeddedWorldInfoAiConfig(fresh);
            if (embedded === undefined || !same(parseWorldInfoAiConfig(embedded), validated))
                throw new ToolkitError('WORLD_INFO_EXTENSION_DROPPED', '宿主未完整保留决策配置扩展字段。');
        }
        catch (error) {
            // Only config goes into this table; never copy the world book or credentials.
            await this.host.storeSetJson(TABLE, await worldInfoFallbackKey(name), validated);
            this.log?.warn('config.fallback_saved', { data: { operation: 'config.save', stage: 'world-extension',
                reason: error instanceof ToolkitError ? error.code : 'WORLD_EXTENSION_UNAVAILABLE',
                sourceLocation: 'features/world-info-ai/storage.js:save', outcome: 'extension-store', nextAction: 'none' } });
            return { data: fresh ?? data, config: validated, backend: 'extension-store' };
        }
        await this.cleanup(name);
        return { data: fresh, config: validated, backend: 'world-extension' };
    }
    async cleanup(name) {
        for (const key of new Set([await worldInfoFallbackKey(name), legacyKey(name)].filter(Boolean))) {
            if (await this.host.storeTryGetJson(TABLE, key) !== undefined) await this.host.storeDeleteJson(TABLE, key);
        }
    }
    async reset(name, worldData = null) {
        const data = await this.assertUnchanged(name, worldData);
        const next = structuredClone(data);
        const toolkit = next.extensions?.[WORLD_INFO_EXTENSION_KEY];
        if (toolkit && typeof toolkit === 'object' && !Array.isArray(toolkit) && Object.hasOwn(toolkit, WORLD_INFO_ROUTER_FIELD)) {
            delete toolkit[WORLD_INFO_ROUTER_FIELD];
            await this.host.saveWorldInfo(name, next);
            const fresh = await this.host.loadWorldInfoFresh(name);
            if (readEmbeddedWorldInfoAiConfig(fresh) !== undefined)
                throw new ToolkitError('WORLD_INFO_RESET_FAILED', '世界书决策配置未能清除，请重新读取并重试。');
        }
        await this.cleanup(name);
        return this.load(name);
    }
}
