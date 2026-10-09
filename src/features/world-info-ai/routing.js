import { ToolkitError } from '../../kernel/errors.js';
import { worldEntryKey } from './schema.js';
import { WORLD_INFO_LORE_LISTS } from '../../kernel/world-info.js';

export function parseActivationResponse(text, candidateIds) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new ToolkitError('AI_ROUTER_JSON_INVALID', 'AI 世界书判定未返回合法 JSON。', { error, preview: String(text ?? '').slice(0, 800) });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.hasOwn(value, 'activate')
        || !Array.isArray(value.activate) || value.activate.some(item => typeof item !== 'string')) {
        throw new ToolkitError('AI_ROUTER_RESPONSE_INVALID', 'AI 世界书判定返回结构无效。');
    }
    const known = new Set(candidateIds);
    const selected = [];
    for (const id of value.activate) {
        if (!known.has(id))
            throw new ToolkitError('AI_ROUTER_UNKNOWN_UID', 'AI 世界书判定返回了未知候选 UID。');
        if (!selected.includes(id))
            selected.push(id);
    }
    return new Set(selected);
}

function stripNativeActivationDecorators(content) {
    const lines = String(content ?? '').split(/\r?\n/);
    while (lines.length && /^@@(?:activate|dont_activate)(?:\s|$)/.test(lines[0]))
        lines.shift();
    return lines.join('\n');
}

export function neutralizeAiEntryTriggers(entry) {
    return {
        ...entry,
        content: stripNativeActivationDecorators(entry.content),
        disable: false,
        key: [],
        keysecondary: [],
        constant: false,
        vectorized: false,
        triggers: [],
        characterFilter: null,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        delayUntilRecursion: false,
        useProbability: false,
        probability: 100,
        group: '',
        groupOverride: false,
        useGroupScoring: false,
    };
}

// lorePayload has already passed the kernel world-info subscription boundary.
export function applyActivationDecision(lorePayload, managedIds, selectedIds) {
    const managed = new Set(managedIds);
    const selected = new Set(selectedIds);
    const forceEntries = [];
    let suppressedCount = 0;
    for (const listName of WORLD_INFO_LORE_LISTS) {
        const entries = lorePayload[listName];
        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index];
            const id = worldEntryKey(entry?.world, entry?.uid);
            if (!managed.has(id))
                continue;
            if (!selected.has(id)) {
                entries.splice(index, 1);
                suppressedCount += 1;
                continue;
            }
            const neutralized = neutralizeAiEntryTriggers(entry);
            entries[index] = neutralized;
            forceEntries.push(neutralized);
        }
    }
    return { forceEntries, suppressedCount };
}

export function activationJsonSchema(candidateIds) {
    return {
        name: 'tt_toolkit_world_info_activation',
        description: 'Select world info candidate IDs to activate.',
        strict: true,
        value: {
            type: 'object',
            additionalProperties: false,
            required: ['activate'],
            properties: {
                activate: {
                    type: 'array',
                    uniqueItems: true,
                    items: { type: 'string', enum: [...candidateIds] },
                },
            },
        },
    };
}
