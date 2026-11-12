import { describe, expect, it, vi } from 'vitest';
import { resolveFeatures } from '../src/kernel/features.js';
describe('feature loader', () => {
    it('keeps implementation unloaded until activation and reuses the loaded instance', async () => {
        const activate = vi.fn(async () => undefined);
        const deactivate = vi.fn(async () => undefined);
        const mount = vi.fn(async () => undefined);
        const load = vi.fn(async () => ({ mount, activate, deactivate }));
        const registration = {
            id: 'test-feature',
            category: { id: 'category', label: 'Category', order: 1 },
            label: 'Test',
            description: 'Test feature',
            icon: 'T',
            order: 1,
            load,
        };
        const [feature] = resolveFeatures({}, [registration]);
        expect(load).not.toHaveBeenCalled();
        await feature?.mount(document.createElement('div'), {});
        await feature?.activate();
        await feature?.deactivate();
        await feature?.activate();
        expect(load).toHaveBeenCalledTimes(1);
        expect(mount).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(2);
        expect(deactivate).toHaveBeenCalledTimes(1);
    });
});
