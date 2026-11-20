const LLM_PRESETS_KEY = 'llm-presets-v1';
const REDACTED_PROTECTED_VALUE = '[REDACTED_PROTECTED_VALUE]';
const EXACT_FIELDS = ['name', 'apiUrl', 'model'];

function escapePattern(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 非凭据字段保持精确匹配；密钥在自由文本中做字面匹配，不猜测未知密钥。
export function createRedactor() {
    const exactValues = new Set();
    const keyVariants = new Set();
    let keyMatcher;
    let error = '';

    function protectKey(value) {
        if (typeof value !== 'string' || !value)
            return;
        const trimmed = value.trim();
        if (!trimmed) {
            exactValues.add(value);
            return;
        }
        for (const variant of [value, trimmed, ...value.split(/\r\n?|\n|\u2028|\u2029/).map(line => line.trim())]) {
            if (!variant)
                continue;
            // 宿主 console 消息也可能已经把请求或异常对象序列化为 JSON。
            for (const text of [variant, JSON.stringify(variant).slice(1, -1)]) {
                if (!keyVariants.has(text)) {
                    keyVariants.add(text);
                    keyMatcher = undefined;
                }
            }
        }
    }

    function redactString(value, keysOnly) {
        if (keyVariants.size && !keyMatcher) {
            const alternatives = [...keyVariants].sort((left, right) => right.length - left.length).map(escapePattern);
            keyMatcher = new RegExp(alternatives.join('|'), 'g');
        }
        let matched = !keysOnly && exactValues.has(value);
        const redacted = matched ? REDACTED_PROTECTED_VALUE : keyMatcher ? value.replace(keyMatcher, () => {
            matched = true;
            return REDACTED_PROTECTED_VALUE;
        }) : value;
        if (!matched || !keyMatcher)
            return redacted;
        // 若占位符本身（或拼接后的文本）仍匹配密钥，就不保留该字符串。
        const stillMatches = keyMatcher.test(redacted);
        keyMatcher.lastIndex = 0;
        return stillMatches ? '' : redacted;
    }

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
        for (const key of EXACT_FIELDS) {
            const value = input[key];
            if (typeof value === 'string' && value)
                exactValues.add(value);
        }
        protectKey(input.apiKey);
    }

    function redact(value, keysOnly, seen = new WeakSet()) {
        if (typeof value === 'string')
            return redactString(value, keysOnly);
        if (value === null || typeof value !== 'object')
            return value;
        if (seen.has(value))
            return '[Circular]';
        seen.add(value);
        if (Array.isArray(value))
            return value.map(item => redact(item, keysOnly, seen));
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactString(key, true), redact(item, keysOnly, seen)]));
    }

    return {
        get size() {
            return exactValues.size + keyVariants.size;
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
            catch {
                error = '模型预设值保护不可用。请重新加载工具箱后再启用日志。';
            }
        },
        protect,
        redact: value => redact(value, false),
        redactKeys: value => keyVariants.size ? redact(value, true) : value,
    };
}
