import { mountChatExporterPage } from './ChatExporterPage.js';
import { ChatExporterRuntime } from './runtime.js';

export async function createChatExporterFeature(context) {
    const runtime = new ChatExporterRuntime(context.host, context.logger.scoped({ featureId: 'chat-exporter', source: 'chat-exporter' }));
    await runtime.initialize();
    return {
        mount: (target, props) => mountChatExporterPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
