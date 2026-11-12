import { describe, expect, it, vi } from 'vitest';
import { searchField } from '../src/ui/search-field.js';

function typingEvent(type, isComposing) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'isComposing', { value: isComposing });
    return event;
}

describe('search field IME contract', () => {
    it('applies queries after a composition ends instead of mid-composition', () => {
        const onQuery = vi.fn();
        const input = searchField({ value: '', onQuery });
        input.value = 'ti';
        input.dispatchEvent(typingEvent('input', true));
        input.dispatchEvent(typingEvent('compositionend', false));
        input.value = '提示词';
        input.dispatchEvent(typingEvent('compositionend', false));
        expect(onQuery.mock.calls.map(call => call[0])).toEqual(['ti', '提示词']);
    });

    it('ignores Enter fired by an IME confirmation', () => {
        const onEnter = vi.fn();
        const input = searchField({ value: '', onEnter });
        const composingEnter = new KeyboardEvent('keydown', { key: 'Enter' });
        Object.defineProperty(composingEnter, 'isComposing', { value: true });
        input.dispatchEvent(composingEnter);
        expect(onEnter).not.toHaveBeenCalled();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(onEnter).toHaveBeenCalledTimes(1);
    });
});
