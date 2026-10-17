import { ToolkitError } from '../../kernel/errors.js';
import { classifyMessage } from '../../kernel/chat-messages.js';
import { valueType } from '../../kernel/chat-diagnostics.js';
import { detectPromptTemplateEntry } from '../../kernel/dynamic-template.js';

function invalid(field, value, expected, messageIndex) {
    throw new ToolkitError('DECISION_CONTEXT_INVALID', '决策上下文数据无效，本轮应使用原生激活。', {
        field, expected, actualType: valueType(value),
        ...(messageIndex !== undefined ? { messageIndex } : {}),
        sourceLocation: 'features/world-info-ai/context.js:buildDecisionContext',
    });
}

// The caller supplies only mounted, native, character/generation-eligible backgrounds.
// Canonical mes already has write-time regex; only the host prompt regex is applied here.
export async function buildDecisionContext(host, messages, backgroundEntries, settings, generationType = 'normal') {
    if (!Array.isArray(messages)) invalid('messages', messages, 'array');
    if (!Array.isArray(backgroundEntries)) invalid('backgroundEntries', backgroundEntries, 'array');
    const rounds = settings?.historyRounds;
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100)
        invalid('historyRounds', rounds, 'integer-1-100');
    if (typeof generationType !== 'string') invalid('generationType', generationType, 'string');
    if (typeof host?.formatDecisionText !== 'function')
        throw new ToolkitError('HOST_DECISION_REGEX_MISSING', '决策上下文需要宿主提示词正则接口，不允许使用原文回退。');

    const branch = [];
    for (let index = 0; index < messages.length; index++) {
        const raw = messages[index];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            invalid('message', raw, 'record', index);
        const role = classifyMessage(raw, index);
        if (raw.is_system || raw.role === 'system' || role === 'system' || role === 'tool') continue;
        branch.push({ index, role, name: typeof raw.name === 'string' ? raw.name : '', content: raw.mes });
    }
    // Regenerate has already removed the old reply before the host loads world info.
    if (generationType === 'swipe' && branch.at(-1)?.role === 'assistant') branch.pop();
    const userIndices = branch.flatMap((message, index) => message.role === 'user' ? [index] : []);
    const start = userIndices.length > rounds ? userIndices[userIndices.length - rounds]
        : userIndices.length ? 0 : Math.max(0, branch.length - 1);
    const selected = branch.slice(start).map((message, index) => {
        if (typeof message.content !== 'string') invalid('mes', message.content, 'string', message.index);
        return { ...message, depth: branch.length - start - index - (generationType === 'continue' ? 2 : 1) };
    });
    const backgrounds = [];
    for (const entry of backgroundEntries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            invalid('backgroundEntry', entry, 'record');
        if (entry.constant !== true || entry.disable == true || detectPromptTemplateEntry(entry).detected) continue;
        if (typeof entry.content !== 'string') invalid('content', entry.content, 'string');
        if (/^[ \t]*@@dont_activate\b/mu.test(entry.content)) continue;
        backgrounds.push({ content: entry.content });
    }
    // All selection and primitive copies are complete before the first await.
    async function format(text, source, depth, messageIndex) {
        let result;
        try {
            result = await host.formatDecisionText(text, source, depth);
        }
        catch {
            throw new ToolkitError('DECISION_CONTEXT_FORMAT_FAILED', '决策上下文正则处理失败，本轮应使用原生激活。', {
                source, ...(messageIndex !== undefined ? { messageIndex } : {}),
                sourceLocation: 'features/world-info-ai/context.js:buildDecisionContext',
            });
        }
        if (typeof result !== 'string') invalid('formattedContent', result, 'string', messageIndex);
        return result;
    }
    const background = [];
    for (const entry of backgrounds) background.push({ content: await format(entry.content, 'world_info') });
    const dialogue = [];
    for (const { index, role, name, content, depth } of selected) {
        dialogue.push({ index, role, name, content: await format(content, role === 'user' ? 'user_input' : 'ai_output', depth, index) });
    }
    return JSON.stringify({ background, dialogue, current_input: dialogue.findLast(message => message.role === 'user')?.content ?? null });
}
