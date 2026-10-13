import { ToolkitError } from './errors.js';
export const ENTRY_MODES = Object.freeze(['floating', 'wand', 'both']);

// 主题 id 契约由内核持有；ui/theme.js 只负责标签、说明与配色方案。
// 顺序：暗色在前、亮色在后，供设置页按“暗上亮下”排列。
export const HOST_THEME_ID = 'host';
export const DEFAULT_ENTRY_MODE = 'floating';
export const DEFAULT_WORKSPACE_SIZE = 'standard';
export const THEME_IDS = Object.freeze([
    HOST_THEME_ID, 'slate', 'midnight', 'mocha',
    'dawn', 'blossom', 'latte', 'parchment',
]);
export const WORKSPACE_SIZES = Object.freeze(['compact', DEFAULT_WORKSPACE_SIZE, 'maximized']);
export const MOBILE_WORKSPACE_MODES = Object.freeze(['fullscreen', 'floating']);

export function defaultMobileWorkspace() {
    return { mode: 'fullscreen', position: null, size: null };
}

function mobileWorkspace(value, onIssue) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['mode,position', 'mode,position,size'].includes(Object.keys(value).sort().join(',')))
        throw new ToolkitError('INVALID_SCHEMA', '手机工作台布局必须包含 mode/position，可附带 size');
    let mode = value.mode;
    if (!MOBILE_WORKSPACE_MODES.includes(mode)) {
        onIssue?.({ field: 'workspace.mobile.mode', expected: MOBILE_WORKSPACE_MODES.join('|'), actualType: typeof mode, fallback: 'fullscreen' });
        mode = 'fullscreen';
    }
    return {
        mode, position: point(value.position),
        // 已发布的手机布局没有 size：仅对这个已知旧结构补齐。
        size: Object.hasOwn(value, 'size') ? workspaceDimensions(value.size) : null,
    };
}

function workspaceDimensions(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'height,width'
        || ![value.width, value.height].every(number => typeof number === 'number' && Number.isFinite(number) && number > 0))
        throw new ToolkitError('INVALID_SCHEMA', '工作台尺寸必须包含有限正数 width/height，或为 null');
    return { width: value.width, height: value.height };
}

// 主题与入口方式都是“外观/布局枚举”，取值异常只影响观感。
// 解析持久化设置时用 resolve* 回退到安全默认并上报，不阻断工具箱启动；
// 显式 setter 仍用 validate* 抛错，因为那属于调用方 bug，应当立即暴露。
export function validateTheme(value) {
    if (!THEME_IDS.includes(value))
        throw new ToolkitError('INVALID_SCHEMA', '主题必须是已注册的主题之一。');
    return value;
}

export function resolveTheme(value, onIssue) {
    if (THEME_IDS.includes(value))
        return value;
    onIssue?.({ field: 'theme', expected: THEME_IDS.join('|'), actualType: typeof value, fallback: HOST_THEME_ID });
    return HOST_THEME_ID;
}

export function resolveEntryMode(value, onIssue) {
    if (ENTRY_MODES.includes(value))
        return value;
    onIssue?.({ field: 'entryMode', expected: ENTRY_MODES.join('|'), actualType: typeof value, fallback: DEFAULT_ENTRY_MODE });
    return DEFAULT_ENTRY_MODE;
}

export function resolveWorkspaceSize(value, onIssue) {
    if (WORKSPACE_SIZES.includes(value))
        return value;
    onIssue?.({ field: 'workspace.size', expected: WORKSPACE_SIZES.join('|'), actualType: typeof value, fallback: DEFAULT_WORKSPACE_SIZE });
    return DEFAULT_WORKSPACE_SIZE;
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
        entryMode: DEFAULT_ENTRY_MODE,
        theme: HOST_THEME_ID,
        launcher: { desktop: null, mobile: null },
        workspace: { position: null, size: DEFAULT_WORKSPACE_SIZE, mobile: defaultMobileWorkspace() },
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
export function parseShellSettings(value, onIssue) {
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
    return {
        schemaVersion: 1,
        enabledFeatures,
        lastRoute: raw.lastRoute,
        // 旧版 v1 未存储 entryMode / theme：显式补齐原行为。
        // 取值异常只影响观感，回退到安全默认并通过 onIssue 上报，不阻断启动。
        entryMode: Object.hasOwn(raw, 'entryMode') ? resolveEntryMode(raw.entryMode, onIssue) : DEFAULT_ENTRY_MODE,
        theme: Object.hasOwn(raw, 'theme') ? resolveTheme(raw.theme, onIssue) : HOST_THEME_ID,
        launcher: { desktop: point(launcher.desktop), mobile: point(launcher.mobile) },
        workspace: {
            position: point(workspace.position), size: resolveWorkspaceSize(workspace.size, onIssue),
            // 已知旧 v1 没有手机布局：不继承桌面坐标，显式从全屏开始。
            mobile: Object.hasOwn(workspace, 'mobile') ? mobileWorkspace(workspace.mobile, onIssue) : defaultMobileWorkspace(),
        },
    };
}
