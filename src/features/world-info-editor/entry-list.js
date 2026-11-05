import { estimateTokens, normalizeEntry } from './schema.js';
import { readEntryImageBindingSafe } from '../world-info-images/schema.js';

/** 单个条目结构异常只降级该条目：整本世界书仍可浏览，坏条目仍可被删除。 */
export function summarizeEntries(entries) {
    const items = [];
    for (const [key, entry] of Object.entries(entries ?? {})) {
        const uid = Number.isFinite(Number(key)) ? Number(key) : key;
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
            case 'active': return !item.disable;
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
    const list = Object.values(entries ?? {});
    let imageCount = 0;
    let imageTotalBytes = 0;
    for (const entry of list) {
        const { binding } = readEntryImageBindingSafe(entry);
        if (binding) {
            imageCount += 1;
            imageTotalBytes += binding.sizeBytes;
        }
    }
    return {
        total: list.length,
        constant: list.filter(entry => entry.constant).length,
        active: list.filter(entry => !entry.disable).length,
        disabled: list.filter(entry => entry.disable).length,
        totalTokens: list.reduce((total, entry) => total + estimateTokens(entry.content), 0),
        imageCount,
        imageTotalBytes,
    };
}
