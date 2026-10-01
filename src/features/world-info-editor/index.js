import { mountWorldInfoEditorPage } from './WorldInfoEditorPage.js';
import { WorldInfoEditorRuntime } from './runtime.js';

export async function createWorldInfoEditorFeature(context) {
    const log = context.logger.scoped({ featureId: 'world-info-editor', source: 'world-info-editor' });
    const runtime = new WorldInfoEditorRuntime(context.host, log);

    return {
        mount: (target, props) => mountWorldInfoEditorPage(target, { ...props, runtime }),
        activate: () => runtime.init(),
        deactivate: () => runtime.flush(),
    };
}
