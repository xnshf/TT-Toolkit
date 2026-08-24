import { ToolkitError } from '../../kernel/errors.js';
import { sha256Hex } from '../../kernel/hash.js';
import {
    embedWorldInfoAiConfig,
    parseWorldInfoAiConfig,
    readEmbeddedWorldInfoAiConfig,
} from './schema.js';

const FALLBACK_TABLE = 'world-info-ai';

function legacyFallbackKey(worldName) {
    const value = String(worldName);
    if (value !== value.trim() || value === '.' || value === '..' || value.startsWith('.') || !/^[A-Za-z0-9_.-]+$/.test(value))
        return null;
    return value;
}

export async function worldInfoFallbackKey(worldName) {
    const digest = await sha256Hex(String(worldName));
    return `world-${digest}`;
}

function sameConfig(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export class WorldInfoAiConfigStore {
    constructor(host, log) {
        this.host = host;
        this.log = log;
    }

    async load(worldName, worldData = null) {
        const data = worldData ?? await this.host.loadWorldInfo(worldName);
        if (!data)
            throw new ToolkitError('WORLD_INFO_NOT_FOUND', '世界书不存在或无法读取。');
        const embedded = readEmbeddedWorldInfoAiConfig(data);
        if (embedded !== undefined) {
            return { data, config: parseWorldInfoAiConfig(embedded), backend: 'world-extension' };
        }
        const fallbackKey = await worldInfoFallbackKey(worldName);
        let fallback = await this.host.storeTryGetJson(FALLBACK_TABLE, fallbackKey);
        if (fallback === undefined) {
            const legacyKey = legacyFallbackKey(worldName);
            if (legacyKey)
                fallback = await this.host.storeTryGetJson(FALLBACK_TABLE, legacyKey);
        }
        return {
            data,
            config: parseWorldInfoAiConfig(fallback),
            backend: fallback === undefined ? 'default' : 'extension-store',
        };
    }

    async save(worldName, config, worldData = null) {
        const validated = parseWorldInfoAiConfig(config);
        const data = worldData ?? await this.host.loadWorldInfo(worldName);
        if (!data)
            throw new ToolkitError('WORLD_INFO_NOT_FOUND', '世界书不存在或无法读取。');
        const fallbackKey = await worldInfoFallbackKey(worldName);
        const legacyKey = legacyFallbackKey(worldName);

        try {
            await this.host.saveWorldInfo(worldName, embedWorldInfoAiConfig(data, validated));
            const fresh = await this.host.loadWorldInfoFresh(worldName);
            const persisted = readEmbeddedWorldInfoAiConfig(fresh);
            if (persisted === undefined || !sameConfig(parseWorldInfoAiConfig(persisted), validated))
                throw new ToolkitError('WORLD_INFO_EXTENSION_DROPPED', '宿主未完整保留世界书扩展字段。');
            await this.cleanupFallback(fallbackKey, legacyKey);
            this.log?.info('config.saved', { data: { backend: 'world-extension' }, sensitive: { worldName } });
            return { data: fresh, config: validated, backend: 'world-extension' };
        }
        catch (error) {
            this.log?.warn('config.world_extension_unavailable', {
                data: { kind: error instanceof ToolkitError ? error.code : error instanceof Error ? error.name : typeof error },
                sensitive: { worldName, error },
            });
            try {
                await this.host.storeSetJson(FALLBACK_TABLE, fallbackKey, validated);
                if (legacyKey)
                    await this.cleanupFallback(legacyKey, null);
            }
            catch (fallbackError) {
                this.log?.error('config.fallback_save_failed', {
                    data: { kind: fallbackError instanceof ToolkitError ? fallbackError.code : fallbackError instanceof Error ? fallbackError.name : typeof fallbackError },
                    sensitive: { worldName, error: fallbackError },
                });
                throw fallbackError;
            }
            this.log?.info('config.saved', { data: { backend: 'extension-store' }, sensitive: { worldName } });
            return { data, config: validated, backend: 'extension-store' };
        }
    }

    async cleanupFallback(...keys) {
        try {
            for (const key of keys) {
                if (key === null || key === undefined)
                    continue;
                const existing = await this.host.storeTryGetJson(FALLBACK_TABLE, key);
                if (existing !== undefined)
                    await this.host.storeDeleteJson(FALLBACK_TABLE, key);
            }
        }
        catch (error) {
            this.log?.warn('config.fallback_cleanup_failed', {
                data: { kind: error instanceof ToolkitError ? error.code : error instanceof Error ? error.name : typeof error },
                sensitive: { error },
            });
        }
    }
}
