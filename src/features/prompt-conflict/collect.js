import { sha256Hex } from '../../kernel/hash.js';
import { WORLD_INFO_LORE_LISTS } from '../../kernel/world-info.js';
import { detectPromptTemplateEntry } from './dynamic-template.js';
import { createPresetSource, createWorldInfoSource, isAnalyzable, isConstantWorldInfoEntry } from './sources.js';

// 从宿主读取预设与世界书正文，组装成本轮的来源快照。纯读取，不写任何状态。
async function collectPresetSources(host, sources) {
    const presetInputs = await host.getPromptConflictPresetSources();
    for (const input of presetInputs) {
        const identifierDigest = await sha256Hex(input.identifier);
        const contentDigest = await sha256Hex(input.content);
        const source = createPresetSource({
            identifierDigest,
            label: input.label,
            role: input.role,
            position: input.position,
            order: input.order,
            content: input.content,
            contentDigest,
        });
        source.dynamic = detectPromptTemplateEntry({ content: input.content, comment: '' }).detected;
        source.suppressedForCurrentChat = false;
        sources.push(source);
    }
}

async function collectWorldInfoSources(host, records, sources) {
    const groups = await host.getMountedWorldInfoEntries();
    for (const listName of WORLD_INFO_LORE_LISTS) {
        for (const entry of groups[listName] ?? []) {
            if (!isConstantWorldInfoEntry(entry))
                continue;
            const worldDigest = await sha256Hex(String(entry.world ?? ''));
            const expanded = await host.expandPromptConflictSourceMacros(entry.content);
            const rawContentDigest = await sha256Hex(String(entry.content ?? ''));
            const contentDigest = await sha256Hex(expanded);
            const source = createWorldInfoSource({
                worldDigest,
                uid: entry.uid,
                worldName: String(entry.world ?? ''),
                label: String(entry.comment ?? `条目 ${String(entry.uid)}`),
                position: Number(entry.position ?? 0),
                order: Number(entry.order ?? 0),
                content: expanded,
                contentDigest,
                rawContentDigest,
            });
            source.dynamic = detectPromptTemplateEntry(entry).detected;
            source.suppressedForCurrentChat = records.some(record =>
                record.worldDigest === worldDigest
                && typeof record.uid === typeof entry.uid
                && record.uid === entry.uid
                && record.contentDigest === rawContentDigest);
            sources.push(source);
        }
    }
}

export async function collectSources(host, records) {
    const sources = [];
    await collectPresetSources(host, sources);
    await collectWorldInfoSources(host, records, sources);
    return sources;
}

// 沿用上一轮的勾选：仍然可检测且此前被勾选的保持勾选，新出现的可检测来源默认勾选。
export function applyPreviousSelection(sources, previous) {
    for (const source of sources)
        source.enabledForDetection = previous.get(source.sourceId) === true && isAnalyzable(source);
    for (const source of sources) {
        if (isAnalyzable(source) && !previous.has(source.sourceId))
            source.enabledForDetection = true;
    }
}

export function summarizeSources(sources) {
    return {
        analyzable: sources.filter(isAnalyzable).length,
        suppressed: sources.filter(source => source.suppressedForCurrentChat).length,
        unsupported: sources.filter(source => source.dynamic && !source.suppressedForCurrentChat).length,
    };
}
