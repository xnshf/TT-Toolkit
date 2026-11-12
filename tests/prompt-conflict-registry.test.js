import { describe, expect, it } from 'vitest';
import {
    featureDefinitions,
    featureRegistrations,
    temporarilyHiddenFeatureIds,
} from '../src/features/registry.js';

describe('prompt conflict registration', () => {
    it('restores model settings and decision activation while keeping prompt conflict hidden', () => {
        const registration = featureDefinitions.find(feature => feature.id === 'prompt-conflict');
        expect(registration).toMatchObject({ category: { id: 'prompt' }, defaultEnabled: false });

        const worldInfo = featureRegistrations.find(feature => feature.id === 'world-info-ai');
        expect(worldInfo).toMatchObject({ category: { id: 'world-info' }, defaultEnabled: false });

        const modelSettings = featureRegistrations.find(feature => feature.id === 'model-settings');
        expect(modelSettings).toMatchObject({ category: { id: 'settings' }, defaultEnabled: true });

        expect(temporarilyHiddenFeatureIds).toEqual(['prompt-conflict']);
        expect(featureRegistrations.map(feature => feature.id)).not.toContain('prompt-conflict');
    });
});
