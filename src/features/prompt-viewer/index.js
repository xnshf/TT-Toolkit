import { mountPromptViewerPage } from './PromptViewerPage.js';
import { PromptViewerRuntime } from './runtime.js';

export async function createPromptViewerFeature(context) {
    const runtime = new PromptViewerRuntime(
        context.host,
        context.logger.scoped({ featureId: 'prompt-viewer', source: 'prompt-viewer' }),
    );
    await runtime.initialize();
    return {
        mount: (target, props) => mountPromptViewerPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
