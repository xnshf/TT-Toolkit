import { parseShellSettings, validateEntryMode, validateTheme, DEFAULT_WORKSPACE_SIZE, WORKSPACE_SIZES } from '../kernel/settings.js';
import { errorKind, ToolkitError } from '../kernel/errors.js';
import { mountToolkitApp } from '../ui/main.js';
import { installKeyboardInset } from '../ui/keyboard.js';
import { createThemeBridge } from '../ui/theme-bridge.js';
import { applyThemeDocument } from '../ui/theme.js';

const STYLE_URL = '/scripts/extensions/third-party/TT-Toolkit/style.css';
const SETTINGS_KEY = 'shell-settings-v1';
const TOP_LAYER = '2147483647';
const LAUNCHER_SIZE = 52;

const mobileQuery = matchMedia('(max-width: 720px)');

function mobile() {
  return mobileQuery.matches;
}

function clampPoint(point, width, height, margin = 8, bottomMargin = margin) {
  return {
    x: Math.min(Math.max(margin, point.x), Math.max(margin, innerWidth - width - margin)),
    y: Math.min(Math.max(margin, point.y), Math.max(margin, innerHeight - height - bottomMargin)),
  };
}

// 安全区数值只能从顶层文档可靠测得;iframe 内 env() 不可用,由宿主注入 CSS 变量。
function measureSafeBottom() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;left:0;bottom:0;height:0;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.documentElement.append(probe);
  const value = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return value;
}

export function draggable(target, handle, read, write, { onClick, onDragEnd, sheet, onSheet } = {}) {
  let active = null;
  const down = event => {
    if (event.button !== 0) return;
    const interactive = typeof event.target?.closest === 'function'
      ? event.target.closest('button, input, select, textarea, a')
      : null;
    if (interactive && interactive !== handle) return;
    active = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: read(),
      moved: false,
      sheetMode: Boolean(sheet?.()),
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = event => {
    if (!active || event.pointerId !== active.id) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (Math.hypot(dx, dy) > 5) active.moved = true;
    // 下拉模式:窗口跟手下移预览关闭意图,不受 clamp 限制。
    if (active.sheetMode) {
      target.style.transform = `translateY(${Math.max(0, dy)}px)`;
      return;
    }
    const next = clampPoint(
      { x: active.origin.x + dx, y: active.origin.y + dy },
      target.offsetWidth,
      target.offsetHeight,
    );
    target.style.left = `${next.x}px`;
    target.style.top = `${next.y}px`;
  };
  const up = event => {
    if (!active || event.pointerId !== active.id) return;
    const moved = active.moved;
    const sheetMode = active.sheetMode;
    const gesture = {
      dx: event.clientX - active.startX,
      dy: event.clientY - active.startY,
    };
    active = null;
    if (sheetMode) {
      target.style.transform = '';
      if (gesture.dy > 96) onSheet?.();
      return;
    }
    const rect = target.getBoundingClientRect();
    write({ x: rect.left, y: rect.top });
    if (!moved) onClick?.();
    else onDragEnd?.(gesture);
  };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  return () => {
    handle.removeEventListener('pointerdown', down);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
  };
}

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

export class ShellController {
  settings;
  enabled = {};
  launcher;
  launcherButton;
  wandEntry = null;
  entryWarning = '';
  returnFocus = null;
  overlay;
  iframe;
  workspace;
  safeBottom = 0;
  handleViewportChange = null;
  themeBridge = null;
  hostScheme = 'dark';
  settingsNotices = [];
  disposeHostKeyboardInset = null;
  disposeFrameKeyboardInset = null;
  disposeLauncherDrag = null;
  disposeWorkspaceDrag = null;
  log;

  constructor(host, features, logger, version = '') {
    this.host = host;
    this.features = features;
    this.version = version;
    this.log = logger.scoped({ featureId: 'system', source: 'shell' });
  }

  async initialize() {
    this.settings = parseShellSettings(
      await this.host.globalGet(SETTINGS_KEY),
      issue => this.reportSettingsIssue(issue),
    );
    // 先在宿主文档写入主题，悬浮球随后挂载时就能取到正确令牌。
    // 宿主自身的 color-scheme 不改，避免影响宿主原生控件外观。
    applyThemeDocument(document, this.settings.theme, this.hostScheme, { colorScheme: false });
    this.safeBottom = measureSafeBottom();
    this.handleViewportChange = () => this.syncViewport();
    window.addEventListener('resize', this.handleViewportChange);
    // 软键盘只压缩可视视口：把被遮挡高度发布为 --ttk-keyboard-inset 供工具页避让。
    this.disposeHostKeyboardInset = installKeyboardInset();
    for (const feature of this.features) {
      this.enabled[feature.id] = this.settings.enabledFeatures[feature.id] ?? feature.defaultEnabled;
    }
    for (const feature of this.features) {
      if (feature.activationPhase === 'bootstrap' && this.enabled[feature.id]) {
        await this.activateStartupFeature(feature);
      }
    }
    this.log.info('initializing', {
      data: { featureCount: this.features.length, lastRoute: this.settings.lastRoute },
    });
    this.mountLauncher();
    await this.mountWorkbench();
    try {
      await this.applyEntryMode(this.settings.entryMode);
    } catch (error) {
      this.entryWarning = '魔棒入口暂不可用，已保留悬浮球供你打开工具箱。请在“设置 / 界面与入口”重试，或重载宿主。';
      this.logEntryFailure(error, 'initialize', 'floating_retained');
      this.launcherButton.title = this.entryWarning;
    }
    for (const feature of this.features) {
      if (feature.activationPhase !== 'bootstrap' && this.enabled[feature.id]) {
        await this.activateStartupFeature(feature);
      }
    }
    await this.persist();
    this.log.info('initialized', {
      data: {
        enabledFeatures: Object.entries(this.enabled)
          .filter(([, enabled]) => enabled)
          .map(([id]) => id),
      },
    });
  }

  async activateStartupFeature(feature) {
    try {
      await feature.activate();
      this.log.info('feature.activated', {
        data: { featureId: feature.id, phase: feature.activationPhase },
      });
    } catch (error) {
      this.log.error('feature.activation_failed', {
        data: { featureId: feature.id, operation: 'feature.activate', ...errorKind(error) },
        sensitive: { error },
      });
      console.error(`[TT-Toolkit] Feature ${feature.id} failed to activate`, error);
      this.enabled[feature.id] = false;
    }
  }

  async persist() {
    this.settings.enabledFeatures = { ...this.enabled };
    await this.host.globalSet(SETTINGS_KEY, this.settings);
    this.log.debug('settings.saved', {
      data: { enabledFeatureCount: Object.values(this.enabled).filter(Boolean).length },
    });
  }

  // 持久化设置里的枚举取值异常只影响外观，已由 kernel 回退到安全默认。
  // 这里负责把它变成可定位的 warn 和用户可见提示，不假设异常内容。
  reportSettingsIssue(issue) {
    const messages = {
      theme: '主题设置包含无法识别的值，已回退为“跟随宿主”。请在下方重新选择主题。',
      entryMode: '入口方式设置包含无法识别的值，已回退为“悬浮球”。',
      'workspace.size': '工作台尺寸档位包含无法识别的值，已回退为“标准”。',
    };
    const message = messages[issue.field] ?? '部分界面设置包含无法识别的值，已回退为默认值。';
    if (!this.settingsNotices.includes(message))
      this.settingsNotices.push(message);
    this.log.warn('settings.value_unrecognized', {
      data: {
        operation: 'shell.parseSettings', phase: 'parse', sourceLocation: 'src/kernel/settings.js',
        reasonCode: 'SETTINGS_VALUE_UNRECOGNIZED', field: issue.field, expected: issue.expected,
        actualType: issue.actualType, fallbackUsed: issue.fallback,
        result: 'fallback_applied', recoveryAction: 'reselect_in_settings_page',
      },
    });
  }

  clearSettingsNotice(field) {
    const messages = {
      theme: '主题设置包含无法识别的值，已回退为“跟随宿主”。请在下方重新选择主题。',
      entryMode: '入口方式设置包含无法识别的值，已回退为“悬浮球”。',
      'workspace.size': '工作台尺寸档位包含无法识别的值，已回退为“标准”。',
    };
    const message = messages[field];
    if (!message)
      return;
    const index = this.settingsNotices.indexOf(message);
    if (index >= 0)
      this.settingsNotices.splice(index, 1);
  }

  // 把主题同时写到宿主文档（悬浮球）与工作台 iframe。
  applyTheme(themeId = this.settings.theme) {
    applyThemeDocument(document, themeId, this.hostScheme, { colorScheme: false });
    const frameDocument = this.iframe?.contentDocument;
    if (frameDocument)
      applyThemeDocument(frameDocument, themeId, this.hostScheme);
  }

  // 主题是立即可见且易回退的纯外观选项，选择即保存，不进入草稿保存栏。
  async setTheme(themeId) {
    validateTheme(themeId);
    const previous = this.settings.theme;
    if (themeId === previous)
      return;
    this.settings.theme = themeId;
    try {
      await this.persist();
    }
    catch (error) {
      this.settings.theme = previous;
      this.log.warn('theme.save_failed', {
        data: {
          operation: 'shell.setTheme', phase: 'persist', sourceLocation: 'src/shell/controller.js',
          reasonCode: 'THEME_SETTINGS_SAVE_FAILED', field: 'shell-settings-v1',
          expected: 'successful-json-write', actualType: error instanceof Error ? 'Error' : typeof error,
          result: 'previous_theme_restored', recoveryAction: 'retry_theme_selection',
        },
      });
      throw new ToolkitError('THEME_SETTINGS_SAVE_FAILED', '主题设置保存失败，已恢复原来的主题。');
    }
    this.applyTheme(themeId);
    this.clearSettingsNotice('theme');
    this.log.info('theme.changed', { data: { theme: themeId, result: 'applied' } });
  }

  mountLauncher() {
    const root = document.createElement('div');
    root.id = 'tt-toolkit-launcher-root';
    root.setAttribute('data-tt-mobile-surface', 'free-window');
    forceTopLayer(root);
    const point = this.launcherPoint();
    const safe = clampPoint(point, LAUNCHER_SIZE, LAUNCHER_SIZE, 8, 8 + this.safeBottom);
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
    this.launcher = root;
    this.launcherButton = button;
    this.disposeLauncherDrag = draggable(
      root,
      button,
      () => ({ x: root.offsetLeft, y: root.offsetTop }),
      pointValue => {
        if (mobile()) this.settings.launcher.mobile = pointValue;
        else this.settings.launcher.desktop = pointValue;
        void this.persist();
      },
      { onClick: () => this.toggleWorkbench() },
    );
  }

  logEntryFailure(error, phase, result) {
    const diagnostics = {
      HOST_WAND_EXPORT_MISSING: { field: 'extensions.ensureExtensionsUiReady/showHideExtensionsMenu', expected: 'function', actualType: 'missing-function' },
      HOST_WAND_DOM_MISSING: { field: '#extensionsMenu/#extensionsMenuButton', expected: 'existing-dom-elements', actualType: 'missing-element' },
      HOST_WAND_ENTRY_DUPLICATE: { field: '#tt-toolkit-wand-entry', expected: 'absent-before-mount', actualType: 'existing-element' },
      ENTRY_SETTINGS_SAVE_FAILED: { field: 'shell-settings-v1', expected: 'successful-json-write', actualType: 'failed-write' },
    };
    const diagnostic = Object.hasOwn(diagnostics, error?.code) ? diagnostics[error.code] : null;
    this.log.warn('entry.failed', { data: {
      operation: 'shell.entry', phase, sourceLocation: 'src/shell/controller.js',
      reasonCode: diagnostic ? error.code : 'ENTRY_SETUP_FAILED',
      ...(diagnostic ?? { field: 'entryMode', expected: 'floating|wand|both', actualType: error instanceof Error ? 'Error' : typeof error }), result,
      recoveryAction: 'retry_settings_or_reload',
    } });
  }

  async applyEntryMode(mode, save = false) {
    validateEntryMode(mode);
    let prepared = this.wandEntry;
    if (mode !== 'floating' && !prepared) {
      prepared = await this.host.mountToolkitWandEntry(focusTarget => this.openWorkbench(focusTarget));
    }
    if (save) {
      const previous = this.settings.entryMode;
      this.settings.entryMode = mode;
      try {
        await this.persist();
      } catch {
        this.settings.entryMode = previous;
        if (prepared !== this.wandEntry) prepared?.dispose();
        throw new ToolkitError('ENTRY_SETTINGS_SAVE_FAILED', '入口设置保存失败，原入口已保留。请重试。');
      }
    }
    if (mode === 'floating') {
      this.wandEntry?.dispose();
      this.wandEntry = null;
    } else {
      this.wandEntry = prepared;
    }
    this.launcher.style.setProperty('display', mode === 'wand' ? 'none' : 'block', 'important');
    this.entryWarning = '';
    this.launcherButton.title = '打开 TT-Toolkit';
  }

  async setEntryMode(mode) {
    try {
      await this.applyEntryMode(mode, true);
      this.clearSettingsNotice('entryMode');
      this.log.info('entry.changed', { data: { entryMode: mode, result: 'applied' } });
    } catch (error) {
      this.logEntryFailure(error, 'change', 'previous_entry_retained');
      throw error;
    }
  }

  launcherPoint() {
    return (mobile() ? this.settings.launcher.mobile : this.settings.launcher.desktop)
      ?? { x: 18, y: Math.max(80, innerHeight * 0.55) };
  }

  // 视口变化(旋转、分屏、跨断点):重测安全区,重新约束悬浮球与工作台。
  syncViewport() {
    this.safeBottom = measureSafeBottom();
    this.injectSafeArea();
    const safe = clampPoint(this.launcherPoint(), LAUNCHER_SIZE, LAUNCHER_SIZE, 8, 8 + this.safeBottom);
    this.launcher.style.setProperty('left', `${safe.x}px`, 'important');
    this.launcher.style.setProperty('top', `${safe.y}px`, 'important');
    if (!this.workspace)
      return;
    this.applyWorkspaceSize();
    if (this.overlay.style.display === 'none')
      return;
    const point = clampPoint(
      this.settings.workspace.position ?? { x: (innerWidth - this.workspace.offsetWidth) / 2, y: (innerHeight - this.workspace.offsetHeight) / 2 },
      this.workspace.offsetWidth,
      this.workspace.offsetHeight,
    );
    this.workspace.style.left = `${point.x}px`;
    this.workspace.style.top = `${point.y}px`;
  }

  injectSafeArea() {
    const root = this.iframe?.contentDocument?.documentElement;
    root?.style.setProperty('--ttk-safe-bottom', `${this.safeBottom}px`);
  }

  async mountWorkbench() {
    const overlay = document.createElement('div');
    overlay.id = 'tt-toolkit-overlay';
    overlay.setAttribute('data-tt-mobile-surface', 'fullscreen-window');
    forceTopLayer(overlay);
    overlay.style.setProperty('inset', '0', 'important');
    overlay.style.setProperty('display', 'none', 'important');
    overlay.style.setProperty('width', '100vw', 'important');
    overlay.style.setProperty('height', '100dvh', 'important');
    overlay.style.setProperty('background', 'rgba(0, 0, 0, 0.28)', 'important');

    const iframe = document.createElement('iframe');
    iframe.id = 'tt-toolkit-frame';
    iframe.title = 'TT-Toolkit 工具箱';
    iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent;';
    iframe.srcdoc = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="tt-toolkit-frame-root"></div></body></html>';
    const frameReady = waitForFrame(iframe);
    overlay.append(iframe);
    document.documentElement.append(overlay);
    this.overlay = overlay;
    this.iframe = iframe;

    const frameDocument = await frameReady;
    if (!frameDocument) throw new Error('无法访问工具箱 iframe 文档');
    // 标记工作台文档：tokens/style 里影响整体的规则只在这份文档生效，不泄漏到宿主。
    frameDocument.documentElement.dataset.ttkSurface = 'workbench';
    // iframe 内不宣告 interactive-widget（会与外壳固定高度冲突），只用可视视口高度避让键盘。
    this.disposeFrameKeyboardInset = installKeyboardInset(frameDocument.documentElement);
    frameDocument.documentElement.style.background = 'transparent';
    frameDocument.body.style.cssText = 'margin:0;width:100vw;height:100dvh;overflow:hidden;background:transparent;';
    // 宿主主题令牌不会跨 iframe 继承，由此处桥接到工作台文档根节点。
    this.themeBridge = createThemeBridge(frameDocument, {
      onSchemeChange: scheme => {
        this.hostScheme = scheme;
        this.applyTheme();
      },
    });
    this.hostScheme = this.themeBridge.read().scheme;
    this.applyTheme();
    const style = frameDocument.createElement('link');
    style.rel = 'stylesheet';
    style.href = STYLE_URL;
    frameDocument.head.append(style);
    const mount = frameDocument.getElementById('tt-toolkit-frame-root');
    if (!mount) throw new Error('工具箱 iframe 挂载点不存在');

    this.app = mountToolkitApp(mount, {
      version: this.version,
      features: this.features,
      enabled: this.enabled,
      initialRoute: this.settings.lastRoute,
      entrySettings: {
        getState: () => ({
          mode: this.settings.entryMode,
          warning: this.entryWarning,
          notices: [...this.settingsNotices],
        }),
        setMode: mode => this.setEntryMode(mode),
        resetLayout: () => this.resetLayout(),
      },
      themeSettings: {
        getState: () => ({ theme: this.settings.theme, scheme: this.hostScheme }),
        setTheme: theme => this.setTheme(theme),
      },
      close: () => this.closeWorkbench(),
      cycleSize: () => this.cycleSize(),
      resetLayout: () => this.resetLayout(),
      setRoute: async route => {
        this.settings.lastRoute = route;
        await this.persist();
      },
      setFeatureEnabled: async (id, value) => this.setFeatureEnabled(id, value),
    });
    this.workspace = frameDocument.querySelector('.workbench');
    if (!this.workspace) throw new Error('工具箱工作台挂载失败');
    this.workspace.style.position = 'fixed';
    this.injectSafeArea();
    this.applyWorkspaceSize();
    const handle = frameDocument.querySelector('[data-drag-handle]');
    if (!handle) throw new Error('工具箱拖动手柄不存在');
    const initial = this.settings.workspace.position
      ?? { x: Math.max(12, (innerWidth - 900) / 2), y: Math.max(12, (innerHeight - 680) / 2) };
    const point = clampPoint(initial, this.workspace.offsetWidth || 900, this.workspace.offsetHeight || 680);
    this.workspace.style.left = `${point.x}px`;
    this.workspace.style.top = `${point.y}px`;
    this.disposeWorkspaceDrag = draggable(
      this.workspace,
      handle,
      () => ({ x: this.workspace.offsetLeft, y: this.workspace.offsetTop }),
      pointValue => {
        this.settings.workspace.position = pointValue;
        void this.persist();
      },
      {
        // 移动端近全屏窗口几乎没有移动余量:标题栏下拉跟手预览,明显下拉即关闭。
        sheet: () => mobile(),
        onSheet: () => this.closeWorkbench(),
      },
    );
  }

  async setFeatureEnabled(id, value) {
    const feature = this.features.find(item => item.id === id);
    if (!feature) return;
    try {
      if (value) {
        await feature.activate();
      } else {
        this.log.info('feature.disabling', { data: { featureId: id } });
        await feature.deactivate();
      }
    } catch (error) {
      this.log.error(value ? 'feature.activation_failed' : 'feature.deactivation_failed', {
        data: { featureId: id, operation: value ? 'feature.activate' : 'feature.deactivate', ...errorKind(error) },
        sensitive: { error },
      });
      throw error;
    }
    this.enabled[id] = value;
    await this.persist();
    this.log.info('feature.toggled', { data: { featureId: id, enabled: value } });
  }

  toggleWorkbench() {
    if (this.overlay.style.display === 'none') this.openWorkbench();
    else this.closeWorkbench();
  }

  openWorkbench(focusTarget = this.launcherButton) {
    this.returnFocus = focusTarget;
    // 移动端为近全屏悬浮窗口,与桌面共用记忆位置;clamp 保证不出视口。
    const point = clampPoint(
      this.settings.workspace.position ?? {
        x: (innerWidth - (this.workspace.offsetWidth || 900)) / 2,
        y: (innerHeight - (this.workspace.offsetHeight || 680)) / 2,
      },
      this.workspace.offsetWidth || 900,
      this.workspace.offsetHeight || 680,
    );
    this.workspace.style.left = `${point.x}px`;
    this.workspace.style.top = `${point.y}px`;
    this.overlay.style.setProperty('display', 'block', 'important');
    this.iframe?.contentWindow?.focus();
  }

  closeWorkbench() {
    this.overlay.style.setProperty('display', 'none', 'important');
    const target = this.launcher.style.display === 'none'
      ? this.wandEntry?.focusTarget
      : (this.returnFocus?.isConnected ? this.returnFocus : this.launcherButton);
    target?.focus({ preventScroll: true });
  }

  applyWorkspaceSize() {
    const sizes = {
      compact: { width: 720, height: 560 },
      standard: { width: 900, height: 680 },
      maximized: { width: innerWidth - 24, height: innerHeight - 24 },
    };
    const selected = sizes[this.settings.workspace.size];
    this.workspace.style.width = `${Math.max(320, Math.min(selected.width, innerWidth - 24))}px`;
    this.workspace.style.height = `${Math.max(420, Math.min(selected.height, innerHeight - 24))}px`;
  }

  cycleSize() {
    const index = WORKSPACE_SIZES.indexOf(this.settings.workspace.size);
    this.settings.workspace.size = WORKSPACE_SIZES[(index + 1) % WORKSPACE_SIZES.length] ?? DEFAULT_WORKSPACE_SIZE;
    this.clearSettingsNotice('workspace.size');
    this.applyWorkspaceSize();
    const point = clampPoint(
      { x: this.workspace.offsetLeft, y: this.workspace.offsetTop },
      this.workspace.offsetWidth,
      this.workspace.offsetHeight,
    );
    this.workspace.style.left = `${point.x}px`;
    this.workspace.style.top = `${point.y}px`;
    this.settings.workspace.position = point;
    void this.persist();
  }

  dispose() {
    window.removeEventListener('resize', this.handleViewportChange);
    this.disposeHostKeyboardInset?.();
    this.disposeHostKeyboardInset = null;
    this.disposeFrameKeyboardInset?.();
    this.disposeFrameKeyboardInset = null;
    this.disposeLauncherDrag?.();
    this.disposeWorkspaceDrag?.();
    this.wandEntry?.dispose();
    this.wandEntry = null;
    this.themeBridge?.dispose();
    this.themeBridge = null;
    this.app?.unmount();
    this.launcher?.remove();
    this.overlay?.remove();
  }

  resetLayout() {
    this.settings.launcher = { desktop: null, mobile: null };
    this.settings.workspace = { position: null, size: DEFAULT_WORKSPACE_SIZE };
    this.clearSettingsNotice('workspace.size');
    const safe = clampPoint(this.launcherPoint(), LAUNCHER_SIZE, LAUNCHER_SIZE, 8, 8 + this.safeBottom);
    this.launcher.style.setProperty('left', `${safe.x}px`, 'important');
    this.launcher.style.setProperty('top', `${safe.y}px`, 'important');
    this.applyWorkspaceSize();
    this.workspace.style.left = `${Math.max(12, (innerWidth - this.workspace.offsetWidth) / 2)}px`;
    this.workspace.style.top = `${Math.max(12, (innerHeight - this.workspace.offsetHeight) / 2)}px`;
    void this.persist();
  }
}
