function singleLine(value, fallback) {
    const text = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function escapeMarkdownInline(value) {
    return singleLine(value, '').replace(/([\\\`*_{}\[\]<>])/g, '\\$1');
}

export function exportSpeaker(item, anonymous) {
    if (anonymous)
        return item.role === 'user' ? '用户' : '助手';
    return singleLine(item.name, item.role === 'user' ? '用户' : '助手');
}

export function serializeChatDocument(plan, options) {
    const title = singleLine(options?.title, '聊天记录');
    const format = options?.format ?? plan.settings.format;
    if (!['markdown', 'text'].includes(format))
        throw new TypeError('不支持的聊天文档格式');
    const blocks = plan.items.map((item, index) => {
        const speaker = exportSpeaker(item, plan.settings.anonymous);
        if (format === 'markdown')
            return `## 消息 ${index + 1}\n\n> **${escapeMarkdownInline(speaker)}**\n\n${item.text}`;
        return `消息 ${index + 1}\n[${singleLine(speaker, '未知')}]\n${item.text}`;
    });
    const heading = format === 'markdown' ? `# ${escapeMarkdownInline(title)}` : title;
    return `${heading}\n\n${blocks.join('\n\n')}\n`;
}

export function chatDocumentFilename(titleInput, format, date = new Date()) {
    const title = singleLine(titleInput, '聊天记录')
        .split('')
        .map(character => character.charCodeAt(0) < 32 ? ' ' : character)
        .join('')
        .replace(/[<>:"/\\|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48) || '聊天记录';
    const pad = value => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${title}-${stamp}.${format === 'markdown' ? 'md' : 'txt'}`;
}
