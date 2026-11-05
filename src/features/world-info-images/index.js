import { mountWorldInfoImagesPage } from './page.js';
import { WorldInfoImagesRuntime } from './runtime.js';

export async function createWorldInfoImagesFeature(context) {
    const log = context.logger.scoped({ featureId: 'world-info-images', source: 'world-info-images' });
    const runtime = new WorldInfoImagesRuntime(context.host, log);
    return {
        mount: (target, props) => mountWorldInfoImagesPage(target, { ...props, runtime }),
        activate: () => runtime.activate(),
        deactivate: () => runtime.deactivate(),
    };
}
