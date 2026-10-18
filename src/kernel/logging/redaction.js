import { errorMessage } from '../errors.js';

const LLM_PRESETS_KEY = 'llm-presets-v1';
const REDACTED_PROTECTED_VALUE = '[REDACTED_PROTECTED_VALUE]';
const PROTECTED_PRESET_FIELDS = ['name', 'apiUrl', 'model', 'apiKey'];

// 模型预设值保护：把用户显式填写的预设字段精确替换为占位符。
// 只做精确字符串匹配，不做猜测式模糊替换；设置页写入新预设时通过 protect 追加。
export function createRedactor() {
    const values = new Set();
    let error = '';

    function protect(input) {
        if (Array.isArray(input)) {
            for (const item of input)
                protect(item);
            return;
        }
        if (!input || typeof input !== 'object')
            return;
        if (Array.isArray(input.presets)) {
            for (const preset of input.presets)
                protect(preset);
        }
        for (const key of PROTECTED_PRESET_FIELDS) {
            const value = input[key];
            if (typeof value === 'string' && value)
                values.add(value);
        }
    }

    function redact(value, seen = new WeakSet()) {
        if (typeof value === 'string')
            return values.has(value) ? REDACTED_PROTECTED_VALUE : value;
        if (value === null || value === undefined || typeof value !== 'object')
            return value;
        if (seen.has(value))
            return value;
        seen.add(value);
        if (Array.isArray(value))
            return value.map(item => redact(item, seen));
        const output = {};
        for (const [key, item] of Object.entries(value))
            output[key] = redact(item, seen);
        return output;
    }

    return {
        get size() {
            return values.size;
        },
        get error() {
            return error;
        },
        async load(host) {
            error = '';
            try {
                const raw = await host.globalGet(LLM_PRESETS_KEY);
                if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw))
                    protect(raw);
            }
            catch (loadError) {
                error = `模型预设值保护不可用：${errorMessage(loadError)}`;
            }
        },
        protect,
        redact,
    };
}
