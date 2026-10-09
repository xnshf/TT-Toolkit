import { ToolkitError } from '../../kernel/errors.js';

export const SELECTIVE_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

export const SELECTIVE_LOGIC_OPTIONS = Object.freeze([
    { value: 0, label: 'AND ANY (包含任意次级词)' },
    { value: 1, label: 'NOT ALL (不能同时包含全部次级词)' },
    { value: 2, label: 'NOT ANY (排除任意次级词)' },
    { value: 3, label: 'AND ALL (包含全部次级词)' },
]);

export const POSITION_OPTIONS = Object.freeze([
    { value: 0, label: '角色设定前 (Before Character)' },
    { value: 1, label: '角色设定后 (After Character)' },
    { value: 2, label: '作者注释顶部 (AN Top)' },
    { value: 3, label: '作者注释底部 (AN Bottom)' },
    { value: 4, label: '深度注入 (@Depth)' },
    { value: 5, label: '示例消息顶部 (EM Top)' },
    { value: 6, label: '示例消息底部 (EM Bottom)' },
    { value: 7, label: '自定义 Outlet' },
]);

export const ROLE_OPTIONS = Object.freeze([
    { value: 0, label: '系统 (System)' },
    { value: 1, label: '用户 (User)' },
    { value: 2, label: 'AI (Assistant)' },
]);

export const DEFAULT_ENTRY_TEMPLATE = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
    addMemo: false,
    order: 100,
    position: 0,
    depth: 4,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    useGroupScoring: null,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    characterFilterNames: [],
    characterFilterTags: [],
    characterFilterExclude: false,
    triggers: [],
});

/**
 * 估算多语言文本 Token 数量 (中英文混合估算)
 */
export function estimateTokens(text) {
    if (!text || typeof text !== 'string')
        return 0;
    const cjkMatches = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60]/g) || [];
    const cjkCount = cjkMatches.length;
    const nonCjkText = text.replace(/[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff60]/g, ' ');
    const words = nonCjkText.trim().split(/\s+/).filter(Boolean);
    return Math.ceil(cjkCount * 1.0 + words.length * 1.3);
}

/**
 * 判断是否为正则表达式关键词 (以 / 开头并以 /[flags] 结尾)
 */
export function isRegexKey(key) {
    if (typeof key !== 'string')
        return false;
    const trimmed = key.trim();
    return /^\/.+\/[a-z]*$/i.test(trimmed);
}

export const USER_MACRO = '{{user}}';

// 手动保存时把独立的英文单词 user (不区分大小写) 归一为 {{user}} 宏。
// 1. {{...}} 分支整体吃掉已有宏，避免把 {{user}} 二次包裹成 {{{{user}}}}；
// 2. <user>/</user>/<user/> 尖括号标签整体跳过，不当作占位词；
// 3. 其余位置要求前后都不是标识符字符 [A-Za-z0-9_-]，以便保留 username、user_name、user-defined。
const USER_PLACEHOLDER_PATTERN = /\{\{[^{}]*\}\}|<\/?user\s*\/?>|(?<![A-Za-z0-9_-])user(?![A-Za-z0-9_-])/gi;

/**
 * 将一段文本中的独立 user 单词替换为 {{user}} 宏，返回新文本与替换处数。
 */
export function replaceUserPlaceholder(text) {
    if (typeof text !== 'string')
        return { value: text, count: 0 };
    let count = 0;
    const value = text.replace(USER_PLACEHOLDER_PATTERN, match => {
        if (!/^user$/i.test(match))
            return match;
        count++;
        return USER_MACRO;
    });
    return { value, count };
}

/**
 * 递归转换整个条目内的所有字符串字段，返回新条目与总替换处数。
 */
export function convertEntryUserPlaceholders(entry) {
    let count = 0;
    const walk = value => {
        if (typeof value === 'string') {
            const result = replaceUserPlaceholder(value);
            count += result.count;
            return result.value;
        }
        if (Array.isArray(value))
            return value.map(walk);
        if (value && typeof value === 'object') {
            const next = {};
            for (const [key, item] of Object.entries(value))
                next[key] = walk(item);
            return next;
        }
        return value;
    };
    return { entry: walk(entry), count };
}

/**
 * 分配空闲可用 UID
 */
export function getFreeWorldEntryUid(worldData) {
    const entries = worldData?.entries ?? {};
    for (let uid = 0; uid < 1_000_000; uid++) {
        if (!Object.hasOwn(entries, uid)) return uid;
    }
    throw new Error('世界书没有可分配的条目 UID。');
}

/**
 * 标准化并补齐条目缺失字段
 */
export function normalizeEntry(entry, fallbackUid = 0) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('世界书条目结构异常，已停止读取。');
    const uid = Number.isInteger(Number(entry.uid)) ? Number(entry.uid) : fallbackUid;
    const normalized = {
        ...structuredClone(DEFAULT_ENTRY_TEMPLATE),
        ...structuredClone(entry),
        uid,
    };

    // 确保数组类型字段安全
    if (!Array.isArray(normalized.key))
        normalized.key = [];
    if (!Array.isArray(normalized.keysecondary))
        normalized.keysecondary = [];
    if (!Array.isArray(normalized.characterFilterNames))
        normalized.characterFilterNames = [];
    if (!Array.isArray(normalized.characterFilterTags))
        normalized.characterFilterTags = [];
    if (!Array.isArray(normalized.triggers))
        normalized.triggers = [];

    // 确保基础类型转换
    normalized.comment = String(normalized.comment ?? '');
    normalized.content = String(normalized.content ?? '');
    normalized.constant = Boolean(normalized.constant);
    normalized.disable = Boolean(normalized.disable);
    normalized.selective = Boolean(normalized.selective);
    normalized.order = Number.isFinite(Number(normalized.order)) ? Number(normalized.order) : 100;
    normalized.depth = Number.isFinite(Number(normalized.depth)) ? Number(normalized.depth) : 4;
    normalized.position = Number.isFinite(Number(normalized.position)) ? Number(normalized.position) : 0;
    normalized.probability = Number.isFinite(Number(normalized.probability)) ? Number(normalized.probability) : 100;

    return normalized;
}

/**
 * 校验并深度克隆条目
 */
export function cloneEntry(entry) {
    return structuredClone(normalizeEntry(entry, entry?.uid ?? 0));
}

/**
 * 创建新条目
 */
export function createNewEntry(uid, comment = '新设定条目') {
    const entry = structuredClone(DEFAULT_ENTRY_TEMPLATE);
    entry.uid = uid;
    entry.comment = comment;
    return entry;
}

/**
 * 提取条目的排序与过滤快照属性
 */
export function projectEntrySummary(entry) {
    const norm = normalizeEntry(entry);
    return {
        uid: norm.uid,
        comment: norm.comment || '(未命名条目)',
        constant: norm.constant,
        disabled: norm.disable,
        position: norm.position,
        depth: norm.depth,
        order: norm.order,
        primaryKeys: [...norm.key],
        secondaryKeys: [...norm.keysecondary],
        selective: norm.selective,
        tokenEstimate: estimateTokens(norm.content),
    };
}

const SETTINGS_KEYS = ['schemaVersion', 'convertUserMacro'];

/** 世界书管理功能级设置的默认值。 */
export function createDefaultWorldInfoEditorSettings() {
    return { schemaVersion: 1, convertUserMacro: true };
}

/**
 * 校验功能级设置；缺失时返回默认值，已存在但非法则拒绝解析而不猜测。
 */
export function parseWorldInfoEditorSettings(value) {
    if (value === undefined || value === null)
        return createDefaultWorldInfoEditorSettings();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '世界书管理设置必须是对象');
    const actual = Object.keys(value).sort();
    const wanted = [...SETTINGS_KEYS].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new ToolkitError('INVALID_SCHEMA', '世界书管理设置包含缺失或未知字段', { actual, expected: wanted });
    if (value.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的世界书管理设置版本：${String(value.schemaVersion)}`);
    if (typeof value.convertUserMacro !== 'boolean')
        throw new ToolkitError('INVALID_SCHEMA', 'convertUserMacro 必须是布尔值');
    return { schemaVersion: 1, convertUserMacro: value.convertUserMacro };
}
