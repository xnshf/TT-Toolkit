import { installKeyboardInset } from '../ui/keyboard.js';
import { mountToolkitApp } from '../ui/main.js';
import { createThemeBridge } from '../ui/theme-bridge.js';
import { clampPoint, draggable, resizable } from './pointer.js';
import { mobile } from './viewport.js';

export const STYLE_URL = '/scripts/extensions/third-party/TT-Toolkit/style.css';
const TOP_LAYER = '2147483647';
const LAUNCHER_SIZE = 52;

function forceTopLayer(element) {
  element.style.setProperty('position', 'fixed', 'important');
  element.style.setProperty('z-index', TOP_LAYER, 'important');
  element.style.setProperty('isolation', 'isolate', 'important');
}

function waitForFrame(iframe) {
  return new Promise((resolve, reject) => {
    iframe.addEventListener('load', () => resolve(iframe.contentDocument), { once: true });
    iframe.addEventListener('error', () => reject(new Error('工具箱 iframe 加载失败')), { once: true });
  });
}

// 悬浮球挂在宿主文档，可拖动并记住桌面/手机两套位置。
export function mountLauncher(shell) {
  const root = document.createElement('div');
  root.id = 'tt-toolkit-launcher-root';
  root.setAttribute('data-tt-mobile-surface', 'free-window');
  forceTopLayer(root);
  const point = shell.launcherPoint();
  const safe = clampPoint(point, LAUNCHER_SIZE, LAUNCHER_SIZE, 8, 8 + shell.safeBottom);
  root.style.setProperty('left', `${safe.x}px`, 'important');
  root.style.setProperty('top', `${safe.y}px`, 'important');
  const shadow = root.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_URL;
  shadow.append(link);
  const button = document.createElement('button');
  button.className = 'launcher-button';
  button.type = 'button';
  button.title = '打开 TT-Toolkit';
  button.setAttribute('aria-label', '打开 TT-Toolkit');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16v11H4zM8 4h8v3.5H8zM3 10h18M9 10v2.5h6V10"/></svg>';
  shadow.append(button);
  document.documentElement.append(root);
  shell.launcher = root;
  shell.launcherButton = button;
  shell.disposeLauncherDrag = draggable(
    root,
    button,
    () => ({ x: root.offsetLeft, y: root.offsetTop }),
    pointValue => {
      if (mobile()) shell.settings.launcher.mobile = pointValue;
      else shell.settings.launcher.desktop = pointValue;
      void shell.persist();
    },
    { onClick: () => shell.toggleWorkbench() },
  );
}

// 工作台 overlay 与 iframe：挂到 documentElement 顶层，承载主题桥接、键盘避让与拖拽/缩放。
export async function mountWorkbench(shell) {
  const overlay = document.createElement('div');
  overlay.id = 'tt-toolkit-overlay';
  overlay.setAttribute('data-tt-mobile-surface', 'backdrop');
  forceTopLayer(overlay);
  overlay.style.setProperty('inset', '0', 'important');
  overlay.style.setProperty('display', 'none', 'important');
  overlay.style.setProperty('width', '100vw', 'important');
  overlay.style.setProperty('height', '100dvh', 'important');
  // 遮罩取令牌层；样式表尚未生效时回退到同值，避免工作台背后没有遮罩。
  overlay.style.setProperty('background', 'var(--ttk-workbench-scrim, rgb(0 0 0 / 0.32))', 'important');

  const iframe = document.createElement('iframe');
  iframe.id = 'tt-toolkit-frame';
  iframe.title = 'TT-Toolkit 工具箱';
  iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent;';
  iframe.srcdoc = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="tt-toolkit-frame-root"></div></body></html>';
  const frameReady = waitForFrame(iframe);
  overlay.append(iframe);
  document.documentElement.append(overlay);
  shell.overlay = overlay;
  shell.iframe = iframe;

  const frameDocument = await frameReady;
  if (!frameDocument) throw new Error('无法访问工具箱 iframe 文档');
  // 标记工作台文档：tokens/style 里影响整体的规则只在这份文档生效，不泄漏到宿主。
  frameDocument.documentElement.dataset.ttkSurface = 'workbench';
  // iframe 内不宣告 interactive-widget（会与外壳固定高度冲突），只用可视视口与宿主 IME 高度避让键盘。
  // 悬浮工作台可能整体位于键盘上方：只发布实际被键盘压住的高度，不凭空缩短内容区。
  shell.disposeFrameKeyboardInset = installKeyboardInset(frameDocument.documentElement, {
    limit: inset => {
      const bottom = shell.workspace?.getBoundingClientRect().bottom ?? innerHeight;
      return Math.max(0, Math.min(inset, bottom - (innerHeight - inset)));
    },
  });
  frameDocument.documentElement.style.background = 'transparent';
  frameDocument.body.style.cssText = 'margin:0;width:100vw;height:100dvh;overflow:hidden;background:transparent;';
  // 宿主主题令牌不会跨 iframe 继承，由此处桥接到工作台文档根节点。
  shell.themeBridge = createThemeBridge(frameDocument, {
    onSchemeChange: scheme => {
      shell.hostScheme = scheme;
      shell.applyTheme();
    },
  });
  shell.hostScheme = shell.themeBridge.read().scheme;
  shell.applyTheme();
  const style = frameDocument.createElement('link');
  style.rel = 'stylesheet';
  style.href = STYLE_URL;
  frameDocument.head.append(style);
  const mount = frameDocument.getElementById('tt-toolkit-frame-root');
  if (!mount) throw new Error('工具箱 iframe 挂载点不存在');

  shell.app = mountToolkitApp(mount, {
    version: shell.version,
    features: shell.features,
    enabled: shell.enabled,
    initialRoute: shell.settings.lastRoute,
    entrySettings: {
      getState: () => ({
        mode: shell.settings.entryMode,
        warning: shell.entryWarning,
        notices: [...shell.settingsNotices],
      }),
      setMode: mode => shell.setEntryMode(mode),
      resetLayout: () => shell.resetLayout(),
    },
    themeSettings: {
      getState: () => ({ theme: shell.settings.theme, scheme: shell.hostScheme }),
      setTheme: theme => shell.setTheme(theme),
    },
    close: () => shell.closeWorkbench(),
    cycleSize: () => shell.cycleSize(),
    resetLayout: () => shell.resetLayout(),
    retryLayoutSave: () => shell.saveLayout(),
    setRoute: async route => {
      shell.settings.lastRoute = route;
      await shell.persist();
    },
    setFeatureEnabled: async (id, value) => shell.setFeatureEnabled(id, value),
  });
  shell.workspace = frameDocument.querySelector('.workbench');
  if (!shell.workspace) throw new Error('工具箱工作台挂载失败');
  shell.workspace.style.position = 'fixed';
  const handle = frameDocument.querySelector('[data-drag-handle]');
  if (!handle) throw new Error('工具箱拖动手柄不存在');
  shell.disposeWorkspaceDrag = draggable(
    shell.workspace,
    handle,
    () => ({ x: shell.workspace.offsetLeft, y: shell.workspace.offsetTop }),
    pointValue => {
      if (mobile()) shell.settings.workspace.mobile.position = pointValue;
      else shell.settings.workspace.position = pointValue;
      void shell.saveLayout();
    },
    {
      enabled: () => !mobile() || shell.settings.workspace.mobile.mode === 'floating',
      bounds: () => shell.workspaceBounds(),
    },
  );
  const resizeHandle = frameDocument.querySelector('[data-resize-handle]');
  if (!resizeHandle) throw new Error('工具箱缩放手柄不存在');
  shell.disposeWorkspaceResize = resizable(shell.workspace, resizeHandle, {
    enabled: () => shell.overlay.style.display !== 'none' && mobile() && shell.settings.workspace.mobile.mode === 'floating',
    bounds: () => shell.workspaceBounds(),
    onResizeEnd: rect => {
      shell.settings.workspace.mobile.position = { x: rect.left, y: rect.top };
      shell.settings.workspace.mobile.size = { width: rect.width, height: rect.height };
      void shell.saveLayout();
    },
  });
}
