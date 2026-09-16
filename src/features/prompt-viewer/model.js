import { ToolkitError } from '../../kernel/errors.js';

export const SOURCE_LABELS = Object.freeze({
    preset: '预设',
    character: '角色卡',
    persona: 'Persona',
    'world-info': '世界书',
    'chat-history': '对话历史',
    'system-extension': '系统注入',
    unknown: '未知',
});

export const SOURCE_ORDER = Object.freeze([
    'preset', 'character', 'persona', 'world-info', 'chat-history', 'system-extension', 'unknown',
]);

export const WORLD_POSITION_LABELS = Object.freeze({
    before: '角色前',
    after: '角色后',
    an_top: '作者注释前',
    an_bottom: '作者注释后',
    depth: '深度注入',
    em_top: '示例前',
    em_bottom: '示例后',
    outlet: 'outlet',
    unknown: '未知位置',
});

export const TRIGGER_LABELS = Object.freeze({
    constant: '常驻',
    keyword: '关键词',
    vector: '向量',
});

const STATIC_SOURCES = Object.freeze({
    charDescription: ['character', '角色描述'],
    charPersonality: ['character', '角色性格'],
    scenario: ['character', '场景'],
    personaDescription: ['persona', 'Persona 描述'],
    worldInfoBefore: ['world-info', '世界书（角色前）'],
    worldInfoAfter: ['world-info', '世界书（角色后）'],
    bias: ['system-extension', '提示偏差'],
    groupNudge: ['system-extension', '群聊提示'],
    continueNudge: ['system-extension', '续写提示'],
    impersonate: ['system-extension', '扮演提示'],
    quietPrompt: ['system-extension', '安静提示'],
    summary: ['system-extension', '记忆摘要'],
    authorsNote: ['system-extension', '作者注释'],
    smartContext: ['system-extension', 'Smart Context'],
    vectorsMemory: ['system-extension', '向量记忆'],
    vectorsDataBank: ['system-extension', '向量数据'],
    newMainChat: ['system-extension', '新对话占位'],
    newChat: ['system-extension', '新示例占位'],
    emptyUserMessageReplacement: ['system-extension', '空输入占位'],
    continuePrefill: ['system-extension', '续写前缀'],
    agentSystemPrompt: ['system-extension', 'Agent 系统提示'],
    agentResults: ['system-extension', 'Agent 结果'],
    agentTask: ['system-extension', 'Agent 任务'],
});

const WORLD_POSITION_BY_INDEX = Object.freeze({
    0: 'before',
    1: 'after',
    2: 'an_top',
    3: 'an_bottom',
    4: 'depth',
    5: 'em_top',
    6: 'em_bottom',
    7: 'outlet',
});

export function describeIdentifier(identifier, promptName = null) {
    const text = String(identifier ?? '');
    const presetName = typeof promptName === 'string' && promptName.trim() ? promptName.trim() : null;
    const known = STATIC_SOURCES[text];
    if (known)
        return { source: known[0], label: known[1] };
    if (text.startsWith('dialogueExamples'))
        return { source: 'character', label: '示例对话' };
    if (text.startsWith('chatHistory'))
        return { source: 'chat-history', label: '对话历史' };
    if (text.startsWith('customDepthWI'))
        return { source: 'world-info', label: '世界书（深度注入）' };
    if (text.startsWith('customWIOutlet'))
        return { source: 'world-info', label: '世界书（outlet）' };
    if (presetName)
        return { source: 'preset', label: presetName };
    return { source: 'unknown', label: text || '未命名条目' };
}

export function stringifyContent(content) {
    if (typeof content === 'string')
        return content;
    if (content === null || content === undefined)
        return '';
    try {
        return JSON.stringify(content);
    }
    catch {
        return String(content);
    }
}

export function buildPromptItemView(messages) {
    if (!Array.isArray(messages))
        throw new ToolkitError('INVALID_SCHEMA', '提示词条目输入必须是数组。');
    return messages.map((message, index) => {
        const identifier = String(message?.identifier ?? '');
        const { source, label } = describeIdentifier(identifier, message?.promptName ?? null);
        return {
            order: index,
            identifier,
            source,
            label,
            role: String(message?.role ?? 'system'),
            name: message?.name ? String(message.name) : null,
            content: message?.content ?? '',
            tokens: Number.isFinite(message?.tokens) ? Number(message.tokens) : null,
            toolCalls: message?.toolCalls ?? null,
            toolCallId: String(message?.role ?? '') === 'tool' ? (message?.toolCallId ?? identifier) : null,
            signature: message?.signature ?? null,
            reasoning: message?.reasoning ?? null,
            native: message?.native ?? null,
            reasoningContent: message?.reasoningContent ?? null,
            worldEntryRefs: [],
        };
    });
}

export function normalizeWorldPosition(value) {
    if (typeof value === 'string' && Object.hasOwn(WORLD_POSITION_LABELS, value))
        return value;
    const numeric = Number(value);
    if (Number.isInteger(numeric) && Object.hasOwn(WORLD_POSITION_BY_INDEX, numeric))
        return WORLD_POSITION_BY_INDEX[numeric];
    return 'unknown';
}

function worldEntryDisplayName(entry) {
    const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
    if (comment)
        return comment;
    if (Array.isArray(entry?.key)) {
        const key = entry.key.find(value => String(value ?? '').trim());
        if (key !== undefined)
            return String(key).trim();
    }
    return String(entry?.uid ?? '').trim();
}

export function projectWorldEntries(entries) {
    if (!Array.isArray(entries))
        return [];
    return entries.map(entry => {
        const constant = entry?.constant === true;
        const vectorized = entry?.vectorized === true || entry?.extensions?.vectorized === true;
        const depth = Number(entry?.depth);
        return {
            world: typeof entry?.world === 'string' ? entry.world : '',
            uid: entry?.uid ?? '',
            comment: worldEntryDisplayName(entry),
            position: normalizeWorldPosition(entry?.position),
            depth: Number.isFinite(depth) ? depth : null,
            role: entry?.role === undefined || entry?.role === null ? null : String(entry.role),
            trigger: constant ? 'constant' : vectorized ? 'vector' : 'keyword',
        };
    });
}

export function attachWorldEntryRefs(items, worldEntries) {
    const indexesFor = position => worldEntries
        .map((entry, index) => (entry.position === position ? index : -1))
        .filter(index => index >= 0);
    return items.map(item => {
        if (item.identifier === 'worldInfoBefore')
            return { ...item, worldEntryRefs: indexesFor('before') };
        if (item.identifier === 'worldInfoAfter')
            return { ...item, worldEntryRefs: indexesFor('after') };
        return item;
    });
}

export function sumTokens(items) {
    return items.reduce((total, item) => total + (Number.isFinite(item?.tokens) ? item.tokens : 0), 0);
}

export function countBySource(items) {
    const counts = {};
    for (const item of items)
        counts[item.source] = (counts[item.source] ?? 0) + 1;
    return counts;
}

export function sourceCounts(items) {
    return SOURCE_ORDER
        .filter(source => items.some(item => item.source === source))
        .map(source => ({ source, label: SOURCE_LABELS[source], count: countBySource(items)[source] }));
}

export function searchableText(item) {
    return [
        item.label,
        item.identifier,
        item.name ?? '',
        stringifyContent(item.content),
    ].join('\n');
}

export function filterItems(items, { source = 'all', query = '' } = {}) {
    const needle = String(query ?? '').trim().toLocaleLowerCase();
    return items.filter(item => {
        if (source !== 'all' && item.source !== source)
            return false;
        if (!needle)
            return true;
        return searchableText(item).toLocaleLowerCase().includes(needle);
    });
}

export function toChatMessage(item) {
    const include = Boolean(item.content) || Boolean(item.toolCalls) || item.role === 'tool';
    if (!include)
        return null;
    return {
        role: item.role,
        content: item.content,
        ...(item.name ? { name: item.name } : {}),
        ...(item.toolCalls ? { tool_calls: item.toolCalls } : {}),
        ...(item.role === 'tool' && item.toolCallId ? { tool_call_id: item.toolCallId } : {}),
        ...(item.signature ? { signature: item.signature } : {}),
        ...(item.reasoning ? { reasoning: item.reasoning } : {}),
        ...(item.native ? { native: item.native } : {}),
        ...(item.reasoningContent ? { reasoning_content: item.reasoningContent } : {}),
    };
}

export function rebuildChatMessages(items) {
    return items.map(toChatMessage).filter(Boolean);
}

export function serializePromptItems(items) {
    const blocks = [];
    for (const item of items) {
        const message = toChatMessage(item);
        if (!message)
            continue;
        const header = `[${message.role}]${message.name ? ` name=${message.name}` : ''}`;
        blocks.push(`${header}\n${stringifyContent(message.content)}`);
    }
    return blocks.join('\n\n');
}

export function promptDocumentFilename(kind, now = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join('');
    return `prompt-${kind === 'prediction' ? 'prediction' : 'sent'}-${stamp}.txt`;
}
