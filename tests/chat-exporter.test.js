import { describe, expect, it } from 'vitest';
import { buildChatExportPlan } from '../src/features/chat-exporter/model.js';
import { includeWithRules } from '../src/features/chat-exporter/rules.js';
import { createDefaultExportSettings, parseExportSettings } from '../src/features/chat-exporter/schema.js';
import { chatDocumentFilename, serializeChatDocument } from '../src/features/chat-exporter/serialize.js';

const identity = { stableId: 'chat-1', ref: { kind: 'character' } };
const user = (mes, extra = {}) => ({ is_user: true, is_system: false, name: 'U*ser', mes, extra });
const assistant = (mes, extra = {}) => ({ is_user: false, is_system: false, name: 'AI', mes, extra });
const rule = (id, start, end) => ({ id, enabled: true, start, end });

describe('chat exporter settings', () => {
    it('uses safe defaults and keeps include/exclude rule banks independent', () => {
        const settings = createDefaultExportSettings();
        settings.assistant.strategy = 'include';
        settings.assistant.includeRules.push(rule('include', '<story>', '</story>'));
        settings.assistant.excludeRules.push(rule('exclude', '<think>', '</think>'));
        expect(parseExportSettings(settings).assistant).toEqual(settings.assistant);
    });

    it('requires paired positive markers and rejects unknown fields', () => {
        const settings = createDefaultExportSettings();
        settings.assistant.includeRules.push(rule('bad', '<story>', ''));
        expect(() => parseExportSettings(settings)).toThrow(/必须成对/);
        expect(() => parseExportSettings({ ...createDefaultExportSettings(), extra: true })).toThrow(/未知字段/);
    });
});

describe('positive selection', () => {
    it('unions complete matches from all rules in source order and removes markers', () => {
        const result = includeWithRules(
            'A<x>one</x>B<y>two</y>C<x>three</x>',
            [rule('x', '<x>', '</x>'), rule('y', '<y>', '</y>')],
        );
        expect(result.text).toBe('one\n\ntwo\n\nthree');
        expect(result.matchCount).toBe(3);
    });

    it('reports unmatched and missing pairs without falling back to the original body', () => {
        expect(includeWithRules('plain', [rule('x', '<x>', '</x>')])).toMatchObject({ text: '', noMatch: true });
        expect(includeWithRules('</x><x>open', [rule('x', '<x>', '</x>')])).toMatchObject({
            unmatchedStartCount: 1,
            unmatchedEndCount: 1,
        });
    });
});

describe('chat export plan and serializers', () => {
    it('uses the shared conversation projection, current mes, role filtering, and per-role strategies', () => {
        const settings = createDefaultExportSettings();
        settings.assistant.strategy = 'include';
        settings.assistant.includeRules = [rule('story', '<story>', '</story>')];
        settings.user.strategy = 'exclude';
        settings.user.excludeRules = [rule('note', '<note>', '</note>')];
        const snapshot = {
            identity,
            messages: [
                { is_user: false, is_system: true, name: 'AI', mes: 'Greeting expanded', swipes: ['Greeting {{user}}'], swipe_id: 0 },
                user('Question<note>private</note>'),
                assistant('<story># Answer</story>', { display_text: 'translated', reasoning: 'secret' }),
                assistant('missing tag'),
                { is_system: true, is_user: false, mes: 'system', extra: { type: 'generic' } },
            ],
        };
        const plan = buildChatExportPlan(snapshot, settings, { start: 1, end: 4 });
        expect(plan.entries.map(item => item.originalText)).toEqual([
            'Greeting expanded',
            'Question<note>private</note>',
            '<story># Answer</story>',
            'missing tag',
        ]);
        expect(plan.items.map(item => item.text)).toEqual(['Question', '# Answer']);
        expect(plan.stats.skippedMessages).toBe(2);
        expect(plan.requiresConfirmation).toBe(true);
    });

    it('exports untyped hidden messages while excluding explicit system and tool floors', () => {
        const plan = buildChatExportPlan({ identity, messages: [
            { is_system: true, mes: 'hidden AI' },
            { is_system: true, mes: 'system', extra: { type: 'generic' } },
            { is_system: true, mes: 'tool', extra: { tool_invocations: [] } },
        ] }, createDefaultExportSettings(), { start: 1, end: 1 });
        expect(plan.entries.map(item => item.originalText)).toEqual(['hidden AI']);
        expect(plan.projectionStats).toMatchObject({ excludedSystemMessages: 1, excludedToolMessages: 1 });
    });

    it('requires explicit confirmation to omit unreadable messages but preserves their indices in preview', () => {
        const plan = buildChatExportPlan({ identity, messages: [user('healthy'), null, { is_user: true, mes: 7 }, assistant('last')] }, createDefaultExportSettings(), { start: 1, end: 4 });
        expect(plan.entries.map(item => [item.absoluteIndex, item.included])).toEqual([[0, true], [1, false], [2, false], [3, true]]);
        expect(plan.stats).toMatchObject({ skippedMessages: 2, unreadableSkippedMessages: 2, ruleSkippedMessages: 0 });
        expect(plan.requiresConfirmation).toBe(true);
        expect(plan.warnings.map(item => item.code)).toEqual(['MESSAGE_NOT_OBJECT', 'MESSAGE_BODY_NOT_STRING']);
        expect(serializeChatDocument(plan, { title: 'Doc' })).not.toContain('7');
    });

    it('does not let an unrelated unreadable floor block a selected healthy range', () => {
        const plan = buildChatExportPlan({ identity, messages: [null, user('healthy')] }, createDefaultExportSettings(), { start: 2, end: 2 });
        expect(plan.items[0].text).toBe('healthy');
        expect(plan.requiresConfirmation).toBe(false);
        expect(plan.warnings).toEqual([]);
    });

    it('exports current mes with a swipe warning that does not require a loss confirmation', () => {
        const plan = buildChatExportPlan({ identity, messages: [{ ...assistant('healthy'), swipes: ['different'], swipe_id: {} }] }, createDefaultExportSettings(), { start: 1, end: 1 });
        expect(plan.items[0].text).toBe('healthy');
        expect(plan.warnings[0].code).toBe('MESSAGE_SWIPE_INVALID');
        expect(plan.requiresConfirmation).toBe(false);
    });

    it('does not silently classify unknown malformed floors when a role filter is used', () => {
        const settings = { ...createDefaultExportSettings(), roleFilter: 'user' };
        const plan = buildChatExportPlan({ identity, messages: [null, user('healthy'), assistant('filtered')] }, settings, { start: 1, end: 3 });
        expect(plan.requiresConfirmation).toBe(true);
        expect(plan.stats.unreadableSkippedMessages).toBe(1);
        expect(plan.items.map(item => item.text)).toEqual(['healthy']);
    });

    it('preserves processed body characters while adding stable markdown structure', () => {
        const settings = createDefaultExportSettings();
        const snapshot = { identity, messages: [user('# Head\r\n\n~~~md\n# code\n~~~  '), assistant('answer')] };
        const plan = buildChatExportPlan(snapshot, settings, { start: 1, end: 2 });
        expect(serializeChatDocument(plan, { title: ' My\nTitle ', format: 'markdown' })).toBe(
            '# My Title\n\n## 消息 1\n\n> **U\\*ser**\n\n# Head\r\n\n~~~md\n# code\n~~~  \n\n## 消息 2\n\n> **AI**\n\nanswer\n',
        );
    });

    it('supports anonymous plain text and sanitized timestamped filenames', () => {
        const settings = createDefaultExportSettings();
        settings.anonymous = true;
        const plan = buildChatExportPlan({ identity, messages: [user('body')] }, settings, { start: 1, end: 1 });
        expect(serializeChatDocument(plan, { title: '标题', format: 'text' })).toBe('标题\n\n消息 1\n[用户]\nbody\n');
        expect(chatDocumentFilename('A:B', 'markdown', new Date(2026, 7, 24, 12, 3, 4))).toBe('A B-20260824-120304.md');
    });

    it('rejects active strategies without rules and a fully skipped result', () => {
        const settings = createDefaultExportSettings();
        settings.assistant.strategy = 'include';
        expect(() => buildChatExportPlan({ identity, messages: [assistant('x')] }, settings, { start: 1, end: 1 })).toThrow(/没有启用规则/);
        settings.assistant.includeRules = [rule('story', '<story>', '</story>')];
        expect(() => buildChatExportPlan({ identity, messages: [assistant('x')] }, settings, { start: 1, end: 1 })).toThrow(/没有可导出/);
    });
});
