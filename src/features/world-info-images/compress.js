// 入库压缩：把常见多模态服务端的预处理上限当作"再多给也没用"的天花板，
// 只保留它们真正会用到的那部分像素，其余在本地丢弃。
// - OpenAI：先缩进 2048 长边、再把短边缩到 768，之后按 patch 计费。
// - Claude：建议长边 ≤ 1568、总像素 ≈ 1.15MP。
// - Gemini：按 768x768 切片计费。
// 因此 maxLongSide 取 1568、maxPixels 取 1.15MP：再大不会带来任何模型侧收益。
export const IMAGE_COMPRESS_LIMITS = Object.freeze({
    maxLongSide: 1568,
    maxPixels: 1_150_000,
    // 小于此体积直接原样保留，不必解码重编。
    skipBelowBytes: 96 * 1024,
    // 编码后仍超过此体积时继续降质量、再降尺寸。
    targetBytes: 300 * 1024,
    quality: 0.82,
    minQuality: 0.6,
    minLongSide: 512,
    outputMimeType: 'image/webp',
});

/** 按长边与总像素两个约束等比缩小；不放大小图。 */
export function fitWithinLimits(width, height, limits = IMAGE_COMPRESS_LIMITS) {
    if (!(width > 0) || !(height > 0))
        return { width: 0, height: 0 };
    const scale = Math.min(
        1,
        limits.maxLongSide / Math.max(width, height),
        Math.sqrt(limits.maxPixels / (width * height)),
    );
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function createCanvasElement(width, height) {
    if (typeof OffscreenCanvas === 'function') {
        try {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d');
            if (!context)
                return null;
            return { context, toBlob: (type, quality) => canvas.convertToBlob({ type, quality }) };
        }
        catch {
            return null;
        }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function')
        return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context)
        return null;
    return {
        context,
        toBlob: (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality)),
    };
}

async function decodeImage(bytes, mimeType) {
    if (typeof Blob !== 'function')
        return null;
    const blob = new Blob([bytes], { type: mimeType });
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(blob);
        }
        catch {
            return null;
        }
    }
    if (typeof Image !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function')
        return null;
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('image decode failed'));
            image.src = url;
        });
        return image;
    }
    catch {
        return null;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}

async function encodeCanvas(source, width, height, quality, mimeType) {
    const canvas = createCanvasElement(width, height);
    if (!canvas)
        return null;
    canvas.context.imageSmoothingEnabled = true;
    canvas.context.imageSmoothingQuality = 'high';
    canvas.context.drawImage(source, 0, 0, width, height);
    let blob;
    try {
        blob = await canvas.toBlob(mimeType, quality);
    }
    catch {
        return null;
    }
    if (!blob || typeof blob.arrayBuffer !== 'function')
        return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength === 0)
        return null;
    return { bytes, mimeType: blob.type || mimeType };
}

/**
 * 尝试压缩图片字节。无需压缩或当前环境无法解码/编码时返回 null，调用方保留原始字节。
 * 返回的 mimeType 为实际编码格式（浏览器不支持 WebP 时可能回落到 PNG）。
 */
export async function compressImageBytes(bytes, mimeType, options = {}) {
    const limits = { ...IMAGE_COMPRESS_LIMITS, ...(options.limits ?? {}) };
    if (!(bytes?.byteLength > 0))
        return null;
    if (bytes.byteLength <= limits.skipBelowBytes)
        return null;
    const source = await decodeImage(bytes, mimeType);
    if (!source)
        return null;
    try {
        const sourceWidth = Number(source.width) || 0;
        const sourceHeight = Number(source.height) || 0;
        const fitted = fitWithinLimits(sourceWidth, sourceHeight, limits);
        if (fitted.width === 0 || fitted.height === 0)
            return null;
        const unchanged = fitted.width === sourceWidth && fitted.height === sourceHeight;
        if (unchanged && bytes.byteLength <= limits.targetBytes)
            return null;

        let plan = fitted;
        let quality = limits.quality;
        let encoded = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            encoded = await encodeCanvas(source, plan.width, plan.height, quality, limits.outputMimeType);
            if (!encoded)
                return null;
            if (encoded.bytes.byteLength <= limits.targetBytes)
                break;
            if (quality > limits.minQuality) {
                quality = Math.max(limits.minQuality, quality - 0.08);
                continue;
            }
            if (Math.max(plan.width, plan.height) <= limits.minLongSide)
                break;
            plan = fitWithinLimits(
                Math.max(1, Math.round(plan.width * 0.8)),
                Math.max(1, Math.round(plan.height * 0.8)),
                limits,
            );
        }
        if (encoded.bytes.byteLength >= bytes.byteLength)
            return null;
        return {
            bytes: encoded.bytes,
            mimeType: encoded.mimeType,
            width: plan.width,
            height: plan.height,
            sourceWidth,
            sourceHeight,
        };
    }
    finally {
        if (typeof source.close === 'function')
            source.close();
    }
}
