import { HOST_THEME_ID, THEME_IDS } from '../kernel/settings.js';

// 主题展示元数据。id 契约在 kernel/settings.js，颜色在 ui/tokens.css。
// scheme 决定 iframe 内原生控件（下拉列表、滚动条）的配色；
// 'auto' 表示跟随宿主实际明暗，由 theme-bridge 推断。
export const THEMES = Object.freeze([
    {
        id: HOST_THEME_ID,
        label: '跟随宿主',
        scheme: 'auto',
        description: '文字与强调色取自 TauriTavern 当前主题，表面在宿主模糊底色上分层提亮。',
    },
    {
        id: 'midnight',
        label: '午夜',
        scheme: 'dark',
        description: '冷灰蓝深色，适合长时间阅读。',
    },
    {
        id: 'obsidian',
        label: '黑曜',
        scheme: 'dark',
        description: '纯黑表面，适合 OLED 屏幕。',
    },
    {
        id: 'forest',
        label: '深林',
        scheme: 'dark',
        description: '深绿色调表面与祖母绿强调色，与宿主默认主题区分明显。',
    },
    {
        id: 'parchment',
        label: '羊皮纸',
        scheme: 'light',
        description: '暖色浅色，接近纸张阅读感。',
    },
    {
        id: 'daylight',
        label: '白昼',
        scheme: 'light',
        description: '中性浅色，界面最清晰。',
    },
]);

export function themeById(id) {
    return THEMES.find(theme => theme.id === id) ?? THEMES[0];
}

// 把主题写到文档根节点。宿主文档与工作台 iframe 各调用一次。
// hostScheme 只在“跟随宿主”时使用：iframe 不继承宿主的 color-scheme，
// 原生控件必须显式指定。
// colorScheme=false 用于宿主文档：宿主自己声明 color-scheme: only light，
// 从根节点改写会连带改变宿主自身的原生控件外观，属于修改宿主，必须避免。
export function applyThemeDocument(doc, themeId, hostScheme = 'dark', { colorScheme = true } = {}) {
    const theme = themeById(themeId);
    doc.documentElement.dataset.ttkTheme = theme.id;
    if (!colorScheme)
        return;
    doc.documentElement.style.colorScheme = theme.scheme === 'auto' ? hostScheme : theme.scheme;
}

// 开发期一致性断言：注册表必须与内核 id 契约完全对应，避免漏加主题。
// 只报告不抛错：界面元数据不一致不应阻断整个工具箱启动。
if (THEMES.length !== THEME_IDS.length || THEMES.some((theme, index) => theme.id !== THEME_IDS[index])) {
    console.error('[TT-Toolkit] 主题注册表与 kernel/settings.js 的 THEME_IDS 不一致');
}
