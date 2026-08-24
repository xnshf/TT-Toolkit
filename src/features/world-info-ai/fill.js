import { ToolkitError } from '../../kernel/errors.js';
import { detectPromptTemplateEntry, worldInfoTriggerType } from './schema.js';

export const FILL_MAX_ENTRIES_PER_BATCH = 30;
export const FILL_MAX_ENTRY_CONTENT_CHARS = 1500;
export const FILL_MAX_BATCH_CONTENT_CHARS = 15000;
export const FILL_MAX_DESCRIPTION_CHARS = 300;
export const FILL_RESPONSE_LENGTH = 2000;
export const FILL_TIMEOUT_MS = 60_000;

export const FILL_SYSTEM_PROMPT = [
    '你是世界书条目激活描述编写器。为输入中的每个条目写一段独立、自包含的中文"激活描述"，说明该条目在什么对话情境下应当被注入。',
    '',
    '【方法论：先定类，再写情境】',
    '世界书条目按正文内容可分为六类。先判断条目属于哪一类，再按该类的情境语义写激活描述：',
    '1. 角色/NPC 卡：正文是角色的身份、外貌、性格、关系与行为表现。写"当该角色登场、参与对话或被提及时"；若正文区分公开面与独处面，补充"当该角色与 {{user}} 独处时"。',
    '2. 地点条目：正文是区域概览、场景或势力。写"当角色身处该地、前往该地，或对话涉及该地及其人物时"。',
    '3. 事件/技法/活动条目：正文是步骤或场景演绎。写"当对应动作或事件正在发生、被要求或被提及，并持续到该情景结束"。',
    '4. 物品/服装条目：写"当该物品被穿戴、使用、更换或讨论时"。',
    '5. 世界观设定条目：写"全程生效"；若只与特定种族、势力或概念相关，写"当相关种族、势力或概念在场或成为话题时"。',
    '6. 扮演准则/风格条目：正文是写作规则与叙事约束，写"全程生效"。',
    '',
    '【编写要点】',
    '1. 用具体情境，不用抽象标签：写"当角色在雨天谈论天气时"，不要写"角色相关"。',
    '2. 同时覆盖角色、动作、话题三个判断维度：既说明"谁在场"，也说明"正在做什么、聊到什么"。',
    '3. 优先复用正文里现成的情境表述：正文中"与 {{user}} 独处时""仅私密场景""被照顾时"等就是作者写好的触发条件，直接转述最准确。',
    '4. 不依赖特定历史对话或事件序号，用可重复、可预判的情境特征。',
    '5. 每条描述 1-2 句，独立自包含，不重复正文原文，不臆造正文和关键词之外的信息。',
    '',
    '【输出格式（必须逐字遵循）】',
    '输出一个 JSON 对象，其中 "descriptions" 是数组，每个元素恰好两个字段："uid"（必须是输入中出现的 uid 字符串）和 "description"（该条目的激活描述）。',
    '必须为输入中的每一个条目都输出一个元素，不能遗漏，也不能出现输入之外的 uid。',
    '格式：{"descriptions":[{"uid":"条目uid","description":"激活描述"}]}',
    '',
    '【示例】',
    '输入：{"entries":[{"uid":"3","title":"酒馆老板娘","keywords":["酒馆","老板娘"],"order":5,"content":"老板娘是消息最灵通的本地人，冒险者常向她打听情报；与{{user}}独处时会放下防备说真心话。"}]}',
    '输出：{"descriptions":[{"uid":"3","description":"当角色进入酒馆、向老板娘打听消息时注入；与{{user}}独处谈及私事时，启用她放下防备的一面。"}]}',
    '',
    '【禁止】',
    '不要使用代码块、Markdown 标记或任何解释文字，直接输出上面的 JSON 对象。',
].join('\n');

function truncateContent(content, maxChars) {
    const text = String(content ?? '');
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function keywordList(entry) {
    return [...(Array.isArray(entry?.key) ? entry.key : []), ...(Array.isArray(entry?.keysecondary) ? entry.keysecondary : [])]
        .filter(value => typeof value === 'string' && value.trim())
        .slice(0, 20);
}

export function collectFillEntries(entriesMap, uids) {
    const output = [];
    for (const uid of uids) {
        const entry = entriesMap?.[uid];
        if (!entry)
            continue;
        if (detectPromptTemplateEntry(entry).detected || worldInfoTriggerType(entry) !== 'keyword')
            continue;
        output.push({
            uid: String(uid),
            comment: String(entry.comment ?? '').trim(),
            keywords: keywordList(entry),
            group: String(entry.group ?? ''),
            order: Number(entry.order ?? 0),
            content: truncateContent(entry.content, FILL_MAX_ENTRY_CONTENT_CHARS),
        });
    }
    return output;
}

export function chunkFillEntries(entries, options = {}) {
    const maxCount = Number(options.maxCount ?? FILL_MAX_ENTRIES_PER_BATCH);
    const maxContentChars = Number(options.maxContentChars ?? FILL_MAX_BATCH_CONTENT_CHARS);
    const batches = [];
    let current = [];
    let used = 0;
    for (const entry of entries) {
        const size = entry.content.length + entry.comment.length + entry.keywords.join('').length + 64;
        if (current.length && (current.length >= maxCount || used + size > maxContentChars)) {
            batches.push(current);
            current = [];
            used = 0;
        }
        current.push(entry);
        used += size;
    }
    if (current.length)
        batches.push(current);
    return batches;
}

export function fillDescriptionPrompt(entries) {
    return JSON.stringify({
        entries: entries.map(entry => ({
            uid: entry.uid,
            title: entry.comment,
            keywords: entry.keywords,
            group: entry.group,
            order: entry.order,
            content: entry.content,
        })),
    });
}

export function fillDescriptionSchema(uids) {
    return {
        name: 'tt_toolkit_world_info_descriptions',
        description: 'Write a self-contained activation description for each world info entry.',
        strict: true,
        value: {
            type: 'object',
            additionalProperties: false,
            required: ['descriptions'],
            properties: {
                descriptions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['uid', 'description'],
                        properties: {
                            uid: { type: 'string', enum: [...uids] },
                            description: { type: 'string' },
                        },
                    },
                },
            },
        },
    };
}

export function parseFillResponse(text, uids) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new ToolkitError('FILL_JSON_INVALID', 'AI 生成的描述不是合法 JSON。', { error, preview: String(text ?? '').slice(0, 800) });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.hasOwn(value, 'descriptions')
        || !Array.isArray(value.descriptions)) {
        throw new ToolkitError('FILL_RESPONSE_INVALID', 'AI 生成的描述结构无效。');
    }
    const known = new Set(uids);
    const descriptions = [];
    const failures = [];
    const seen = new Set();
    for (const item of value.descriptions) {
        const uid = String(item?.uid ?? '');
        const description = typeof item?.description === 'string' ? item.description.trim() : '';
        if (!known.has(uid))
            throw new ToolkitError('FILL_UNKNOWN_UID', 'AI 生成的描述包含未知条目 UID。');
        if (seen.has(uid))
            continue;
        seen.add(uid);
        if (!description)
            failures.push({ uid, code: 'EMPTY_DESCRIPTION' });
        else if (description.length > FILL_MAX_DESCRIPTION_CHARS)
            failures.push({ uid, code: 'DESCRIPTION_TOO_LONG' });
        else
            descriptions.push({ uid, description });
    }
    for (const uid of known) {
        if (!seen.has(uid))
            failures.push({ uid, code: 'MISSING_RESPONSE' });
    }
    return { descriptions, failures };
}