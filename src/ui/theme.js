import { HOST_THEME_ID, THEME_IDS } from '../kernel/settings.js';

// 主题展示元数据。id 契约在 kernel/settings.js，颜色在 ui/tokens.css。
// 除“跟随宿主”外，调色板均取自 daisyUI 内置主题（见 docs/theme-provenance.md）。
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
        id: 'dawn',
        label: '朝霞',
        scheme: 'light',
        description: '暖奶油底与陶土粉强调色，偏暖的亮色主题。',
    },
    {
        id: 'blossom',
        label: '樱雪',
        scheme: 'light',
        description: '粉白底与薄荷强调色，柔和的亮色主题。',
    },
    {
        id: 'latte',
        label: '拿铁',
        scheme: 'light',
        description: '奶油底与黑色强调色，对比干脆的亮色主题。',
    },
    {
        id: 'slate',
        label: '青灰',
        scheme: 'dark',
        description: '蓝灰底与柔绿强调色，对比不刺眼的暗色主题。',
    },
    {
        id: 'midnight',
        label: '午夜',
        scheme: 'dark',
        description: '藏青底与亮蓝强调色，经典工具软件观感。',
    },
    {
        id: 'mocha',
        label: '摩卡',
        scheme: 'dark',
        description: '紫褐底与金棕正文，暗色里最偏暖的一套。',
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
