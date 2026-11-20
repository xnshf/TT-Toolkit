import { estimateTokens, normalizeEntry } from './schema.js';
import { readEntryImageBindingSafe } from '../world-info-images/schema.js';

/** 单个条目结构异常只降级该条目：整本世界书仍可浏览，坏条目仍可被删除。 */
export function summarizeEntries(entries) {
    const items = [];
    for (const [key, entry] of Object.entries(entries ?? {})) {
        // 异常条目的删除入口必须保留原键；例如 "03" 不能指向 "3"。
        const numericKey = Number(key);
        const uid = Number.isSafeInteger(numericKey) && String(numericKey) === key ? numericKey : key;
        try {
            const normalized = normalizeEntry(entry, typeof uid === 'number' ? uid : 0);
            const { binding, invalid } = readEntryImageBindingSafe(entry);
            items.push({ ...normalized, hasImage: Boolean(binding), imageInvalid: invalid, imageBinding: binding, broken: false });
        }
        catch {
            items.push({
                uid, comment: '(结构异常的条目)', content: '', key: [], keysecondary: [],
                constant: false, disable: false, position: null, depth: 0, order: 0,
                selective: false, hasImage: false, imageInvalid: false, imageBinding: null, broken: true,
            });
        }
    }
    return items;
}

export function filterEntries(items, { query = '', filter = 'all', sort = 'order' } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    return items.filter(item => {
        if (needle && ![item.comment, String(item.uid), item.content, item.imageBinding?.description ?? '', ...item.key, ...item.keysecondary]
            .some(value => String(value).toLowerCase().includes(needle))) return false;
        switch (filter) {
            case 'constant': return item.constant;
            case 'active': return !item.broken && !item.disable;
            case 'disabled': return item.disable;
            case 'depth': return item.position === 4;
            case 'image': return item.hasImage || item.imageInvalid;
            case 'unimaged': return !item.hasImage && !item.imageInvalid && !item.broken;
            case 'invalid-image': return item.imageInvalid || item.broken;
            default: return true;
        }
    }).sort((a, b) => {
        switch (sort) {
            case 'uid': return a.uid - b.uid;
            case 'title': return a.comment.localeCompare(b.comment, 'zh-CN');
            case 'tokens': return estimateTokens(b.content) - estimateTokens(a.content);
            default: return a.order - b.order;
        }
    });
}

export function statsForEntries(entries) {
    const list = summarizeEntries(entries);
    const stats = { total: list.length, constant: 0, active: 0, disabled: 0, totalTokens: 0, imageCount: 0, imageTotalBytes: 0 };
    for (const entry of list) {
        if (entry.broken) continue;
        if (entry.constant) stats.constant++;
        if (entry.disable) stats.disabled++;
        else stats.active++;
        stats.totalTokens += estimateTokens(entry.content);
        if (entry.imageBinding) {
            stats.imageCount++;
            stats.imageTotalBytes += entry.imageBinding.sizeBytes;
        }
    }
    return stats;
}
