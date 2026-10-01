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
