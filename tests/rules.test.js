import { describe, expect, it } from 'vitest';
import { cleanWithRule, cleanWithRules, rulesFingerprint } from '../src/features/chat-cleaner/rules.js';
import { createDefaultSettings } from '../src/features/chat-cleaner/schema.js';
describe('literal rules', () => {
    it('removes multiple multiline paired ranges', () => {
        const result = cleanWithRule('a<think>one\ntwo</think>b<think></think>c', { id: 'r', enabled: true, start: '<think>', end: '</think>' });
        expect(result.text).toBe('abc');
        expect(result.matchCount).toBe(2);
    });
    it('uses the first closing marker and does not parse nesting', () => {
        const result = cleanWithRule('x<a>1<a>2</a>3</a>y', { id: 'r', enabled: true, start: '<a>', end: '</a>' });
        expect(result.text).toBe('x3</a>y');
    });
    it('supports intentional one-sided rules', () => {
        expect(cleanWithRule('before CUT after', { id: 'a', enabled: true, start: 'CUT', end: '' }).text).toBe('before ');
        expect(cleanWithRule('before CUT after', { id: 'b', enabled: true, start: '', end: 'CUT' }).text).toBe(' after');
    });
    it('keeps unmatched content and applies rules in order', () => {
        const result = cleanWithRules('x[a]one[/a]y[b]tail', [
            { id: 'a', enabled: true, start: '[a]', end: '[/a]' },
            { id: 'b', enabled: true, start: '[b]', end: '[/b]' },
        ]);
        expect(result.text).toBe('xy[b]tail');
        expect(result.unmatchedStartCount).toBe(1);
    });
    it('produces stable semantic fingerprints', () => {
        const settings = createDefaultSettings();
        expect(rulesFingerprint(settings)).toBe(rulesFingerprint(structuredClone(settings)));
        settings.deleteNativeReasoning = false;
        expect(rulesFingerprint(settings)).not.toBe(rulesFingerprint(createDefaultSettings()));
    });
});
