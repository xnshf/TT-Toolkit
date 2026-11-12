import { describe, expect, it } from 'vitest';
import {
    attachWorldEntryRefs,
    buildPromptItemView,
    describeIdentifier,
    filterItems,
    normalizeWorldPosition,
    projectWorldEntries,
    promptDocumentFilename,
    rebuildChatMessages,
    serializePromptItems,
    stringifyContent,
} from '../src/features/prompt-viewer/model.js';

describe('prompt viewer identifier classification', () => {
    it('classifies static identifiers, prefixes, presets and unknown entries', () => {
        expect(describeIdentifier('charDescription')).toEqual({ source: 'character', label: '角色描述' });
        expect(describeIdentifier('worldInfoBefore')).toEqual({ source: 'world-info', label: '世界书（角色前）' });
        expect(describeIdentifier('chatHistory-4')).toEqual({ source: 'chat-history', label: '对话历史' });
        expect(describeIdentifier('dialogueExamples 0-1')).toEqual({ source: 'character', label: '示例对话' });
        expect(describeIdentifier('customDepthWI_4_0')).toEqual({ source: 'world-info', label: '世界书（深度注入）' });
        expect(describeIdentifier('user.custom', 'My Prompt')).toEqual({ source: 'preset', label: 'My Prompt' });
        expect(describeIdentifier('', null)).toEqual({ source: 'unknown', label: '未命名条目' });
    });
});

describe('prompt viewer item projection', () => {
    it('builds ordered items with source, role and tokens', () => {
        const items = buildPromptItemView([
            { identifier: 'main', role: 'system', content: 'hello', tokens: 10, promptName: 'Main Prompt' },
            { identifier: 'chatHistory-1', role: 'user', content: 'hi', tokens: 2, name: 'User' },
        ]);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ order: 0, identifier: 'main', source: 'preset', label: 'Main Prompt', tokens: 10 });
        expect(items[1]).toMatchObject({ order: 1, source: 'chat-history', role: 'user', name: 'User' });
    });

    it('stringifies structured content safely', () => {
        expect(stringifyContent('text')).toBe('text');
        expect(stringifyContent([{ type: 'text', text: 'a' }])).toBe('[{"type":"text","text":"a"}]');
        expect(stringifyContent(null)).toBe('');
    });

    it('renders image parts as a placeholder instead of leaking base64 data', () => {
        const content = [
            { type: 'text', text: '[世界书图片: 圣殿]' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
        ];
        const text = stringifyContent(content);
        expect(text).toBe('[世界书图片: 圣殿]\n[图片附件: image/png]');
        expect(text).not.toContain('base64');
    });

    it('labels injected world-info image messages', () => {
        expect(describeIdentifier('worldInfoImage_2', '世界书图片（圣殿）'))
            .toEqual({ source: 'world-info', label: '世界书图片（圣殿）' });
    });

    it('normalizes numeric and string positions and derives triggers', () => {
        expect(normalizeWorldPosition(0)).toBe('before');
        expect(normalizeWorldPosition('depth')).toBe('depth');
        expect(normalizeWorldPosition(99)).toBe('unknown');
        const entries = projectWorldEntries([
            { world: 'Book', uid: 1, comment: '常驻', position: 0, constant: true },
            { world: 'Book', uid: 2, key: ['k'], position: 4, depth: 3, role: 'system' },
            { world: 'Book', uid: 3, extensions: { vectorized: true }, position: 1 },
        ]);
        expect(entries[0]).toMatchObject({ position: 'before', trigger: 'constant', comment: '常驻' });
        expect(entries[1]).toMatchObject({ position: 'depth', depth: 3, trigger: 'keyword', comment: 'k' });
        expect(entries[2]).toMatchObject({ position: 'after', trigger: 'vector' });
    });

    it('attaches before and after world entry references to matching items', () => {
        const items = buildPromptItemView([
            { identifier: 'worldInfoBefore', role: 'system', content: 'x', tokens: 1 },
            { identifier: 'main', role: 'system', content: 'y', tokens: 1, promptName: 'Main' },
            { identifier: 'worldInfoAfter', role: 'system', content: 'z', tokens: 1 },
        ]);
        const worldEntries = projectWorldEntries([
            { world: 'A', uid: 1, position: 0 },
            { world: 'B', uid: 2, position: 1 },
        ]);
        const attached = attachWorldEntryRefs(items, worldEntries);
        expect(attached[0].worldEntryRefs).toEqual([0]);
        expect(attached[1].worldEntryRefs).toEqual([]);
        expect(attached[2].worldEntryRefs).toEqual([1]);
    });
});

describe('prompt viewer filtering and serialization', () => {
    const items = buildPromptItemView([
        { identifier: 'main', role: 'system', content: 'System rules', tokens: 5, promptName: 'Main Prompt' },
        { identifier: 'chatHistory-1', role: 'user', content: 'Alpha question', tokens: 3 },
        { identifier: 'chatHistory-2', role: 'assistant', content: '', tokens: 0 },
    ]);

    it('filters by source and searches content, label and name', () => {
        expect(filterItems(items, { source: 'chat-history' })).toHaveLength(2);
        expect(filterItems(items, { query: 'alpha' })).toHaveLength(1);
        expect(filterItems(items, { query: 'main prompt' })).toHaveLength(1);
    });

    it('serializes readable role blocks and skips empty non-tool messages', () => {
        const text = serializePromptItems(items);
        expect(text).toBe('[system]\nSystem rules\n\n[user]\nAlpha question');
    });

    it('rebuilds protocol messages including tool turns', () => {
        const withTool = buildPromptItemView([
            { identifier: 'tool-1', role: 'tool', content: '', tokens: 1, toolCalls: null },
            { identifier: 'assistant-1', role: 'assistant', content: '', tokens: 1, toolCalls: [{ id: 'call' }] },
        ]);
        const messages = rebuildChatMessages(withTool);
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'tool-1' });
        expect(messages[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call' }] });
    });

    it('builds protocol-shaped filenames', () => {
        expect(promptDocumentFilename('sent', new Date('2026-09-13T05:06:07'))).toBe('prompt-sent-20260913-050607.txt');
        expect(promptDocumentFilename('prediction', new Date('2026-01-02T03:04:05'))).toBe('prompt-prediction-20260102-030405.txt');
    });
});
