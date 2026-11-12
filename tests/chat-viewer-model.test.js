import { describe, expect, it } from 'vitest';
import {
    buildChatViewModel,
    defaultChatRange,
    paginateChatItems,
    prefixSnippet,
    searchChatMessages,
    searchSnippet,
    selectChatRange,
} from '../src/features/chat-viewer/model.js';

const identity = { stableId: 'chat-1', label: '当前聊天', ref: { kind: 'character' } };
const user = (mes, extra = {}) => ({ is_user: true, is_system: false, name: 'User', mes, extra });
const assistant = (mes, extra = {}) => ({ is_user: false, is_system: false, name: 'Char', mes, swipes: [mes], swipe_id: 0, extra });

describe('chat viewer model', () => {
    it('builds a 1-based conversational index while excluding system and tool floors', () => {
        const hidden = { ...assistant('hidden'), is_system: true, original_avatar: 'char.png' };
        const compact = assistant('compact', { isSmallSys: true });
        const model = buildChatViewModel({ identity, messages: [
            { is_system: true, mes: 'system', extra: { type: 'generic' } },
            user('first'),
            { is_system: true, mes: 'tool', extra: { tool_invocations: [] } },
            hidden,
            compact,
        ] });

        expect(model.items.map(item => [item.conversationIndex, item.absoluteIndex])).toEqual([[1, 1], [2, 3], [3, 4]]);
        expect(model.items.map(item => item.hidden)).toEqual([false, true, true]);
        expect(model.stats).toMatchObject({
            totalMessages: 5,
            conversationMessages: 3,
            excludedSystemMessages: 1,
            excludedToolMessages: 1,
            hiddenConversationMessages: 2,
            unreadableMessages: 0,
            invalidSwipeMessages: 0,
        });
    });

    it('includes a legacy character greeting marked as system at absolute floor zero', () => {
        const model = buildChatViewModel({ identity, messages: [
            { is_user: false, is_system: true, name: 'Char', mes: 'legacy greeting', extra: {} },
            { is_user: false, is_system: true, mes: 'system', extra: { type: 'generic' } },
        ] });

        expect(model.items).toEqual([
            expect.objectContaining({ absoluteIndex: 0, conversationIndex: 1, role: 'assistant', hidden: true }),
        ]);
        expect(model.stats).toMatchObject({ conversationMessages: 1, excludedSystemMessages: 1, hiddenConversationMessages: 1 });
    });

    it('defaults to the latest 20 floors and validates inclusive ranges', () => {
        const model = buildChatViewModel({ identity, messages: Array.from({ length: 25 }, (_, index) => user(`m${index}`)) });
        expect(defaultChatRange(model)).toEqual({ start: 6, end: 25 });
        expect(selectChatRange(model, 3, 5).map(item => item.conversationIndex)).toEqual([3, 4, 5]);
        expect(() => selectChatRange(model, 0, 4)).toThrow(/楼层范围/);
        expect(() => selectChatRange(model, 4, 3)).toThrow(/楼层范围/);
        expect(() => selectChatRange(model, 1, 26)).toThrow(/楼层范围/);
    });

    it('searches current bodies literally, case-insensitively, and keeps ascending order', () => {
        const model = buildChatViewModel({ identity, messages: [user('Alpha [one]'), assistant('middle'), user('alpha [ONE] again')] });
        expect(searchChatMessages(model, 'ALPHA [one]').map(item => item.conversationIndex)).toEqual([1, 3]);
        expect(() => searchChatMessages(model, '   ')).toThrow(/请输入/);
    });

    it('paginates without rendering the full range and creates bounded snippets', () => {
        const model = buildChatViewModel({ identity, messages: Array.from({ length: 42 }, (_, index) => user(`message ${index}`)) });
        const page = paginateChatItems(model.items, 1);
        expect(page.pageCount).toBe(3);
        expect(page.items).toHaveLength(20);
        expect(page.items[0].conversationIndex).toBe(21);
        expect(prefixSnippet('😀'.repeat(301))).toEqual({ text: '😀'.repeat(300), truncated: true });
        const snippet = searchSnippet(`${'前'.repeat(150)}命中${'后'.repeat(150)}`, '命中');
        expect(snippet.text).toContain('命中');
        expect(snippet.leading).toBe(true);
        expect(snippet.trailing).toBe(true);
    });

    it('finds hidden messages without provenance but still excludes explicit system and tool floors', () => {
        const model = buildChatViewModel({ identity, messages: [
            user('known'),
            { is_system: true, mes: 'needle hidden' },
            { is_system: true, mes: 'needle system', extra: { type: 'generic' } },
            { is_system: true, mes: 'needle tool', extra: { tool_invocations: [] } },
        ] });
        expect(searchChatMessages(model, 'needle').map(item => item.absoluteIndex)).toEqual([1]);
        expect(model.stats).toMatchObject({ excludedSystemMessages: 1, excludedToolMessages: 1, hiddenConversationMessages: 1 });
    });

    it('retains unreadable placeholders and keeps healthy messages searchable with stable indices', () => {
        const messages = [null, { is_user: true, mes: { secret: 'do-not-coerce' } }, assistant('needle')];
        const before = structuredClone(messages);
        const model = buildChatViewModel({ identity, messages });
        expect(model.items.map(item => [item.conversationIndex, item.absoluteIndex, item.readable])).toEqual([[1, 0, false], [2, 1, false], [3, 2, true]]);
        expect(model.issues).toMatchObject([
            { code: 'MESSAGE_NOT_OBJECT', field: 'message', actualType: 'null', absoluteIndex: 0, conversationIndex: 1 },
            { code: 'MESSAGE_BODY_NOT_STRING', field: 'mes', expected: 'string', actualType: 'object', absoluteIndex: 1, conversationIndex: 2 },
        ]);
        expect(searchChatMessages(model, 'needle').map(item => item.absoluteIndex)).toEqual([2]);
        expect(searchChatMessages(model, 'do-not-coerce')).toEqual([]);
        expect(model.stats.unreadableMessages).toBe(2);
        expect(messages).toEqual(before);
    });

    it.each([2, undefined, null, true, {}, '', 'bad'])('degrades invalid swipe pointer %j without losing current body', swipe_id => {
        const model = buildChatViewModel({ identity, messages: [{ ...assistant('current'), swipe_id }] });
        expect(model.items[0]).toMatchObject({ text: 'current', readable: true, swipeNumber: null, swipeCount: 1 });
        expect(model.issues[0]).toMatchObject({ code: 'MESSAGE_SWIPE_INVALID', field: 'swipe_id', expected: 'index-within-swipes', absoluteIndex: 0 });
        expect(model.stats.invalidSwipeMessages).toBe(1);
    });

    it('does not inspect cold candidates and supports a numeric legacy pointer', () => {
        const model = buildChatViewModel({ identity, messages: [{ ...assistant('current'), swipes: [null, 'original'], swipe_id: '1' }] });
        expect(model.items[0]).toMatchObject({ text: 'current', swipeNumber: 2, swipeCount: 2 });
        expect(model.issues).toEqual([]);
    });

    it('degrades malformed swipe arrays and retains sparse message slots', () => {
        const messages = new Array(2);
        messages[1] = { ...assistant('current'), swipes: {} };
        const model = buildChatViewModel({ identity, messages });
        expect(model.items).toHaveLength(2);
        expect(model.issues.map(item => item.code)).toEqual(['MESSAGE_NOT_OBJECT', 'MESSAGE_SWIPE_INVALID']);
        expect(model.items[1].absoluteIndex).toBe(1);
    });

    it('excludes first-class tool messages even when legacy display booleans were edited', () => {
        const model = buildChatViewModel({ identity, messages: [{ role: 'tool', is_system: false, is_user: true }, assistant('current')] });
        expect(model.stats.excludedToolMessages).toBe(1);
        expect(model.items[0].absoluteIndex).toBe(1);
        expect(model.issues).toEqual([]);
    });

    it('still blocks snapshots without a provable identity or message collection', () => {
        expect(() => buildChatViewModel({ identity: {}, messages: [] })).toThrow(/身份/);
        expect(() => buildChatViewModel({ identity, messages: null })).toThrow(/消息数组/);
    });
});
