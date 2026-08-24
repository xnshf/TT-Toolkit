import { projectConversationSnapshot } from '../../kernel/chat-projection.js';
import { ToolkitError } from '../../kernel/errors.js';
import { parseExportSettings } from './schema.js';
import { excludeWithRules, includeWithRules } from './rules.js';

function roleIncluded(role, filter) {
    return filter === 'all' || filter === role;
}

function enabledRules(roleSettings) {
    const rules = roleSettings.strategy === 'include' ? roleSettings.includeRules : roleSettings.excludeRules;
    return rules.filter(rule => rule.enabled);
}

function transformItem(item, roleSettings) {
    if (roleSettings.strategy === 'none') {
        return {
            text: item.text,
            strategy: 'none',
            matchCount: 0,
            unmatchedStartCount: 0,
            unmatchedEndCount: 0,
            skipReason: '',
        };
    }
    const rules = enabledRules(roleSettings);
    if (rules.length === 0)
        throw new ToolkitError('NO_ACTIVE_RULES', `${item.role === 'assistant' ? 'AI' : '用户'}已选择处理策略，但没有启用规则`);
    const result = roleSettings.strategy === 'include'
        ? includeWithRules(item.text, rules)
        : excludeWithRules(item.text, rules);
    return {
        ...result,
        strategy: roleSettings.strategy,
        skipReason: roleSettings.strategy === 'include' && result.noMatch
            ? 'include-no-match'
            : result.text.length === 0 ? 'empty' : '',
    };
}

function warning(kind, item) {
    const labels = {
        'include-no-match': '正选未命中，将跳过该消息',
        empty: '处理后正文为空，将跳过该消息',
        unmatched: '存在未配对标记，请检查规则',
    };
    return {
        kind,
        conversationIndex: item.conversationIndex,
        absoluteIndex: item.absoluteIndex,
        role: item.role,
        message: `对话楼层 ${item.conversationIndex}：${labels[kind]}`,
    };
}

export function buildChatExportPlan(snapshot, settingsInput, rangeInput) {
    const settings = parseExportSettings(settingsInput);
    const model = projectConversationSnapshot(snapshot);
    const start = Number(rangeInput?.start);
    const end = Number(rangeInput?.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > model.items.length)
        throw new ToolkitError('INVALID_RANGE', `导出范围必须满足 1 ≤ 起始楼层 ≤ 截止楼层 ≤ ${model.items.length}`);
    const sourceItems = model.items
        .slice(start - 1, end)
        .filter(item => roleIncluded(item.role, settings.roleFilter));
    if (sourceItems.length === 0)
        throw new ToolkitError('NO_EXPORT_MESSAGES', '所选范围和角色过滤条件下没有可导出的消息');
    const warnings = [];
    const entries = sourceItems.map(item => {
        const transformed = transformItem(item, settings[item.role]);
        if (transformed.skipReason)
            warnings.push(warning(transformed.skipReason, item));
        if (transformed.unmatchedStartCount > 0 || transformed.unmatchedEndCount > 0)
            warnings.push(warning('unmatched', item));
        return { ...item, originalText: item.text, ...transformed, included: !transformed.skipReason };
    });
    const items = entries.filter(item => item.included);
    if (items.length === 0)
        throw new ToolkitError('NO_EXPORT_MESSAGES', '规则处理后没有可导出的消息');
    return {
        identity: model.identity,
        projectionStats: model.stats,
        range: { start, end },
        settings,
        sourceItems,
        entries,
        items,
        warnings,
        requiresConfirmation: warnings.length > 0,
        stats: {
            rangedMessages: end - start + 1,
            roleFilteredMessages: sourceItems.length,
            exportedMessages: items.length,
            skippedMessages: entries.length - items.length,
            changedMessages: entries.filter(item => item.originalText !== item.text).length,
            matchCount: entries.reduce((sum, item) => sum + item.matchCount, 0),
            warningCount: warnings.length,
        },
    };
}
