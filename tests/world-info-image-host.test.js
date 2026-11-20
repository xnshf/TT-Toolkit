import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TauriTavernHost } from '../src/kernel/host.js';

function makeHost(openAiModule = null) {
    const host = new TauriTavernHost();
    host.log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    host.openAiModule = openAiModule;
    return host;
}

function fakeMessageModule({ attached = true } = {}) {
    class Message {
        constructor(role, content, identifier) {
            this.role = role;
            this.content = content;
            this.identifier = identifier;
            this.tokens = 7;
        }
        static async createAsync(role, content, identifier) {
            return new Message(role, content, identifier);
        }
        async addImage(image) {
            this.content = [{ type: 'text', text: this.content }];
            if (attached)
                this.content.push({ type: 'image_url', image_url: { url: image } });
        }
        getTokens() { return this.tokens + (attached ? 85 : 0); }
    }
    class MessageCollection {
        constructor(identifier, ...items) { this.identifier = identifier; this.items = items; }
        getChat() {
            return this.items.map(item => ({ role: item.role, content: item.content }));
        }
    }
    return { Message, MessageCollection };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('host world info image message', () => {
    it('builds a host-format user message with the image attached', async () => {
        const host = makeHost(fakeMessageModule());
        const built = await host.buildWorldInfoImageMessage({
            text: '[世界书图片: 圣殿]',
            images: ['data:image/png;base64,AAAA'],
            identifier: 'worldInfoImage_1',
        });
        expect(built.attachedCount).toBe(1);
        expect(built.tokens).toBe(92);
        expect(built.chatMessage.role).toBe('user');
        expect(built.chatMessage.content[0]).toEqual({ type: 'text', text: '[世界书图片: 圣殿]' });
        expect(built.chatMessage.content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    });

    it('reports nothing attached when the host helper drops the image', async () => {
        const host = makeHost(fakeMessageModule({ attached: false }));
        const built = await host.buildWorldInfoImageMessage({
            text: 'x',
            images: ['data:image/png;base64,AAAA'],
            identifier: 'worldInfoImage_1',
        });
        expect(built).toBeNull();
    });

    it('rejects non-data-url input and missing exports instead of guessing', async () => {
        const host = makeHost(fakeMessageModule());
        await expect(host.buildWorldInfoImageMessage({ text: 'x', images: ['https://example.com/a.png'] }))
            .resolves.toBeNull();
        const broken = makeHost({});
        await expect(broken.buildWorldInfoImageMessage({ text: 'x', images: ['data:image/png;base64,AAAA'] }))
            .rejects.toMatchObject({ code: 'HOST_EXPORT_MISSING' });
    });

    it('does not silently use normal registration when the host cannot register a first listener', () => {
        const host = makeHost();
        const on = vi.fn();
        host.contextModule = { getContext: () => ({
            chat: [],
            eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'ready' },
            eventSource: { on, removeListener: vi.fn() },
        }) };
        expect(() => host.onHostEvent('CHAT_COMPLETION_PROMPT_READY', vi.fn(), { first: true }))
            .toThrow(expect.objectContaining({ code: 'HOST_EVENT_MISSING' }));
        expect(on).not.toHaveBeenCalled();
    });
});
