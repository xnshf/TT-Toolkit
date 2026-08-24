const PROMPT_TEMPLATE_DECORATORS = new Set([
    '@@message_formatting', '@@generate_before', '@@generate_after',
    '@@render_before', '@@render_after', '@@dont_preload',
    '@@initial_variables', '@@always_enabled', '@@only_preload',
    '@@iframe', '@@preprocessing', '@@if', '@@private',
]);

function leadingDecorators(content) {
    const output = [];
    for (const line of String(content ?? '').split(/\r?\n/)) {
        if (!line.startsWith('@@') || line.startsWith('@@@'))
            break;
        output.push(line.split(/\s+/, 1)[0].toLowerCase());
    }
    return output;
}

export function detectPromptTemplateEntry(entry) {
    const content = String(entry?.content ?? '');
    const comment = String(entry?.comment ?? '');
    const reasons = [];
    if (content.includes('<%') || content.includes('%>') || /<#\/?escape-ejs>/i.test(content))
        reasons.push('EJS 语法');
    if (/\[GENERATE:|\[RENDER:|@INJECT|\[InitialVariables\]|\[Preprocessing\]/i.test(comment))
        reasons.push('Prompt Template 专用标题');
    const decorators = leadingDecorators(content).filter(value => PROMPT_TEMPLATE_DECORATORS.has(value));
    if (decorators.length)
        reasons.push(`Prompt Template 装饰器 ${decorators.join('、')}`);
    return { detected: reasons.length > 0, reasons };
}
