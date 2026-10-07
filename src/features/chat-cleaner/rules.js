import { ToolkitError } from '../../kernel/errors.js';
function removeIntervals(text, intervals) {
    if (!intervals.length)
        return text;
    let cursor = 0;
    let output = '';
    for (const [start, end] of intervals) {
        output += text.slice(cursor, start);
        cursor = end;
    }
    return output + text.slice(cursor);
}
export function cleanWithRule(text, rule) {
    if (!rule.enabled)
        return { text, matchCount: 0, removedChars: 0, unmatchedStartCount: 0, unmatchedEndCount: 0 };
    if (!rule.start && !rule.end)
        throw new ToolkitError('INVALID_RULE', '规则的开始和结束标记不能同时为空', { ruleId: rule.id });
    const intervals = [];
    let unmatchedStartCount = 0;
    let unmatchedEndCount = 0;
    if (rule.start && rule.end) {
        let cursor = 0;
        while (cursor <= text.length) {
            const start = text.indexOf(rule.start, cursor);
            const strayEnd = text.indexOf(rule.end, cursor);
            if (strayEnd !== -1 && (start === -1 || strayEnd < start)) {
                unmatchedEndCount += 1;
                cursor = strayEnd + rule.end.length;
                continue;
            }
            if (start === -1)
                break;
            const contentStart = start + rule.start.length;
            const endMarker = text.indexOf(rule.end, contentStart);
            if (endMarker === -1) {
                unmatchedStartCount += 1;
                break;
            }
            const end = endMarker + rule.end.length;
            intervals.push([start, end]);
            cursor = end;
        }
    }
    else if (rule.start) {
        const start = text.indexOf(rule.start);
        if (start !== -1)
            intervals.push([start, text.length]);
    }
    else {
        const end = text.indexOf(rule.end);
        if (end !== -1)
            intervals.push([0, end + rule.end.length]);
    }
    const cleaned = removeIntervals(text, intervals);
    return {
        text: cleaned,
        matchCount: intervals.length,
        removedChars: text.length - cleaned.length,
        unmatchedStartCount,
        unmatchedEndCount,
    };
}
export function cleanWithRules(text, rules) {
    let current = text;
    const total = { text, matchCount: 0, removedChars: 0, unmatchedStartCount: 0, unmatchedEndCount: 0 };
    for (const rule of rules) {
        const result = cleanWithRule(current, rule);
        current = result.text;
        total.matchCount += result.matchCount;
        total.removedChars += result.removedChars;
        total.unmatchedStartCount += result.unmatchedStartCount;
        total.unmatchedEndCount += result.unmatchedEndCount;
    }
    total.text = current;
    return total;
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function stableHash(value) {
    const source = canonical(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
export function rulesFingerprint(settings) {
    return stableHash({
        algorithmVersion: 1,
        deleteNativeReasoning: settings.deleteNativeReasoning,
        clearSwipes: settings.clearSwipes,
        assistant: settings.assistant,
        user: settings.user,
        swipeScope: 'all',
    });
}
