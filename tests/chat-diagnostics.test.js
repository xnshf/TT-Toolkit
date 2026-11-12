import { describe, expect, it } from 'vitest';
import { ToolkitError } from '../src/kernel/errors.js';
import { chatFailureData } from '../src/kernel/chat-diagnostics.js';
import { projectLogPayload } from '../src/kernel/logging/serialize.js';

describe('read-only chat failure diagnostics', () => {
    it('retains only approved source, field, constraint, types and numeric positions', () => {
        const error = new ToolkitError('INVALID_SCHEMA', 'private-message', {
            field: 'settings.assistant.includeRules[3].end', expected: 'string', actualType: 'object', ruleIndex: 3,
            sourceLocation: 'chat-exporter/schema.js', secret: 'private-context', actual: { secret: 'private-actual' },
        });
        const data = chatFailureData('settings.save', error);
        expect(data).toMatchObject({
            field: 'settings.assistant.includeRules[3].end', expected: 'string', actualType: 'object', ruleIndex: 3,
            sourceLocation: 'chat-exporter/schema.js', reason: 'settings-invalid', outcome: 'blocked', nextAction: 'correct-or-reset-settings',
        });
        expect(JSON.stringify(projectLogPayload(data, { error }, false))).not.toContain('private');
    });

    it('does not treat arbitrary context, error codes or names as safe diagnostics', () => {
        const error = new ToolkitError('__proto__', 'private-message', {
            field: 'private-field', expected: 'private-constraint', actualType: 'private-type', sourceLocation: 'private-path', absoluteIndex: 'private-index',
        });
        expect(chatFailureData('chat.snapshot', error)).toEqual({
            operation: 'chat.snapshot', stage: 'chat.snapshot', kind: 'ToolkitError', code: 'UNKNOWN_TOOLKIT_ERROR',
            reason: 'unexpected-readonly-failure', outcome: 'blocked', nextAction: 'retry-or-report',
        });
        const nativeError = new Error('private-detail');
        nativeError.name = 'private-name';
        expect(JSON.stringify(chatFailureData('chat.snapshot', nativeError))).not.toContain('private');
    });
});
