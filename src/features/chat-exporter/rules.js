import { cleanWithRules } from '../chat-cleaner/rules.js';

function mergeIntervals(intervals) {
    const sorted = intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged.at(-1);
        if (!previous || interval[0] > previous[1])
            merged.push([...interval]);
        else
            previous[1] = Math.max(previous[1], interval[1]);
    }
    return merged;
}

export function includeWithRules(text, rules) {
    const intervals = [];
    let unmatchedStartCount = 0;
    let unmatchedEndCount = 0;
    let matchCount = 0;
    for (const rule of rules.filter(item => item.enabled)) {
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
            const end = text.indexOf(rule.end, contentStart);
            if (end === -1) {
                unmatchedStartCount += 1;
                break;
            }
            intervals.push([contentStart, end]);
            matchCount += 1;
            cursor = end + rule.end.length;
        }
    }
    const merged = mergeIntervals(intervals);
    return {
        text: merged.map(([start, end]) => text.slice(start, end)).join('\n\n'),
        matchCount,
        unmatchedStartCount,
        unmatchedEndCount,
        noMatch: matchCount === 0,
    };
}

export function excludeWithRules(text, rules) {
    const result = cleanWithRules(text, rules);
    return { ...result, noMatch: result.matchCount === 0 };
}
