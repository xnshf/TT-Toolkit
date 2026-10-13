import { parseShellSettings, validateEntryMode, validateTheme, DEFAULT_WORKSPACE_SIZE, WORKSPACE_SIZES, defaultMobileWorkspace } from '../kernel/settings.js';
import { errorKind, ToolkitError } from '../kernel/errors.js';
import { mountToolkitApp } from '../ui/main.js';
import { installKeyboardInset } from '../ui/keyboard.js';
import { createThemeBridge } from '../ui/theme-bridge.js';
import { applyThemeDocument } from '../ui/theme.js';

const STYLE_URL = '/scripts/extensions/third-party/TT-Toolkit/style.css';
const SETTINGS_KEY = 'shell-settings-v1';
const TOP_LAYER = '2147483647';
const LAUNCHER_SIZE = 52;
const MIN_FLOATING_WIDTH = 240;
// 给标题栏、两层导航和至少一行完整操作控件留出空间。
const MIN_FLOATING_HEIGHT = 320;

// 手机横屏可能超过 720px；短屏触控设备仍使用手机模式。
const mobileQuery = matchMedia('(max-width: 720px), (pointer: coarse) and (max-height: 720px)');

function mobile() {
  return mobileQuery.matches;
}

function clampPoint(point, width, height, margin = 8, bottomMargin = margin, bounds = { left: 0, top: 0, width: innerWidth, height: innerHeight }) {
  return {
    x: Math.min(Math.max(bounds.left + margin, point.x), Math.max(bounds.left + margin, bounds.left + bounds.width - width - margin)),
    y: Math.min(Math.max(bounds.top + margin, point.y), Math.max(bounds.top + margin, bounds.top + bounds.height - height - bottomMargin)),
  };
}

// Android 使用宿主 --tt-inset-*，iOS 使用 env；只在顶层文档测量。
function measureSafeArea() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;';
  for (const side of ['top', 'right', 'bottom', 'left'])
    probe.style.setProperty(`padding-${side}`, `max(var(--tt-inset-${side}, 0px), env(safe-area-inset-${side}, 0px))`);
  document.documentElement.append(probe);
  const style = getComputedStyle(probe);
  const insets = Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [side, parseFloat(style.getPropertyValue(`padding-${side}`)) || 0]));
  probe.remove();
  return insets;
}

export function draggable(target, handle, read, write, { onClick, onDragEnd, enabled = () => true, bounds } = {}) {
  let active = null;
  const down = event => {
    if (event.button !== 0 || active || !enabled()) return;
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
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = event => {
    if (!active || event.pointerId !== active.id) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (Math.hypot(dx, dy) > 5) active.moved = true;
    if (!active.moved) return;
    const next = clampPoint(
      { x: active.origin.x + dx, y: active.origin.y + dy },
      target.offsetWidth,
      target.offsetHeight,
      8, 8, bounds?.(),
    );
    target.style.left = `${next.x}px`;
    target.style.top = `${next.y}px`;
  };
  const up = event => {
    if (!active || event.pointerId !== active.id) return;
    const moved = active.moved;
    const gesture = {
      dx: event.clientX - active.startX,
      dy: event.clientY - active.startY,
    };
    const id = active.id;
    active = null;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    if (!moved) onClick?.();
    else {
      const rect = target.getBoundingClientRect();
      write({ x: rect.left, y: rect.top });
      onDragEnd?.(gesture);
    }
  };
  const cancel = event => {
    if (!active || event.pointerId !== active.id) return;
    const { id, origin } = active;
    active = null;
    target.style.left = `${origin.x}px`;
    target.style.top = `${origin.y}px`;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', cancel);
  handle.addEventListener('lostpointercapture', cancel);
  return () => {
    handle.removeEventListener('pointerdown', down);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', cancel);
    handle.removeEventListener('lostpointercapture', cancel);
  };
}

function resizable(target, handle, { enabled, bounds, onResizeEnd }) {
  let active = null;
  const apply = (origin, dx, dy) => {
    const frame = bounds();
    const maxWidth = Math.max(0, frame.left + frame.width - origin.left - 8);
    const maxHeight = Math.max(0, frame.top + frame.height - origin.top - 8);
    target.style.width = `${Math.min(maxWidth, Math.max(Math.min(MIN_FLOATING_WIDTH, maxWidth), origin.width + dx))}px`;
    target.style.height = `${Math.min(maxHeight, Math.max(Math.min(MIN_FLOATING_HEIGHT, maxHeight), origin.height + dy))}px`;
  };
  const down = event => {
    if (event.button !== 0 || active || !enabled()) return;
    active = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: target.getBoundingClientRect(), moved: false };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = event => {
    if (!active || event.pointerId !== active.id || !enabled()) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (Math.hypot(dx, dy) > 5) active.moved = true;
    if (active.moved) apply(active.origin, dx, dy);
  };
  const finish = event => {
    if (!active || event.pointerId !== active.id) return;
    const previous = active;
    active = null;
    if (event.type !== 'pointerup' && enabled()) {
      // 取消时恢复原尺寸，但仍遵守期间发生的视口变化。
      apply({ ...target.getBoundingClientRect().toJSON(), width: previous.origin.width, height: previous.origin.height }, 0, 0);
    }
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    if (event.type === 'pointerup' && previous.moved && enabled()) onResizeEnd(target.getBoundingClientRect());
  };
  const keydown = event => {
    const deltas = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
    if (!Object.hasOwn(deltas, event.key) || !enabled()) return;
    event.preventDefault();
    apply(target.getBoundingClientRect(), ...deltas[event.key]);
    onResizeEnd(target.getBoundingClientRect());
  };
  const listeners = { pointerdown: down, pointermove: move, pointerup: finish, pointercancel: finish, lostpointercapture: finish, keydown };
  for (const [type, listener] of Object.entries(listeners)) handle.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of Object.entries(listeners)) handle.removeEventListener(type, listener);
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
  safeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  safeAreaObserver = null;
  handleViewportChange = null;
  themeBridge = null;
  hostScheme = 'dark';
  settingsNotices = [];
  disposeHostKeyboardInset = null;
  disposeFrameKeyboardInset = null;
  disposeLauncherDrag = null;
  disposeWorkspaceDrag = null;
  disposeWorkspaceResize = null;
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
    this.safeInsets = measureSafeArea();
    this.safeBottom = this.safeInsets.bottom;
    this.handleViewportChange = () => this.syncViewport();
    window.addEventListener('resize', this.handleViewportChange);
    this.safeAreaObserver = new MutationObserver(this.handleViewportChange);
    this.safeAreaObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
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
      // 缺少宿主导出属于宿主构建能力缺失，不能引导用户重载宿主。
      const recovery = error?.code === 'HOST_WAND_EXPORT_MISSING'
        ? '当前 TauriTavern 构建不提供魔棒菜单接口，请升级或更换宿主构建后重试。'
        : '请在“设置 / 界面与入口”重试，或重载宿主。';
      this.entryWarning = `魔棒入口暂不可用，已保留悬浮球供你打开工具箱。${recovery}`;
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
      'workspace.mobile.mode': '手机工作台模式包含无法识别的值，已回退为全屏。',
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
        result: 'fallback_applied', recoveryAction: issue.field === 'workspace.mobile.mode'
          ? 'switch_mode_in_titlebar_or_reset_layout' : 'reselect_in_settings_page',
      },
    });
  }

  clearSettingsNotice(field) {
    const messages = {
      'workspace.mobile.mode': '手机工作台模式包含无法识别的值，已回退为全屏。',
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
    // 恢复动作随原因区分：缺少宿主导出只能换宿主构建，重载宿主不会恢复。
    const diagnostics = {
      HOST_WAND_EXPORT_MISSING: { field: 'extensions.ensureExtensionsUiReady/showHideExtensionsMenu', expected: 'function', actualType: 'missing-function', recoveryAction: 'upgrade_or_replace_host_build' },
      HOST_WAND_DOM_MISSING: { field: '#extensionsMenu/#extensionsMenuButton', expected: 'existing-dom-elements', actualType: 'missing-element', recoveryAction: 'retry_settings_or_reload' },
      HOST_WAND_ENTRY_DUPLICATE: { field: '#tt-toolkit-wand-entry', expected: 'absent-before-mount', actualType: 'existing-element', recoveryAction: 'reload_host_then_retry' },
      ENTRY_SETTINGS_SAVE_FAILED: { field: 'shell-settings-v1', expected: 'successful-json-write', actualType: 'failed-write', recoveryAction: 'retry_settings_or_reload' },
    };
    const known = Object.hasOwn(diagnostics, error?.code);
    this.log.warn('entry.failed', { data: {
      operation: 'shell.entry', phase, sourceLocation: 'src/shell/controller.js',
      reasonCode: known ? error.code : 'ENTRY_SETUP_FAILED',
      ...(known ? diagnostics[error.code] : { field: 'entryMode', expected: 'floating|wand|both', actualType: error instanceof Error ? 'Error' : typeof error, recoveryAction: 'retry_settings_or_reload' }),
      result,
      hostAbiVersion: this.host.hostAbiVersion?.() ?? null,
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
    this.safeInsets = measureSafeArea();
    this.safeBottom = this.safeInsets.bottom;
    const root = this.iframe?.contentDocument?.documentElement;
    // iframe 不继承宿主契约；只桥接安全区输入，宽高由 CSS 四边约束。
    for (const [side, value] of Object.entries(this.safeInsets))
      root?.style.setProperty(`--ttk-safe-${side}`, `${value}px`);
    const safe = clampPoint(this.launcherPoint(), LAUNCHER_SIZE, LAUNCHER_SIZE, 8, 8 + this.safeBottom);
    this.launcher?.style.setProperty('left', `${safe.x}px`, 'important');
    this.launcher?.style.setProperty('top', `${safe.y}px`, 'important');
    if (this.workspace && this.overlay.style.display !== 'none')
      this.applyWorkspaceSize();
  }

  async mountWorkbench() {
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
      retryLayoutSave: () => this.saveLayout(),
      setRoute: async route => {
        this.settings.lastRoute = route;
        await this.persist();
      },
      setFeatureEnabled: async (id, value) => this.setFeatureEnabled(id, value),
    });
    this.workspace = frameDocument.querySelector('.workbench');
    if (!this.workspace) throw new Error('工具箱工作台挂载失败');
    this.workspace.style.position = 'fixed';
    const handle = frameDocument.querySelector('[data-drag-handle]');
    if (!handle) throw new Error('工具箱拖动手柄不存在');
    this.disposeWorkspaceDrag = draggable(
      this.workspace,
      handle,
      () => ({ x: this.workspace.offsetLeft, y: this.workspace.offsetTop }),
      pointValue => {
        if (mobile()) this.settings.workspace.mobile.position = pointValue;
        else this.settings.workspace.position = pointValue;
        void this.saveLayout();
      },
      {
        enabled: () => !mobile() || this.settings.workspace.mobile.mode === 'floating',
        bounds: () => this.workspaceBounds(),
      },
    );
    const resizeHandle = frameDocument.querySelector('[data-resize-handle]');
    if (!resizeHandle) throw new Error('工具箱缩放手柄不存在');
    this.disposeWorkspaceResize = resizable(this.workspace, resizeHandle, {
      enabled: () => this.overlay.style.display !== 'none' && mobile() && this.settings.workspace.mobile.mode === 'floating',
      bounds: () => this.workspaceBounds(),
      onResizeEnd: rect => {
        this.settings.workspace.mobile.position = { x: rect.left, y: rect.top };
        this.settings.workspace.mobile.size = { width: rect.width, height: rect.height };
        void this.saveLayout();
      },
    });
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
    // display:none 下尺寸为零；必须先显示，再读取 iframe 与窗口的实际尺寸。
    this.overlay.style.setProperty('display', 'block', 'important');
    this.syncViewport();
    this.iframe?.contentWindow?.focus();
  }

  closeWorkbench() {
    this.overlay.style.setProperty('display', 'none', 'important');
    const target = this.launcher.style.display === 'none'
      ? this.wandEntry?.focusTarget
      : (this.returnFocus?.isConnected ? this.returnFocus : this.launcherButton);
    target?.focus({ preventScroll: true });
  }

  workspaceBounds() {
    const view = this.workspace.ownerDocument.defaultView;
    const { top, right, bottom, left } = this.safeInsets;
    return { left, top, width: Math.max(0, view.innerWidth - left - right), height: Math.max(0, view.innerHeight - top - bottom) };
  }

  applyWorkspaceSize() {
    const isMobile = mobile();
    const fullscreen = isMobile && this.settings.workspace.mobile.mode === 'fullscreen';
    this.workspace.classList.toggle('is-fullscreen', fullscreen);
    this.workspace.setAttribute('data-tt-mobile-surface', fullscreen ? 'fullscreen-window' : 'free-window');
    this.app?.updateLayout({ mobile: isMobile, fullscreen });
    if (fullscreen) {
      // 不计算全屏宽高：清除悬浮几何，由 CSS inset 消费四边安全区。
      for (const property of ['width', 'height', 'left', 'top']) this.workspace.style.removeProperty(property);
      return;
    }
    const bounds = this.workspaceBounds();
    const margin = isMobile ? 8 : 12;
    const sizes = {
      compact: { width: 720, height: 560 },
      standard: { width: 900, height: 680 },
      maximized: { width: bounds.width - 24, height: bounds.height - 24 },
    };
    const selected = isMobile
      ? this.settings.workspace.mobile.size ?? {
        width: Math.min(560, Math.max(MIN_FLOATING_WIDTH, bounds.width * 0.75)),
        height: Math.max(MIN_FLOATING_HEIGHT, bounds.height * 0.75),
      }
      : sizes[this.settings.workspace.size];
    this.workspace.style.width = `${Math.max(0, Math.min(Math.max(isMobile ? MIN_FLOATING_WIDTH : 0, selected.width), bounds.width - margin * 2))}px`;
    this.workspace.style.height = `${Math.max(0, Math.min(Math.max(isMobile ? MIN_FLOATING_HEIGHT : 0, selected.height), bounds.height - margin * 2))}px`;
    const remembered = isMobile ? this.settings.workspace.mobile.position : this.settings.workspace.position;
    const centered = {
      x: bounds.left + (bounds.width - this.workspace.offsetWidth) / 2,
      y: bounds.top + (bounds.height - this.workspace.offsetHeight) / 2,
    };
    const point = clampPoint(remembered ?? centered, this.workspace.offsetWidth, this.workspace.offsetHeight, 8, 8, bounds);
    this.workspace.style.left = `${point.x}px`;
    this.workspace.style.top = `${point.y}px`;
  }

  cycleSize() {
    if (mobile()) {
      const layout = this.settings.workspace.mobile;
      layout.mode = layout.mode === 'fullscreen' ? 'floating' : 'fullscreen';
      this.clearSettingsNotice('workspace.mobile.mode');
    } else {
      const index = WORKSPACE_SIZES.indexOf(this.settings.workspace.size);
      this.settings.workspace.size = WORKSPACE_SIZES[(index + 1) % WORKSPACE_SIZES.length] ?? DEFAULT_WORKSPACE_SIZE;
      this.clearSettingsNotice('workspace.size');
    }
    this.applyWorkspaceSize();
    void this.saveLayout();
  }

  async saveLayout() {
    try {
      await this.persist();
      this.app?.setLayoutWarning('');
    } catch (error) {
      this.log.warn('layout.save_failed', { data: {
        operation: 'shell.saveLayout', phase: 'persist', sourceLocation: 'src/shell/controller.js',
        reasonCode: 'LAYOUT_SETTINGS_SAVE_FAILED', field: SETTINGS_KEY, expected: 'successful-json-write',
        actualType: error instanceof Error ? 'Error' : typeof error,
        result: 'layout_applied_not_saved', recoveryAction: 'retry_layout_save',
      } });
      this.app?.setLayoutWarning('布局已在当前窗口应用，但保存失败，重启后可能恢复旧布局。');
    }
  }

  dispose() {
    window.removeEventListener('resize', this.handleViewportChange);
    this.safeAreaObserver?.disconnect();
    this.disposeHostKeyboardInset?.();
    this.disposeHostKeyboardInset = null;
    this.disposeFrameKeyboardInset?.();
    this.disposeFrameKeyboardInset = null;
    this.disposeLauncherDrag?.();
    this.disposeWorkspaceDrag?.();
    this.disposeWorkspaceResize?.();
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
    this.settings.workspace = { position: null, size: DEFAULT_WORKSPACE_SIZE, mobile: defaultMobileWorkspace() };
    this.clearSettingsNotice('workspace.size');
    const safe = clampPoint(this.launcherPoint(), LAUNCHER_SIZE, LAUNCHER_SIZE, 8, 8 + this.safeBottom);
    this.launcher.style.setProperty('left', `${safe.x}px`, 'important');
    this.launcher.style.setProperty('top', `${safe.y}px`, 'important');
    this.clearSettingsNotice('workspace.mobile.mode');
    if (this.overlay.style.display !== 'none') this.applyWorkspaceSize();
    void this.saveLayout();
  }
}
