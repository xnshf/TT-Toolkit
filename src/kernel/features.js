export function resolveFeatures(context, registrations) {
    return registrations.map(registration => {
        let loaded = null;
        const load = () => {
            loaded ??= registration.load(context).catch(error => {
                loaded = null;
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
            mount: async (target, props) => (await load()).mount(target, props),
            activate: async () => (await load()).activate(),
            deactivate: async () => {
                if (loaded)
                    await (await loaded).deactivate();
            },
        };
    });
}
