import { mountPromptConflictPage } from './page.js';
import { PromptConflictRuntime } from './runtime.js';

export async function createPromptConflictFeature(context) {
    const log = context.logger.scoped({ featureId: 'prompt-conflict', source: 'prompt-conflict' });
    const runtime = new PromptConflictRuntime(context.host, log, {
        taskLog: context.logger.scoped({ featureId: 'prompt-conflict', source: 'llm-tasks' }),
    });
    return {
        mount: (target, props) => mountPromptConflictPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
