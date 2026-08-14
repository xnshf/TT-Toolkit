import { mountWorldInfoAiPage } from './WorldInfoAiPage.js';
import { WorldInfoAiRuntime } from './runtime.js';

export async function createWorldInfoAiFeature(context) {
    const log = context.logger.scoped({ featureId: 'world-info-ai', source: 'world-info-ai' });
    const runtime = new WorldInfoAiRuntime(context.host, log, {
        taskLog: context.logger.scoped({ featureId: 'world-info-ai', source: 'llm-tasks' }),
    });
    return {
        mount: (target, props) => mountWorldInfoAiPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
