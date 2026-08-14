import { TauriTavernHost } from './kernel/host.js';
import { resolveFeatures } from './kernel/features.js';
import { errorMessage } from './kernel/errors.js';
import { featureRegistrations } from './features/registry.js';
import { ShellController } from './shell/controller.js';
import { ToolkitLogger } from './kernel/logging/logger.js';
let bootstrapLog = null;
async function bootstrap() {
    const host = new TauriTavernHost();
    await host.initialize();
    const logger = new ToolkitLogger(host);
    await logger.initialize();
    bootstrapLog = logger.scoped({ featureId: 'system', source: 'bootstrap' });
    host.setLogger(logger.scoped({ featureId: 'system', source: 'host' }));
    const featureCatalog = featureRegistrations.map(({ id, label }) => ({ id, label }));
    const features = resolveFeatures({ host, logger, featureCatalog }, featureRegistrations);
    const shell = new ShellController(host, features, logger);
    await shell.initialize();
    bootstrapLog.info('completed');
}
void bootstrap().catch(error => {
    bootstrapLog?.error('failed', { data: { kind: error instanceof Error ? error.name : typeof error }, sensitive: { error } });
    console.error('[TT-Toolkit] Initialization failed', error);
    const message = document.createElement('div');
    message.className = 'ttk-fatal';
    message.textContent = `TT-Toolkit 初始化失败：${errorMessage(error)}`;
    document.body.append(message);
});
