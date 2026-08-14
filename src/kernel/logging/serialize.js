const MAX_EVENT_BYTES = 256 * 1024;
function safeValue(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function')
        return String(value);
    if (depth >= 8)
        return '[MaxDepth]';
    if (typeof value !== 'object')
        return String(value);
    if (seen.has(value))
        return '[Circular]';
    seen.add(value);
    if (value instanceof Error) {
        const error = value;
        return { name: error.name, message: error.message, stack: error.stack, code: error.code, cause: safeValue(error.cause, seen, depth + 1) };
    }
    if (Array.isArray(value))
        return value.map(item => safeValue(item, seen, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100))
        output[key] = safeValue(item, seen, depth + 1);
    return output;
}
function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export function projectLogPayload(data, sensitive, full) {
    const projected = { data: safeValue(data ?? {}) };
    if (full && sensitive !== undefined)
        projected.sensitive = safeValue(sensitive);
    return projected;
}
export function boundLogEvent(event) {
    const bytes = jsonBytes(event);
    if (bytes <= MAX_EVENT_BYTES)
        return { ...event, truncated: false };
    const fallback = {
        ...event,
        data: { truncated: true, preview: JSON.stringify(event.data).slice(0, 16_384) },
        sensitive: event.sensitive === undefined ? undefined : { truncated: true, preview: JSON.stringify(event.sensitive).slice(0, 64_000) },
        truncated: true,
        originalBytes: bytes,
    };
    return fallback;
}
