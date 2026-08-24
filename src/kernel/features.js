import { errorKind } from './errors.js';
export function resolveFeatures(context, registrations) {
    const featureLog = context.logger?.scoped({ featureId: 'system', source: 'feature-loader' });
    return registrations.map(registration => {
        let loaded = null;
        const load = () => {
            loaded ??= registration.load(context).catch(error => {
                loaded = null;
                featureLog?.error('feature.load_failed', {
                    data: { featureId: registration.id, operation: 'feature.load', ...errorKind(error) },
                    sensitive: { error },
                });
                throw error;
            });
            return loaded;
        };
        return {
            id: registration.id,
            category: registration.category,
            label: registration.label,
            description: registration.description,
            icon: registration.icon,
            order: registration.order,
            defaultEnabled: registration.defaultEnabled ?? false,
            activationPhase: registration.activationPhase ?? 'normal',
            mount: async (target, props) => {
                const implementation = await load();
                try {
                    return await implementation.mount(target, props);
                }
                catch (error) {
                    featureLog?.error('feature.load_failed', {
                        data: { featureId: registration.id, operation: 'feature.mount', ...errorKind(error) },
                        sensitive: { error },
                    });
                    throw error;
                }
            },
            activate: async () => (await load()).activate(),
            deactivate: async () => {
                if (loaded)
                    await (await loaded).deactivate();
            },
        };
    });
}
