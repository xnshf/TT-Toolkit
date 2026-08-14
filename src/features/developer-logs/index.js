import { mountDeveloperLogsPage } from './DeveloperLogsPage.js';
export async function createDeveloperLogsFeature(context) {
    return {
        mount: (target, props) => mountDeveloperLogsPage(target, { ...props, runtime: context.logger, featureCatalog: context.featureCatalog }),
        activate: () => context.logger.start(),
        deactivate: () => context.logger.stop(),
    };
}
