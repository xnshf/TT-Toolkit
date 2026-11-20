import { h } from '../../ui/dom.js';

export const LEVELS = ['debug', 'info', 'warn', 'error'];

function option(value, text) {
    return h('option', { value, text });
}

export function createSettingsForm({ draft, maxMiB, onEdit }) {
    const privacy = h('select', { dataset: { control: 'privacy' } },
        option('redacted', '脱敏'), option('full', '完整（不脱敏）'),
    );
    const minimum = h('select', { dataset: { control: 'minimum-level' }, ariaLabel: '最低记录级别' }, LEVELS.map(level => option(level, level)));
    const consoleLevel = h('select', { dataset: { control: 'console-level' }, ariaLabel: 'console 同步级别' }, ['off', ...LEVELS].map(level => option(level, level)));
    const max = h('input', { type: 'number', min: 1, max: 200, step: 1, dataset: { control: 'max-mib' }, ariaLabel: '容量上限（MiB）' });
    privacy.addEventListener('change', () => onEdit({ privacyMode: privacy.value }));
    minimum.addEventListener('change', () => onEdit({ minimumLevel: minimum.value }));
    consoleLevel.addEventListener('change', () => onEdit({ consoleLevel: consoleLevel.value }));
    max.addEventListener('input', () => onEdit({}, Number(max.value)));

    function apply(settings, capacity) {
        privacy.value = settings.privacyMode;
        minimum.value = settings.minimumLevel;
        consoleLevel.value = settings.consoleLevel;
        max.value = String(capacity);
    }
    apply(draft, maxMiB);
    return {
        element: h('div', { className: 'log-settings-grid' },
            h('label', {}, '隐私模式', privacy),
            h('label', {}, '最低记录级别', minimum),
            h('label', {}, 'console 同步', consoleLevel),
            h('label', {}, '容量上限（MiB）', max),
        ),
        apply,
    };
}
