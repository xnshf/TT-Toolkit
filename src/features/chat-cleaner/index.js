import { mountChatCleanerPage } from './ChatCleanerPage.js';
import { ChatCleanerRuntime } from './runtime.js';
export async function createChatCleanerFeature(context) {
    const runtime = new ChatCleanerRuntime(context.host, context.logger.scoped({ featureId: 'chat-cleaner', source: 'chat-cleaner' }));
    await runtime.initialize();
    return {
        mount: (target, props) => mountChatCleanerPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
