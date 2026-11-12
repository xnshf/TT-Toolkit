import { describe, expect, it, vi } from 'vitest';
import {
    detectImageMimeFromBytes,
    extractActivatedImageEntries,
    findWorldInfoImageInsertIndex,
    prepareImageBlobBinding,
    validateImageImportUrl,
    WorldInfoImageRuntime,
} from '../src/features/world-info-images/images.js';
import { convertEntryUserPlaceholders } from '../src/features/world-info-editor/schema.js';
import { fitWithinLimits } from '../src/features/world-info-images/compress.js';
import {
    parseEntryImageBinding,
    readEntryImageBinding,
    writeEntryImageBinding,
} from '../src/features/world-info-images/schema.js';

// 1x1 PNG（真实签名，用于 MIME 嗅探与 base64 往返）。
const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
]);

const BINDING = {
    schemaVersion: 1,
    blobKey: `img-${'a'.repeat(64)}.png`,
    mimeType: 'image/png',
    sizeBytes: 67,
};

describe('world info image schema', () => {
    it('parses a well-formed binding and rejects malformed variants', () => {
        expect(parseEntryImageBinding(BINDING)).toEqual(BINDING);
        expect(parseEntryImageBinding({ ...BINDING, description: '保留 user 原文' }).description).toBe('保留 user 原文');
        expect(() => parseEntryImageBinding({ ...BINDING, description: 42 })).toThrow(/描述/);
        expect(parseEntryImageBinding(undefined)).toBeNull();
        expect(() => parseEntryImageBinding({ ...BINDING, mimeType: 'image/svg+xml' })).toThrow(/MIME/);
        expect(() => parseEntryImageBinding({ ...BINDING, blobKey: 'img-x.jpg' })).toThrow(/blobKey/);
        expect(() => parseEntryImageBinding({ ...BINDING, blobKey: `img-${'a'.repeat(64)}.jpg` })).toThrow(/扩展名/);
        expect(() => parseEntryImageBinding({ ...BINDING, sizeBytes: 0 })).toThrow(/大小/);
        expect(() => parseEntryImageBinding({ ...BINDING, extra: 1 })).toThrow(/未知字段/);
        expect(() => parseEntryImageBinding({ ...BINDING, schemaVersion: 2 })).toThrow(/版本/);
    });

    it('writes and removes the binding without touching other extensions', () => {
        const entry = { uid: 1, extensions: { vendor: { keep: true }, 'tt-toolkit': { worldInfoAiRouter: { schemaVersion: 2 } } } };
        const bound = writeEntryImageBinding(entry, BINDING);
        expect(bound.extensions.vendor).toEqual({ keep: true });
        expect(bound.extensions['tt-toolkit'].worldInfoAiRouter).toEqual({ schemaVersion: 2 });
        expect(readEntryImageBinding(bound)).toEqual(BINDING);
        // 原对象不被就地修改，避免草稿与基线共享同一引用。
        expect(entry.extensions['tt-toolkit'].image).toBeUndefined();

        const removed = writeEntryImageBinding(bound, null);
        expect(readEntryImageBinding(removed)).toBeNull();
        expect(removed.extensions['tt-toolkit']).toEqual({ worldInfoAiRouter: { schemaVersion: 2 } });
        expect(removed.extensions.vendor).toEqual({ keep: true });

        const cleared = writeEntryImageBinding({ uid: 2, extensions: { 'tt-toolkit': { image: BINDING } } }, null);
        expect(cleared.extensions).toBeUndefined();
    });

    it('keeps extensions out of the standalone user macro conversion', () => {
        const { entry, count } = convertEntryUserPlaceholders({
            uid: 1,
            content: 'user 在此',
            extensions: { 'tt-toolkit': { image: { ...BINDING, blobKey: `img-${'a'.repeat(64)}.png` } } },
        });
        expect(count).toBe(1);
        expect(entry.content).toBe('{{user}} 在此');
        expect(entry.extensions['tt-toolkit'].image).toEqual(BINDING);
    });
});

describe('world info image preparation', () => {
    it('sniffs supported formats from bytes instead of the declared type', async () => {
        expect(detectImageMimeFromBytes(PNG_BYTES)).toBe('image/png');
        expect(detectImageMimeFromBytes(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
        expect(detectImageMimeFromBytes(Uint8Array.from([1, 2, 3]))).toBeNull();

        const prepared = await prepareImageBlobBinding(new Blob([PNG_BYTES], { type: 'application/octet-stream' }));
        expect(prepared.binding.mimeType).toBe('image/png');
        expect(prepared.binding.sizeBytes).toBe(PNG_BYTES.byteLength);
        expect(prepared.binding.blobKey).toMatch(/^img-[0-9a-f]{64}\.png$/);
        expect(prepared.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
        await expect(prepareImageBlobBinding(new Blob([Uint8Array.from([1, 2, 3])]))).rejects.toThrow(/仅支持/);
        await expect(prepareImageBlobBinding(new Blob([]))).rejects.toThrow(/为空/);
    });

    it('rejects GIF imports while keeping the format readable for existing bindings', async () => {
        const GIF_BYTES = Uint8Array.from([
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
        ]);
        expect(detectImageMimeFromBytes(GIF_BYTES)).toBe('image/gif');
        await expect(prepareImageBlobBinding(new Blob([GIF_BYTES], { type: 'image/gif' }))).rejects.toThrow(/GIF/);
    });

    it('scales down to the limits that vision providers actually use', () => {
        // 4:3 大图：总像素上限先触发（Claude 约 1.15MP 建议）。
        expect(fitWithinLimits(4000, 3000)).toEqual({ width: 1238, height: 929 });
        // 超宽图：长边上限先触发，短边仍高于 OpenAI 的 768。
        expect(fitWithinLimits(8000, 1000)).toEqual({ width: 1568, height: 196 });
        // 已在限制内的图片不放大。
        expect(fitWithinLimits(1024, 768)).toEqual({ width: 1024, height: 768 });
        expect(fitWithinLimits(0, 100)).toEqual({ width: 0, height: 0 });
    });

    it('accepts only http(s) import urls without embedded credentials', () => {
        expect(validateImageImportUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
        expect(() => validateImageImportUrl('')).toThrow(/请输入/);
        expect(() => validateImageImportUrl('ftp://example.com/a.png')).toThrow(/http/);
        expect(() => validateImageImportUrl('https://user:pass@example.com/a.png')).toThrow(/凭据/);
    });

    it('collects only valid bindings and reports broken ones', () => {
        const entries = [
            { world: 'A', uid: 1, comment: '正常', extensions: { 'tt-toolkit': { image: BINDING } } },
            { world: 'A', uid: 2, comment: '无图' },
            { world: 'A', uid: 3, comment: '损坏', extensions: { 'tt-toolkit': { image: { schemaVersion: 1 } } } },
            { world: 'A', uid: 1, comment: '正常', extensions: { 'tt-toolkit': { image: BINDING } } },
        ];
        const results = extractActivatedImageEntries(entries);
        expect(results.map(item => item.uid)).toEqual([1, 3]);
        expect(results[0].binding).toEqual(BINDING);
        expect(results[1].invalid).toBe(true);
    });
});

describe('world info image insert position', () => {
    it('anchors after the last user message and before trailing control messages', () => {
        expect(findWorldInfoImageInsertIndex([])).toBe(0);
        expect(findWorldInfoImageInsertIndex([{ role: 'system' }, { role: 'user' }])).toBe(2);
        // continue prefill：末尾 assistant 是待续写内容，图片必须插到它之前。
        expect(findWorldInfoImageInsertIndex([{ role: 'user' }, { role: 'assistant' }])).toBe(1);
        // 工具回合未闭合时不跨越 tool_calls / tool 结果。
        expect(findWorldInfoImageInsertIndex([
            { role: 'user' },
            { role: 'assistant', tool_calls: [{ id: 'c1' }] },
            { role: 'tool' },
        ])).toBe(1);
    });
});

function createHost({ blobs = new Map(), buildImpl } = {}) {
    const handlers = {};
    const built = [];
    const host = {
        onHostEvent: vi.fn((name, handler) => {
            handlers[name] = handler;
            return () => { delete handlers[name]; };
        }),
        storeGetBlob: vi.fn(async (table, key) => {
            if (!blobs.has(key))
                throw new Error('not found');
            return blobs.get(key);
        }),
        storeSetBlob: vi.fn(async (table, key, data) => { blobs.set(key, data); }),
        buildWorldInfoImageMessage: vi.fn(buildImpl ?? (async ({ text, images, identifier }) => {
            built.push({ text, images, identifier });
            return {
                chatMessage: {
                    role: 'user',
                    content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))],
                },
                tokens: 100,
                attachedCount: images.length,
            };
        })),
        recordWorldInfoInjectedPromptMessages: vi.fn(),
        _handlers: handlers,
        _built: built,
    };
    return host;
}

function logger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const TRIGGERED = [{
    world: 'A',
    uid: 1,
    comment: '圣殿',
    extensions: { 'tt-toolkit': { image: BINDING } },
}];

describe('world info image injection', () => {
    it('inserts a user image message for an activated entry', async () => {
        const blobs = new Map([[BINDING.blobKey, new Blob([PNG_BYTES], { type: 'image/png' })]]);
        const host = createHost({ blobs });
        const runtime = new WorldInfoImageRuntime(host, logger());
        await runtime.activate();

        host._handlers.GENERATION_STARTED('normal', {}, false);
        host._handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: false, activated: { entries: new Map([[1, TRIGGERED[0]]]) } });
        const chat = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat, dryRun: false });

        expect(chat).toHaveLength(3);
        const inserted = chat[2];
        expect(inserted.role).toBe('user');
        expect(inserted.content[0].text).toContain('圣殿');
        expect(inserted.content[1].type).toBe('image_url');
        expect(inserted.content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
        expect(host.recordWorldInfoInjectedPromptMessages).toHaveBeenCalledWith(
            [expect.objectContaining({ identifier: 'worldInfoImage_1', insertIndex: 2 })],
            { dryRun: false },
        );
        runtime.deactivate();
    });

    it('sends the independent description with the image in real and dry-run requests', async () => {
        const host = createHost({ blobs: new Map([[BINDING.blobKey, new Blob([PNG_BYTES])]]) });
        const log = logger();
        const runtime = new WorldInfoImageRuntime(host, log);
        await runtime.activate();
        const entry = structuredClone(TRIGGERED[0]);
        const description = 'user 身穿银色盔甲，站在圣殿门口。';
        entry.extensions['tt-toolkit'].image.description = description;
        for (const dryRun of [false, true]) {
            host._handlers.GENERATION_STARTED('normal', {}, dryRun);
            host._handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: dryRun, activated: { entries: new Map([[1, entry]]) } });
            const chat = [{ role: 'user', content: 'hi' }];
            await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat, dryRun });
            expect(chat[1].content[0].text).toBe('[世界书图片: 圣殿]\n' + description);
        }
        expect(JSON.stringify(log.info.mock.calls)).not.toContain(description);
        runtime.deactivate();
    });

    it('keeps the round going and only drops the failing image', async () => {
        const host = createHost({ blobs: new Map() });
        const runtime = new WorldInfoImageRuntime(host, logger());
        await runtime.activate();

        host._handlers.GENERATION_STARTED('normal', {}, false);
        host._handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: false, activated: { entries: new Map([[1, TRIGGERED[0]]]) } });
        const chat = [{ role: 'user', content: 'hi' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat, dryRun: false });

        expect(chat).toHaveLength(1);
        expect(host._built).toHaveLength(0);
        expect(runtime.log.warn).toHaveBeenCalledWith('image.blob_missing_or_unreadable', expect.objectContaining({
            data: expect.objectContaining({ reasonCode: 'WORLD_INFO_IMAGE_BLOB_READ_FAILED', result: 'skipped' }),
        }));
        // 日志只记录计数与类型，不含图片内容或文件名。
        const logged = JSON.stringify(runtime.log.warn.mock.calls);
        expect(logged).not.toContain('base64');
    });

    it('does not attach images when the entry did not activate or the feature is off', async () => {
        const blobs = new Map([[BINDING.blobKey, new Blob([PNG_BYTES], { type: 'image/png' })]]);
        const host = createHost({ blobs });
        const runtime = new WorldInfoImageRuntime(host, logger());
        await runtime.activate();

        host._handlers.GENERATION_STARTED('normal', {}, false);
        const chat = [{ role: 'user', content: 'hi' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat, dryRun: false });
        expect(chat).toHaveLength(1);

        host._handlers.GENERATION_STARTED('normal', {}, false);
        host._handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: false, activated: { entries: new Map([[1, TRIGGERED[0]]]) } });
        runtime.deactivate();
        const after = [{ role: 'user', content: 'hi' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY?.({ chat: after, dryRun: false });
        expect(after).toHaveLength(1);
    });

    it('uses the dry-run activation set without touching the sent one', async () => {
        const blobs = new Map([[BINDING.blobKey, new Blob([PNG_BYTES], { type: 'image/png' })]]);
        const host = createHost({ blobs });
        const runtime = new WorldInfoImageRuntime(host, logger());
        await runtime.activate();

        host._handlers.GENERATION_STARTED('normal', {}, true);
        host._handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: true, activated: { entries: new Map([[1, TRIGGERED[0]]]) } });
        const prediction = [{ role: 'user', content: 'hypothetical' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat: prediction, dryRun: true });
        expect(prediction).toHaveLength(2);
        expect(host.recordWorldInfoInjectedPromptMessages).toHaveBeenCalledWith(
            [expect.objectContaining({ identifier: 'worldInfoImage_1' })],
            { dryRun: true },
        );

        // 真实发送轮次不继承 dry-run 的激活集合。
        host._handlers.GENERATION_STARTED('normal', {}, false);
        const sent = [{ role: 'user', content: 'hi' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat: sent, dryRun: false });
        expect(sent).toHaveLength(1);
        runtime.deactivate();
    });

    it('skips unsupported generation types such as quiet requests', async () => {
        const blobs = new Map([[BINDING.blobKey, new Blob([PNG_BYTES], { type: 'image/png' })]]);
        const host = createHost({ blobs });
        const runtime = new WorldInfoImageRuntime(host, logger());
        await runtime.activate();

        host._handlers.GENERATION_STARTED('quiet', {}, false);
        host._handlers.WORLDINFO_SCAN_DONE({ isFinal: true, isDryRun: false, activated: { entries: new Map([[1, TRIGGERED[0]]]) } });
        const chat = [{ role: 'user', content: 'hi' }];
        await host._handlers.CHAT_COMPLETION_PROMPT_READY({ chat, dryRun: false });
        expect(chat).toHaveLength(1);
        runtime.deactivate();
    });

    it('uploads and reads back the image through the store', async () => {
        const host = createHost();
        const runtime = new WorldInfoImageRuntime(host, logger());
        const prepared = await runtime.saveImageBlob(new Blob([PNG_BYTES], { type: 'image/png' }));
        expect(host.storeSetBlob).toHaveBeenCalledWith('world-info-images', prepared.binding.blobKey, expect.any(Blob));
        await expect(runtime.loadImageDataUrl(prepared.binding)).resolves.toMatch(/^data:image\/png;base64,/);
    });
});
