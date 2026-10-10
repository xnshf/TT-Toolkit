import { ToolkitError } from './errors.js';
export const ENTRY_MODES = Object.freeze(['floating', 'wand', 'both']);

// 主题 id 契约由内核持有；ui/theme.js 只负责标签、说明与配色方案。
// 与 ENTRY_MODES 同一模式：内核管 id，界面管展示。
export const HOST_THEME_ID = 'host';
export const THEME_IDS = Object.freeze([HOST_THEME_ID, 'midnight', 'obsidian', 'dusk', 'parchment', 'daylight']);

export function validateTheme(value) {
    if (!THEME_IDS.includes(value))
        throw new ToolkitError('INVALID_SCHEMA', '主题必须是已注册的主题之一。');
    return value;
}

export function validateEntryMode(value) {
    if (!ENTRY_MODES.includes(value))
        throw new ToolkitError('INVALID_SCHEMA', '入口方式必须是悬浮球、魔棒菜单或两者。');
    return value;
}

export function defaultShellSettings() {
    return {
        schemaVersion: 1,
        enabledFeatures: { 'developer-logs': false, 'model-settings': true, 'chat-cleaner': false, 'chat-exporter': false, 'prompt-viewer': false, 'world-info-ai': false, 'world-info-editor': true, 'prompt-conflict': false },
        lastRoute: 'overview',
        entryMode: 'floating',
        theme: HOST_THEME_ID,
        launcher: { desktop: null, mobile: null },
        workspace: { position: null, size: 'standard' },
    };
}
function point(value) {
    if (value === null)
        return null;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '布局位置必须是对象或 null');
    const candidate = value;
    if (Object.keys(candidate).sort().join(',') !== 'x,y' || typeof candidate.x !== 'number' || typeof candidate.y !== 'number' || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
        throw new ToolkitError('INVALID_SCHEMA', '布局位置必须包含有限数值 x/y');
    }
    return { x: candidate.x, y: candidate.y };
}
export function parseShellSettings(value) {
    if (value === undefined || value === null)
        return defaultShellSettings();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolkitError('INVALID_SCHEMA', '工具箱设置必须是对象');
    const raw = value;
    if (raw.schemaVersion !== 1)
        throw new ToolkitError('UNSUPPORTED_SCHEMA', `不支持的工具箱设置版本：${String(raw.schemaVersion)}`);
    if (!raw.enabledFeatures || typeof raw.enabledFeatures !== 'object' || Array.isArray(raw.enabledFeatures))
        throw new ToolkitError('INVALID_SCHEMA', 'enabledFeatures 必须是对象');
    if (!raw.launcher || typeof raw.launcher !== 'object' || Array.isArray(raw.launcher))
        throw new ToolkitError('INVALID_SCHEMA', 'launcher 必须是对象');
    if (!raw.workspace || typeof raw.workspace !== 'object' || Array.isArray(raw.workspace))
        throw new ToolkitError('INVALID_SCHEMA', 'workspace 必须是对象');
    const enabledFeatures = {};
    for (const [id, enabled] of Object.entries(raw.enabledFeatures)) {
        if (typeof enabled !== 'boolean')
            throw new ToolkitError('INVALID_SCHEMA', `功能 ${id} 的启用状态必须是布尔值`);
        enabledFeatures[id] = enabled;
    }
    const launcher = raw.launcher;
    const workspace = raw.workspace;
    if (typeof raw.lastRoute !== 'string')
        throw new ToolkitError('INVALID_SCHEMA', 'lastRoute 必须是字符串');
    if (!['compact', 'standard', 'maximized'].includes(String(workspace.size)))
        throw new ToolkitError('INVALID_SCHEMA', '工作台尺寸档位无效');
    return {
        schemaVersion: 1,
        enabledFeatures,
        lastRoute: raw.lastRoute,
        // 已知旧版 v1 未存储 entryMode：显式补齐原有悬浮球行为，非法值不迁移。
        entryMode: Object.hasOwn(raw, 'entryMode') ? validateEntryMode(raw.entryMode) : 'floating',
        // 同样地，旧版 v1 未存储 theme：补齐为“跟随宿主”。
        theme: Object.hasOwn(raw, 'theme') ? validateTheme(raw.theme) : HOST_THEME_ID,
        launcher: { desktop: point(launcher.desktop), mobile: point(launcher.mobile) },
        workspace: { position: point(workspace.position), size: workspace.size },
    };
}
