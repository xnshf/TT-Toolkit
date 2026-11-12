import { describe, expect, it } from 'vitest';
import { createDefaultProgress, createDefaultSettings, parseProgress, parseSettings } from '../src/features/chat-cleaner/schema.js';
describe('schemas', () => {
    it('uses safe first-install defaults', () => {
        const settings = createDefaultSettings();
        expect(settings.auto.enabled).toBe(false);
        expect(settings.auto.keepAssistant).toBe(5);
        expect(settings.auto.keepUser).toBe(5);
        expect(settings.deleteNativeReasoning).toBe(true);
        expect(settings.clearSwipes).toBe(false);
        expect(settings.user.enabled).toBe(false);
    });
    it('rejects unknown or damaged settings', () => {
        expect(() => parseSettings({ ...createDefaultSettings(), unknown: true })).toThrow(/未知字段/);
        expect(() => parseSettings({ ...createDefaultSettings(), schemaVersion: 2 })).toThrow(/不支持/);
    });
    it('explicitly upgrades known old v1 settings but rejects present invalid clearSwipes', () => {
        const legacy = createDefaultSettings();
        delete legacy.clearSwipes;
        expect(parseSettings(legacy).clearSwipes).toBe(false);
        expect(parseSettings({ ...legacy, clearSwipes: true }).clearSwipes).toBe(true);
        for (const clearSwipes of [undefined, null, 1, 'true'])
            expect(() => parseSettings({ ...legacy, clearSwipes })).toThrow(/布尔值/);
        delete legacy.user;
        expect(() => parseSettings(legacy)).toThrow(/缺失或未知字段/);
    });
    it('accepts missing progress and rejects non-object progress', () => {
        expect(parseProgress(undefined)).toEqual(createDefaultProgress());
        expect(() => parseProgress('bad')).toThrow(/必须是对象/);
    });
    it('rejects legacy v1 progress with a version message before key checks', () => {
        expect(() => parseProgress({
            schemaVersion: 1,
            stableChatId: null,
            assistantThrough: -1,
            userThrough: -1,
            rulesFingerprint: '',
            observedMessageCount: 0,
            tailAnchor: null,
            lastSuccessfulAt: null,
        })).toThrow(/不支持的聊天清洗进度版本/);
    });
});
