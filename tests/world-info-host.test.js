import { describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';

describe('host macro processing', () => {
    it('expands retained host macros and falls back to the raw text on failure', () => {
        const host = new TauriTavernHost();
        host.log = { warn: vi.fn() };
        host.scriptModule = { substituteParams: text => String(text).replaceAll('{{user}}', '小明') };
        expect(host.macroProcess('与 {{user}} 独处时')).toBe('与 小明 独处时');
        expect(host.macroProcess('无宏')).toBe('无宏');

        host.scriptModule = { substituteParams: () => { throw new Error('bad macro'); } };
        expect(host.macroProcess('与 {{user}} 独处时')).toBe('与 {{user}} 独处时');
        expect(host.log.warn).toHaveBeenCalledWith('host.macro_process_failed', expect.objectContaining({ data: { kind: 'Error' } }));
    });
});

describe('active world info bindings', () => {
    it('matches the host precedence and identifies global, character, chat and persona sources', () => {
        const host = new TauriTavernHost();
        host.contextModule = {
            getContext: () => ({
                chat: [],
                chatMetadata: { world_info: 'Chat' },
                powerUserSettings: { persona_description_lorebook: 'Persona' },
                characterId: 0,
                characters: [{ avatar: 'alice.png', data: { extensions: { world: 'Shared' } } }],
            }),
        };
        host.worldInfoModule = {
            selected_world_info: ['Shared', 'Global'],
            world_info: { charLore: [{ name: 'alice', extraBooks: ['Character', 'Chat'] }] },
        };

        expect(host.activeWorldInfoBindings()).toEqual([
            { name: 'Shared', source: 'global' },
            { name: 'Global', source: 'global' },
            { name: 'Chat', source: 'chat' },
            { name: 'Persona', source: 'persona' },
            { name: 'Character', source: 'character' },
        ]);
        expect(host.activeWorldInfoNames()).toEqual(['Shared', 'Global', 'Chat', 'Persona', 'Character']);
    });
});
