import { ToolkitError } from '../../kernel/errors.js';
import { sha256BytesHex } from '../../kernel/hash.js';
import {
    ALLOWED_IMAGE_MIME_TYPES,
    WORLD_INFO_IMAGE_TABLE,
    parseEntryImageBinding,
    readEntryImageBinding,
} from './schema.js';

const SUPPORTED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

export function detectImageMimeFromBytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.length >= 8
        && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47
        && view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a) {
        return 'image/png';
    }
    if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
        return 'image/jpeg';
    }
    if (view.length >= 12
        && view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46
        && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) {
        return 'image/webp';
    }
    if (view.length >= 6
        && view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x38
        && (view[4] === 0x37 || view[4] === 0x39) && view[5] === 0x61) {
        return 'image/gif';
    }
    return null;
}

export function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < view.length; offset += chunkSize) {
        const chunk = view.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export async function blobToDataUrl(blob, fallbackMimeType = '') {
    if (!blob || typeof blob.arrayBuffer !== 'function')
        throw new ToolkitError('WORLD_INFO_IMAGE_INVALID', '图片数据不可读。');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength === 0)
        throw new ToolkitError('WORLD_INFO_IMAGE_EMPTY', '图片文件为空。');
    const mimeType = detectImageMimeFromBytes(bytes)
        || (Object.hasOwn(ALLOWED_IMAGE_MIME_TYPES, blob.type) ? blob.type : '')
        || (Object.hasOwn(ALLOWED_IMAGE_MIME_TYPES, fallbackMimeType) ? fallbackMimeType : '');
    if (!mimeType || !Object.hasOwn(ALLOWED_IMAGE_MIME_TYPES, mimeType))
        throw new ToolkitError('WORLD_INFO_IMAGE_UNSUPPORTED_MIME', '仅支持 PNG、JPEG、WebP 或 GIF 图片。');
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

export async function prepareImageBlobBinding(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function')
        throw new ToolkitError('WORLD_INFO_IMAGE_INVALID', '请选择有效的图片文件。');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength === 0)
        throw new ToolkitError('WORLD_INFO_IMAGE_EMPTY', '图片文件为空。');
    const mimeType = detectImageMimeFromBytes(bytes);
    if (!mimeType || !Object.hasOwn(ALLOWED_IMAGE_MIME_TYPES, mimeType)) {
        throw new ToolkitError('WORLD_INFO_IMAGE_UNSUPPORTED_MIME', '仅支持有效的 PNG、JPEG、WebP 或 GIF 图片。');
    }
    const digest = await sha256BytesHex(bytes);
    const ext = ALLOWED_IMAGE_MIME_TYPES[mimeType];
    const binding = parseEntryImageBinding({
        schemaVersion: 1,
        blobKey: `img-${digest}.${ext}`,
        mimeType,
        sizeBytes: bytes.byteLength,
    });
    return {
        binding,
        blob: new Blob([bytes], { type: mimeType }),
        dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    };
}

export function validateImageImportUrl(rawUrl) {
    const trimmed = String(rawUrl ?? '').trim();
    if (!trimmed)
        throw new ToolkitError('WORLD_INFO_IMAGE_URL_INVALID', '请输入图片 URL。');
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new ToolkitError('WORLD_INFO_IMAGE_URL_INVALID', '图片 URL 格式无效。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol))
        throw new ToolkitError('WORLD_INFO_IMAGE_URL_INVALID', '图片 URL 只支持 http 或 https 协议。');
    if (parsed.username || parsed.password)
        throw new ToolkitError('WORLD_INFO_IMAGE_URL_INVALID', '图片 URL 不得包含内嵌凭据。');
    return parsed.toString();
}

export async function fetchImageFromUrl(rawUrl, fetchImpl = globalThis.fetch) {
    const url = validateImageImportUrl(rawUrl);
    if (typeof fetchImpl !== 'function')
        throw new ToolkitError('WORLD_INFO_IMAGE_FETCH_UNAVAILABLE', '当前环境不支持网络下载图片。');
    let response;
    try {
        response = await fetchImpl(url);
    }
    catch {
        throw new ToolkitError('WORLD_INFO_IMAGE_FETCH_FAILED', '图片 URL 下载失败（网络异常或跨域限制），请改用本地文件导入。');
    }
    if (!response?.ok) {
        throw new ToolkitError('WORLD_INFO_IMAGE_FETCH_FAILED', `图片 URL 下载失败（HTTP ${response?.status ?? '未知'}），请改用本地文件导入。`);
    }
    const blob = await response.blob();
    return prepareImageBlobBinding(blob);
}

/**
 * 在最终 chat 消息数组中寻找安全的统一插图位置：
 * 优先插在最后一条非工具回合的 user 消息之后；若末尾存在 assistant prefill / continue nudge / tool 回合，
 * 则保证不会插在 assistant prefill 或未闭合的 tool_calls 之后。
 */
export function findWorldInfoImageInsertIndex(chat) {
    if (!Array.isArray(chat) || chat.length === 0)
        return 0;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || typeof message !== 'object')
            continue;
        if (message.role === 'user')
            return index + 1;
        if (message.role === 'tool' || Array.isArray(message.tool_calls))
            continue;
    }
    // 若没有任何 user 消息，放在末尾 assistant（如 continue_prefill）之前，否则放末尾
    const last = chat[chat.length - 1];
    if (last && typeof last === 'object' && last.role === 'assistant')
        return chat.length - 1;
    return chat.length;
}

export function extractActivatedImageEntries(entries) {
    if (!Array.isArray(entries))
        return [];
    const results = [];
    const seen = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object')
            continue;
        const world = typeof entry.world === 'string' ? entry.world : '';
        const uid = entry.uid ?? '';
        const dedupKey = `${world}\u0000${String(uid)}`;
        if (seen.has(dedupKey))
            continue;
        let binding = null;
        try {
            binding = readEntryImageBinding(entry);
        }
        catch {
            results.push({ world, uid, comment: String(entry.comment ?? '').trim(), binding: null, invalid: true });
            seen.add(dedupKey);
            continue;
        }
        if (!binding)
            continue;
        seen.add(dedupKey);
        results.push({
            world,
            uid,
            comment: String(entry.comment ?? '').trim(),
            content: String(entry.content ?? '').trim(),
            binding,
            invalid: false,
        });
    }
    return results;
}

export class WorldInfoImageRuntime {
    constructor(host, log) {
        this.host = host;
        this.log = log;
        this.active = false;
        this.disposers = [];
        this.generationType = null;
        this.sentActivatedEntries = [];
        this.dryRunActivatedEntries = [];
    }

    async activate() {
        if (this.active)
            return;
        const add = (name, handler) => {
            this.disposers.push(this.host.onHostEvent(name, handler));
        };
        try {
            add('GENERATION_STARTED', (type, _options, dryRun) => {
                if (dryRun === true) {
                    this.dryRunActivatedEntries = [];
                    return;
                }
                this.generationType = SUPPORTED_GENERATION_TYPES.has(String(type ?? 'normal')) ? String(type ?? 'normal') : null;
                this.sentActivatedEntries = [];
            });
            add('GENERATION_AFTER_COMMANDS', (type, _options, dryRun) => {
                if (dryRun === true) {
                    this.dryRunActivatedEntries = [];
                    return;
                }
                this.generationType = SUPPORTED_GENERATION_TYPES.has(String(type ?? 'normal')) ? String(type ?? 'normal') : null;
                this.sentActivatedEntries = [];
            });
            add('WORLDINFO_SCAN_DONE', payload => {
                if (!payload || typeof payload !== 'object' || payload.isFinal !== true)
                    return;
                const values = typeof payload.activated?.entries?.values === 'function'
                    ? Array.from(payload.activated.entries.values())
                    : [];
                if (payload.isDryRun === true)
                    this.dryRunActivatedEntries = values;
                else
                    this.sentActivatedEntries = values;
            });
            add('WORLD_INFO_ACTIVATED', entries => {
                if (Array.isArray(entries))
                    this.sentActivatedEntries = entries;
            });
            add('CHAT_COMPLETION_PROMPT_READY', payload => this.onPromptReady(payload));
            for (const name of ['GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED']) {
                add(name, () => {
                    this.generationType = null;
                    this.sentActivatedEntries = [];
                    this.dryRunActivatedEntries = [];
                });
            }
            this.active = true;
        }
        catch (error) {
            for (const dispose of this.disposers.splice(0))
                dispose();
            this.active = false;
            throw error;
        }
    }

    deactivate() {
        this.active = false;
        this.generationType = null;
        this.sentActivatedEntries = [];
        this.dryRunActivatedEntries = [];
        for (const dispose of this.disposers.splice(0))
            dispose();
    }

    async saveImageBlob(blob) {
        const prepared = await prepareImageBlobBinding(blob);
        await this.host.storeSetBlob(WORLD_INFO_IMAGE_TABLE, prepared.binding.blobKey, prepared.blob);
        this.log?.info('image.saved', {
            data: {
                operation: 'world_info_image.save',
                mimeType: prepared.binding.mimeType,
                sizeBytes: prepared.binding.sizeBytes,
            },
        });
        return prepared;
    }

    async importImageFromUrl(rawUrl, fetchImpl) {
        const prepared = await fetchImageFromUrl(rawUrl, fetchImpl);
        await this.host.storeSetBlob(WORLD_INFO_IMAGE_TABLE, prepared.binding.blobKey, prepared.blob);
        this.log?.info('image.imported_url', {
            data: {
                operation: 'world_info_image.import_url',
                mimeType: prepared.binding.mimeType,
                sizeBytes: prepared.binding.sizeBytes,
            },
        });
        return prepared;
    }

    async loadImageDataUrl(binding) {
        const parsed = parseEntryImageBinding(binding);
        const blob = await this.host.storeGetBlob(WORLD_INFO_IMAGE_TABLE, parsed.blobKey);
        return blobToDataUrl(blob, parsed.mimeType);
    }

    async onPromptReady(payload) {
        if (!this.active || !payload || typeof payload !== 'object' || !Array.isArray(payload.chat))
            return;
        const dryRun = payload.dryRun === true;
        if (!dryRun && !this.generationType)
            return;
        const sourceEntries = dryRun ? this.dryRunActivatedEntries : this.sentActivatedEntries;
        const candidates = extractActivatedImageEntries(sourceEntries);
        if (candidates.length === 0) {
            this.host.recordWorldInfoInjectedPromptMessages?.([], { dryRun });
            return;
        }

        const preparedMessages = [];
        const viewerMessages = [];
        let skippedCount = 0;

        for (let index = 0; index < candidates.length; index++) {
            const item = candidates[index];
            if (item.invalid || !item.binding) {
                skippedCount += 1;
                this.log?.warn('image.binding_invalid', {
                    data: {
                        operation: 'world_info_image.inject',
                        stage: 'validate_binding',
                        reasonCode: 'WORLD_INFO_IMAGE_BINDING_INVALID',
                        entryIndex: index,
                        result: 'skipped',
                        recoveryAction: 'rebind_entry_image',
                    },
                });
                continue;
            }
            let dataUrl;
            try {
                dataUrl = await this.loadImageDataUrl(item.binding);
            }
            catch {
                skippedCount += 1;
                this.log?.warn('image.blob_missing_or_unreadable', {
                    data: {
                        operation: 'world_info_image.inject',
                        stage: 'read_blob',
                        reasonCode: 'WORLD_INFO_IMAGE_BLOB_READ_FAILED',
                        entryIndex: index,
                        mimeType: item.binding.mimeType,
                        sizeBytes: item.binding.sizeBytes,
                        result: 'skipped',
                        recoveryAction: 'reupload_entry_image',
                    },
                });
                continue;
            }
            const title = item.comment || `#${String(item.uid)}`;
            const description = item.binding.description ?? '';
            const caption = `[世界书图片: ${title}]${description ? `\n${description}` : ''}`;
            const identifier = `worldInfoImage_${index + 1}`;
            try {
                const built = await this.host.buildWorldInfoImageMessage({
                    text: caption,
                    images: [dataUrl],
                    identifier,
                });
                if (!built?.chatMessage) {
                    skippedCount += 1;
                    continue;
                }
                preparedMessages.push(built.chatMessage);
                viewerMessages.push({
                    identifier,
                    role: built.chatMessage.role ?? 'user',
                    content: built.chatMessage.content,
                    tokens: built.tokens,
                    promptName: `世界书图片（${title}）`,
                });
            }
            catch {
                skippedCount += 1;
                this.log?.warn('image.message_build_failed', {
                    data: {
                        operation: 'world_info_image.inject',
                        stage: 'build_message',
                        reasonCode: 'WORLD_INFO_IMAGE_BUILD_FAILED',
                        entryIndex: index,
                        result: 'skipped',
                        recoveryAction: 'check_host_openai_module',
                    },
                });
            }
        }

        if (preparedMessages.length === 0) {
            this.host.recordWorldInfoInjectedPromptMessages?.([], { dryRun });
            return;
        }

        const insertIndex = findWorldInfoImageInsertIndex(payload.chat);
        payload.chat.splice(insertIndex, 0, ...preparedMessages);
        this.host.recordWorldInfoInjectedPromptMessages?.(
            viewerMessages.map((msg, idx) => ({ ...msg, insertIndex: insertIndex + idx })),
            { dryRun },
        );

        this.log?.info('image.injected', {
            data: {
                operation: 'world_info_image.inject',
                dryRun,
                injectedCount: preparedMessages.length,
                skippedCount,
                insertIndex,
            },
        });
    }
}
