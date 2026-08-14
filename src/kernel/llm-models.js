import { ToolkitError } from './errors.js';
import { resolveOpenAiCompatibleBaseUrl } from './llm-presets.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchOpenAiCompatibleModels(host, preset, options = {}) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset))
        throw new ToolkitError('LLM_PRESET_INVALID', '模型预设无效。');
    if (typeof preset.apiKey !== 'string')
        throw new ToolkitError('LLM_PRESET_INVALID', '模型访问密钥必须是字符串。');
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
        throw new ToolkitError('LLM_MODELS_INVALID', '获取模型列表的超时设置无效。');
    const request = options.request ?? host?.getOpenAiCompatibleStatus?.bind(host);
    if (typeof request !== 'function')
        throw new ToolkitError('HOST_ABI_MISSING', 'TauriTavern 缺少模型状态请求接口。');
    const transportPreset = { ...preset, apiUrl: resolveOpenAiCompatibleBaseUrl(preset.apiUrl) };
    let timeout;
    try {
        const value = await Promise.race([
            request(transportPreset),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new ToolkitError('LLM_MODELS_TIMEOUT', `获取模型列表在 ${timeoutMs}ms 后超时。`)), timeoutMs);
            }),
        ]);
        if (value?.error)
            throw new ToolkitError('LLM_MODELS_HTTP_FAILED', 'TauriTavern 后端无法连接该模型服务。');
        if (!value || typeof value !== 'object' || !Array.isArray(value.data))
            throw new ToolkitError('LLM_MODELS_RESPONSE_INVALID', '模型服务返回的模型列表结构无效。');
        const ids = value.data.map(item => typeof item?.id === 'string' ? item.id.trim() : '').filter(Boolean);
        return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
    }
    finally {
        clearTimeout(timeout);
    }
}
