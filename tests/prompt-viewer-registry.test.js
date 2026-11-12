import { describe, expect, it } from 'vitest';
import { featureDefinitions, featureRegistrations, temporarilyHiddenFeatureIds } from '../src/features/registry.js';

describe('prompt viewer registration', () => {
    it('registers as the prompt viewer feature and is disabled by default', () => {
        const registration = featureDefinitions.find(feature => feature.id === 'prompt-viewer');
        expect(registration).toMatchObject({ category: { id: 'prompt' }, defaultEnabled: false });
        expect(featureRegistrations.map(feature => feature.id)).toContain('prompt-viewer');
        expect(temporarilyHiddenFeatureIds).not.toContain('prompt-viewer');
    });
});
