import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadToolkitVersion } from '../src/version.js';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

describe('single manifest version source', () => {
    it('reads the root install manifest without caching and returns its actual version', async () => {
        const fetchManifest = vi.fn(async () => ({ ok: true, json: async () => manifest }));
        expect(await loadToolkitVersion(fetchManifest)).toBe(manifest.version);
        const [url, options] = fetchManifest.mock.calls[0];
        expect(url.pathname.endsWith('/manifest.json')).toBe(true);
        expect(url.pathname).not.toContain('/src/manifest.json');
        expect(options).toEqual({ cache: 'no-store' });
        expect(fetchManifest).toHaveBeenCalledOnce();
    });
    it('rejects transport and HTTP failures with a safe installation recovery message', async () => {
        for (const fetchManifest of [
            vi.fn().mockRejectedValue(new Error('private details')),
            vi.fn().mockResolvedValue({ ok: false, status: 404 }),
            vi.fn().mockResolvedValue(undefined),
        ]) {
            await expect(loadToolkitVersion(fetchManifest)).rejects.toMatchObject({ code: 'VERSION_MANIFEST_UNAVAILABLE' });
            await expect(loadToolkitVersion(fetchManifest)).rejects.not.toThrow('private details');
        }
    });
    it('rejects damaged JSON and missing or invalid versions rather than using a hardcoded fallback', async () => {
        await expect(loadToolkitVersion(async () => ({ ok: true, json: async () => { throw new Error('private body'); } })))
            .rejects.toMatchObject({ code: 'VERSION_MANIFEST_INVALID' });
        for (const value of [null, [], {}, { version: '' }, { version: 1 }, { version: 'invalid' }, { version: '01.2.3' }]) {
            await expect(loadToolkitVersion(async () => ({ ok: true, json: async () => value })))
                .rejects.toMatchObject({ code: 'VERSION_MANIFEST_INVALID' });
        }
    });
});
