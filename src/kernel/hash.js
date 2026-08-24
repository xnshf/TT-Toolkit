import { ToolkitError } from './errors.js';

export async function sha256Hex(input) {
    if (!globalThis.crypto?.subtle)
        throw new ToolkitError('CRYPTO_UNAVAILABLE', '当前环境不支持 SHA-256。');
    const data = new TextEncoder().encode(String(input));
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
