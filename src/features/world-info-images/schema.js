import { ToolkitError } from '../../kernel/errors.js';

export const WORLD_INFO_IMAGE_EXTENSION_KEY = 'tt-toolkit';
export const WORLD_INFO_IMAGE_FIELD = 'image';
export const WORLD_INFO_IMAGE_TABLE = 'world-info-images';
export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
});
const BLOB_KEY_PATTERN = /^img-[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

export function parseEntryImageBinding(value) {
    if (value === undefined || value === null)
        return null;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目图片绑定必须是对象。');
    const keys = Object.keys(value);
    const required = ['schemaVersion', 'blobKey', 'mimeType', 'sizeBytes'];
    const allowed = [...required, 'description'];
    if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.includes(key)))
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目图片绑定包含缺失或未知字段。');
    if (value.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的世界书条目图片绑定版本：${String(value.schemaVersion)}`);
    if (typeof value.mimeType !== 'string' || !Object.hasOwn(ALLOWED_IMAGE_MIME_TYPES, value.mimeType))
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目图片 MIME 类型不受支持。');
    if (typeof value.blobKey !== 'string' || !BLOB_KEY_PATTERN.test(value.blobKey))
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目图片 blobKey 非法。');
    const ext = ALLOWED_IMAGE_MIME_TYPES[value.mimeType];
    if (!value.blobKey.endsWith(`.${ext}`))
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目图片扩展名与 MIME 不一致。');
    if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0)
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目图片大小必须是正整数。');
    if (Object.hasOwn(value, 'description') && typeof value.description !== 'string')
        throw new ToolkitError('INVALID_SCHEMA', '世界书图片描述必须是字符串。');
    return {
        ...(Object.hasOwn(value, 'description') ? { description: value.description } : {}),
        schemaVersion: 1,
        blobKey: value.blobKey,
        mimeType: value.mimeType,
        sizeBytes: value.sizeBytes,
    };
}

export function readEntryImageBinding(entry) {
    const raw = entry?.extensions?.[WORLD_INFO_IMAGE_EXTENSION_KEY]?.[WORLD_INFO_IMAGE_FIELD];
    if (raw === undefined || raw === null)
        return null;
    return parseEntryImageBinding(raw);
}

export function readEntryImageBindingSafe(entry) {
    try {
        return { binding: readEntryImageBinding(entry), invalid: false };
    }
    catch {
        return { binding: null, invalid: true };
    }
}

export function writeEntryImageBinding(entry, binding) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new ToolkitError('INVALID_SCHEMA', '世界书条目必须是对象。');
    const next = structuredClone(entry);
    const parsed = binding ? parseEntryImageBinding(binding) : null;
    const extensions = next.extensions && typeof next.extensions === 'object' && !Array.isArray(next.extensions)
        ? { ...next.extensions }
        : {};
    const toolkit = extensions[WORLD_INFO_IMAGE_EXTENSION_KEY] && typeof extensions[WORLD_INFO_IMAGE_EXTENSION_KEY] === 'object' && !Array.isArray(extensions[WORLD_INFO_IMAGE_EXTENSION_KEY])
        ? { ...extensions[WORLD_INFO_IMAGE_EXTENSION_KEY] }
        : {};
    if (parsed) {
        toolkit[WORLD_INFO_IMAGE_FIELD] = parsed;
        extensions[WORLD_INFO_IMAGE_EXTENSION_KEY] = toolkit;
        next.extensions = extensions;
    }
    else if (Object.hasOwn(toolkit, WORLD_INFO_IMAGE_FIELD)) {
        delete toolkit[WORLD_INFO_IMAGE_FIELD];
        if (Object.keys(toolkit).length > 0) {
            extensions[WORLD_INFO_IMAGE_EXTENSION_KEY] = toolkit;
            next.extensions = extensions;
        }
        else {
            delete extensions[WORLD_INFO_IMAGE_EXTENSION_KEY];
            if (Object.keys(extensions).length > 0)
                next.extensions = extensions;
            else
                delete next.extensions;
        }
    }
    return next;
}

