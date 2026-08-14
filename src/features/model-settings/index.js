import { mountModelSettingsPage } from './ModelSettingsPage.js';
import { ModelSettingsRuntime } from './runtime.js';

export async function createModelSettingsFeature(context) {
    const runtime = new ModelSettingsRuntime(context.host);
    return {
        mount: (target, props) => mountModelSettingsPage(target, { ...props, runtime }),
        activate: async () => undefined,
        deactivate: async () => undefined,
    };
}
