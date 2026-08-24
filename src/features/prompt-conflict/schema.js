import { ToolkitError } from '../../kernel/errors.js';

export const FEATURE_SETTINGS_KEY = 'prompt-conflict-settings-v1';
export const CHAT_METADATA_NAMESPACE = 'tt-toolkit.prompt-conflict';
export const PROTOCOL_VERSION = 1;

export const DIRECTIVE_KINDS = ['fact', 'requirement', 'prohibition', 'preference'];
export const CONFLICT_CATEGORIES = ['contradiction', 'format', 'role', 'style', 'priority', 'redundancy'];
export const SEVERITIES = ['high', 'medium', 'low'];

export const MAX_DIRECTIVES_PER_SOURCE = 200;
export const MAX_STATEMENT_CHARS = 800;
export const MAX_CONDITION_CHARS = 400;
export const MAX_EVIDENCE_SEGMENTS = 3;
export const MAX_EVIDENCE_CHARS = 2000;
export const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_CONFLICTS = 500;
export const MAX_TITLE_CHARS = 160;
export const MAX_EXPLANATION_CHARS = 1500;
export const MAX_OPTIONS_PER_CONFLICT = 6;
export const MAX_OPTION_LABEL_CHARS = 120;
export const MAX_OPTION_CONSEQUENCE_CHARS = 800;

export const HEX64_RE = /^[a-f0-9]{64}$/;

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', `${label} 必须是对象。`);
    return value;
}

function exactKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length)
        throw new ToolkitError('INVALID_SCHEMA', `${label} 包含未知字段：${unknown.join(', ')}`);
}

export function createDefaultPromptConflictFeatureSettings() {
    return { schemaVersion: 1, presetId: null };
}

export function parsePromptConflictFeatureSettings(value) {
    if (value === undefined || value === null)
        return createDefaultPromptConflictFeatureSettings();
    const raw = plainObject(value, '冲突检测功能设置');
    exactKeys(raw, ['schemaVersion', 'presetId'], '冲突检测功能设置');
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的冲突检测功能设置版本：${String(raw.schemaVersion)}`);
    if (raw.presetId !== null && typeof raw.presetId !== 'string')
        throw new ToolkitError('INVALID_SCHEMA', '冲突检测功能设置的 presetId 必须是字符串或 null。');
    return { schemaVersion: 1, presetId: raw.presetId };
}

export function createDefaultPromptConflictChatMetadata() {
    return { schemaVersion: 1, disabledWorldEntries: [] };
}

export function parsePromptConflictChatMetadata(value) {
    if (value === undefined || value === null)
        return createDefaultPromptConflictChatMetadata();
    const raw = plainObject(value, '聊天屏蔽数据');
    exactKeys(raw, ['schemaVersion', 'disabledWorldEntries'], '聊天屏蔽数据');
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('PROMPT_CONFLICT_SCHEMA_UNSUPPORTED', `不支持的聊天屏蔽数据版本：${String(raw.schemaVersion)}，请在冲突检测页重置本聊天数据。`);
    if (!Array.isArray(raw.disabledWorldEntries))
        throw new ToolkitError('INVALID_SCHEMA', '聊天屏蔽数据的 disabledWorldEntries 必须是数组。');
    const records = [];
    const seen = new Set();
    for (const item of raw.disabledWorldEntries) {
        const record = plainObject(item, '屏蔽记录');
        exactKeys(record, ['worldDigest', 'uid', 'contentDigest'], '屏蔽记录');
        const worldDigest = String(record.worldDigest ?? '');
        const contentDigest = String(record.contentDigest ?? '');
        if (!HEX64_RE.test(worldDigest) || !HEX64_RE.test(contentDigest))
            throw new ToolkitError('INVALID_SCHEMA', '屏蔽记录的摘要必须是 64 位小写十六进制。');
        const uid = record.uid;
        if (typeof uid !== 'string' && typeof uid !== 'number')
            throw new ToolkitError('INVALID_SCHEMA', '屏蔽记录的 UID 必须是字符串或数字。');
        if (typeof uid === 'number' && !Number.isSafeInteger(uid))
            throw new ToolkitError('INVALID_SCHEMA', '屏蔽记录的数字 UID 必须是安全整数。');
        const key = `${worldDigest}:${typeof uid}:${String(uid)}`;
        if (seen.has(key))
            throw new ToolkitError('INVALID_SCHEMA', '屏蔽记录包含重复的 worldDigest + uid。');
        seen.add(key);
        records.push({ worldDigest, uid, contentDigest });
    }
    return { schemaVersion: 1, disabledWorldEntries: sortOverrideRecords(records) };
}

export function sortOverrideRecords(records) {
    return [...records].sort((left, right) => {
        if (left.worldDigest !== right.worldDigest)
            return left.worldDigest < right.worldDigest ? -1 : 1;
        const leftUid = `${typeof left.uid}:${String(left.uid)}`;
        const rightUid = `${typeof right.uid}:${String(right.uid)}`;
        if (leftUid !== rightUid)
            return leftUid < rightUid ? -1 : 1;
        return left.contentDigest < right.contentDigest ? -1 : left.contentDigest > right.contentDigest ? 1 : 0;
    });
}

export function dedupeOverrideRecords(records) {
    const seen = new Set();
    const output = [];
    for (const record of records) {
        const key = `${record.worldDigest}:${typeof record.uid}:${String(record.uid)}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        output.push(record);
    }
    return output;
}

function stringInRange(value, min, max, label) {
    if (typeof value !== 'string')
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `${label} 必须是字符串。`);
    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max)
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `${label} 长度必须介于 ${min} 到 ${max} 字符。`);
    return trimmed;
}

function parseDirectives(value, sourceId, content) {
    if (!Array.isArray(value))
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 directives 必须是数组。`);
    if (value.length > MAX_DIRECTIVES_PER_SOURCE)
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的原子指令超过 ${MAX_DIRECTIVES_PER_SOURCE} 条上限。`);
    const seen = new Set();
    return value.map((item, index) => {
        const directive = plainObject(item, `来源 ${sourceId} 指令 ${index + 1}`);
        exactKeys(directive, ['localId', 'kind', 'statement', 'condition', 'evidence'], `来源 ${sourceId} 指令 ${index + 1}`);
        const localId = String(directive.localId ?? '');
        if (!LOCAL_ID_RE.test(localId))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 localId 非法。`);
        if (seen.has(localId))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 localId 重复：${localId}`);
        seen.add(localId);
        if (!DIRECTIVE_KINDS.includes(directive.kind))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 kind 非法。`);
        const statement = stringInRange(directive.statement, 1, MAX_STATEMENT_CHARS, `来源 ${sourceId} 的 statement`);
        let condition = null;
        if (directive.condition !== null) {
            condition = stringInRange(directive.condition, 1, MAX_CONDITION_CHARS, `来源 ${sourceId} 的 condition`);
        }
        const evidence = parseEvidence(directive.evidence, content, sourceId);
        return { localId, kind: directive.kind, statement, condition, evidence };
    });
}

function parseEvidence(value, content, sourceId) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_SEGMENTS)
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 evidence 必须是 1 至 ${MAX_EVIDENCE_SEGMENTS} 段。`);
    for (const segment of value) {
        if (typeof segment !== 'string' || !segment.trim())
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 evidence 段不能为空。`);
        if (segment.length > MAX_EVIDENCE_CHARS)
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 evidence 段超过 ${MAX_EVIDENCE_CHARS} 字符。`);
        if (!content.includes(segment))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `来源 ${sourceId} 的 evidence 不是正文的连续原文片段。`);
    }
    return value.map(segment => segment.trim());
}

export function parsePhaseOneResponse(text, batchSources) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new ToolkitError('PROMPT_CONFLICT_JSON_INVALID', '原子指令提取未返回合法 JSON。', { error });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', '原子指令提取返回结构无效。');
    exactKeys(value, ['sources'], '原子指令提取响应');
    if (!Array.isArray(value.sources))
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', '原子指令提取响应的 sources 必须是数组。');
    const expected = batchSources.map(source => source.sourceId);
    const expectedSet = new Set(expected);
    const returned = new Set();
    const byId = new Map();
    for (const item of value.sources) {
        const source = plainObject(item, '原子指令提取来源');
        exactKeys(source, ['sourceId', 'directives'], '原子指令提取来源');
        const sourceId = String(source.sourceId ?? '');
        if (!expectedSet.has(sourceId))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', '原子指令提取返回了未知来源 ID。');
        if (returned.has(sourceId))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', '原子指令提取重复返回了来源 ID。');
        returned.add(sourceId);
        byId.set(sourceId, item);
    }
    if (returned.size !== expectedSet.size) {
        const missing = expected.filter(id => !returned.has(id));
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `原子指令提取遗漏了来源：${missing.join('、')}`);
    }
    return {
        sources: expected.map(sourceId => {
            const item = byId.get(sourceId);
            const source = batchSources.find(candidate => candidate.sourceId === sourceId);
            return {
                sourceId,
                directives: parseDirectives(item.directives, sourceId, String(source.content ?? '')),
            };
        }),
    };
}

export function parsePhaseTwoResponse(text, inputDirectives) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new ToolkitError('PROMPT_CONFLICT_JSON_INVALID', '冲突比较未返回合法 JSON。', { error });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', '冲突比较返回结构无效。');
    exactKeys(value, ['conflicts'], '冲突比较响应');
    if (!Array.isArray(value.conflicts))
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', '冲突比较响应的 conflicts 必须是数组。');
    if (value.conflicts.length > MAX_CONFLICTS)
        throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突数量超过 ${MAX_CONFLICTS} 条上限。`);
    const known = new Set(inputDirectives.map(directive => directive.directiveId));
    const sourceOf = new Map(inputDirectives.map(directive => [directive.directiveId, directive.sourceId]));
    return value.conflicts.map((item, index) => {
        const conflict = plainObject(item, `冲突 ${index + 1}`);
        exactKeys(conflict, ['directiveIds', 'severity', 'category', 'title', 'explanation', 'options'], `冲突 ${index + 1}`);
        if (!Array.isArray(conflict.directiveIds) || conflict.directiveIds.length < 2)
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 必须引用至少两个指令。`);
        const directiveIds = [];
        const seen = new Set();
        const involvedSources = new Set();
        for (const id of conflict.directiveIds) {
            const directiveId = String(id ?? '');
            if (!known.has(directiveId))
                throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 引用了未知指令。`);
            if (seen.has(directiveId))
                throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 的指令引用重复。`);
            seen.add(directiveId);
            directiveIds.push(directiveId);
            involvedSources.add(sourceOf.get(directiveId));
        }
        if (!SEVERITIES.includes(conflict.severity))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 的严重度非法。`);
        if (!CONFLICT_CATEGORIES.includes(conflict.category))
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 的分类非法。`);
        const title = stringInRange(conflict.title, 1, MAX_TITLE_CHARS, `冲突 ${index + 1} 的 title`);
        const explanation = stringInRange(conflict.explanation, 1, MAX_EXPLANATION_CHARS, `冲突 ${index + 1} 的 explanation`);
        if (!Array.isArray(conflict.options) || conflict.options.length < 1 || conflict.options.length > MAX_OPTIONS_PER_CONFLICT)
            throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 的 options 必须是 1 至 ${MAX_OPTIONS_PER_CONFLICT} 项。`);
        const options = conflict.options.map((option, optionIndex) => {
            const parsed = plainObject(option, `冲突 ${index + 1} 选项 ${optionIndex + 1}`);
            exactKeys(parsed, ['label', 'consequence', 'sourceIds'], `冲突 ${index + 1} 选项 ${optionIndex + 1}`);
            const label = stringInRange(parsed.label, 1, MAX_OPTION_LABEL_CHARS, `冲突 ${index + 1} 选项 ${optionIndex + 1} 的 label`);
            const consequence = stringInRange(parsed.consequence, 1, MAX_OPTION_CONSEQUENCE_CHARS, `冲突 ${index + 1} 选项 ${optionIndex + 1} 的 consequence`);
            if (!Array.isArray(parsed.sourceIds))
                throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 选项 ${optionIndex + 1} 的 sourceIds 必须是数组。`);
            const optionSources = [];
            const optionSeen = new Set();
            for (const sourceId of parsed.sourceIds) {
                const id = String(sourceId ?? '');
                if (!involvedSources.has(id))
                    throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 选项 ${optionIndex + 1} 引用了无关来源。`);
                if (optionSeen.has(id))
                    throw new ToolkitError('PROMPT_CONFLICT_RESPONSE_INVALID', `冲突 ${index + 1} 选项 ${optionIndex + 1} 的来源重复。`);
                optionSeen.add(id);
                optionSources.push(id);
            }
            return { label, consequence, sourceIds: optionSources };
        });
        return { directiveIds, severity: conflict.severity, category: conflict.category, title, explanation, options };
    });
}
