import { afterEach, describe, expect, it } from 'vitest';
import { captureFocus, restoreFocus } from '../src/ui/focus-keep.js';

afterEach(() => {
    document.body.replaceChildren();
});

function mount(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    return container;
}

describe('focus keeping across full re-renders', () => {
    it('captures the control key and caret of the focused element', () => {
        const container = mount('<input data-control="search" value="abc">');
        const input = container.querySelector('input');
        input.focus();
        input.setSelectionRange(1, 2);
        expect(captureFocus(container)).toEqual({ key: 'search', caret: [1, 2] });
    });

    it('ignores elements outside the container or without a stable key', () => {
        const container = mount('<input value="abc">');
        container.querySelector('input').focus();
        expect(captureFocus(container)).toBeNull();

        const other = mount('<input data-control="search" value="abc">');
        other.querySelector('input').focus();
        expect(captureFocus(container)).toBeNull();
    });

    it('restores focus and caret on the replacement node', () => {
        const container = mount('<input data-control="search" value="xyz">');
        const replacement = document.createElement('input');
        replacement.dataset.control = 'search';
        replacement.value = 'xyz';
        container.replaceChildren(replacement);
        expect(restoreFocus(container, { key: 'search', caret: [2, 2] })).toBe(replacement);
        expect(document.activeElement).toBe(replacement);
        expect(replacement.selectionStart).toBe(2);
    });

    it('returns null when the new node is missing or disabled so callers can retry later', () => {
        const container = mount('<input data-control="search">');
        expect(restoreFocus(container, { key: 'missing', caret: null })).toBeNull();

        const disabled = document.createElement('input');
        disabled.dataset.control = 'search';
        disabled.disabled = true;
        container.replaceChildren(disabled);
        expect(restoreFocus(container, { key: 'search', caret: null })).toBeNull();
        expect(restoreFocus(container, null)).toBeNull();
    });
});
