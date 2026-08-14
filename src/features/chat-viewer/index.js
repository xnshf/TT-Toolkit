import { mountChatViewerPage } from './ChatViewerPage.js';
import { ChatViewerRuntime } from './runtime.js';

export async function createChatViewerFeature(context) {
    const runtime = new ChatViewerRuntime(context.host, context.logger.scoped({ featureId: 'chat-viewer', source: 'chat-viewer' }));
    return {
        mount: (target, props) => mountChatViewerPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
