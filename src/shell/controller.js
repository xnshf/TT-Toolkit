import { parseShellSettings } from '../kernel/settings.js';
import { mountToolkitApp } from '../ui/main.js';

const STYLE_URL = '/scripts/extensions/third-party/TT-Toolkit/style.css';
const SETTINGS_KEY = 'shell-settings-v1';
const TOP_LAYER = '2147483647';

function mobile() {
  return matchMedia('(max-width: 720px)').matches;
}

function clampPoint(point, width, height) {
  const margin = 8;
  return {
    x: Math.min(Math.max(margin, point.x), Math.max(margin, innerWidth - width - margin)),
    y: Math.min(Math.max(margin, point.y), Math.max(margin, innerHeight - height - margin)),
  };
}

export function draggable(target, handle, read, write, onClick) {
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
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = event => {
    if (!active || event.pointerId !== active.id) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (Math.hypot(dx, dy) > 5) active.moved = true;
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
    active = null;
    const rect = target.getBoundingClientRect();
    write({ x: rect.left, y: rect.top });
    if (!moved) onClick?.();
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
  overlay;
  iframe;
  workspace;
  disposeLauncherDrag = null;
  disposeWorkspaceDrag = null;
  log;

  constructor(host, features, logger) {
    this.host = host;
    this.features = features;
    this.log = logger.scoped({ featureId: 'system', source: 'shell' });
  }

  async initialize() {
    this.settings = parseShellSettings(await this.host.globalGet(SETTINGS_KEY));
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
        data: { featureId: feature.id },
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

  mountLauncher() {
    const root = document.createElement('div');
    root.id = 'tt-toolkit-launcher-root';
    root.setAttribute('data-tt-mobile-surface', 'free-window');
    forceTopLayer(root);
    const point = (mobile() ? this.settings.launcher.mobile : this.settings.launcher.desktop)
      ?? { x: 18, y: Math.max(80, innerHeight * 0.55) };
    const safe = clampPoint(point, 52, 52);
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
    this.disposeLauncherDrag = draggable(
      root,
      button,
      () => ({ x: root.offsetLeft, y: root.offsetTop }),
      pointValue => {
        if (mobile()) this.settings.launcher.mobile = pointValue;
        else this.settings.launcher.desktop = pointValue;
        void this.persist();
      },
      () => this.toggleWorkbench(),
    );
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
    frameDocument.documentElement.style.background = 'transparent';
    frameDocument.body.style.cssText = 'margin:0;width:100vw;height:100dvh;overflow:hidden;background:transparent;';
    const style = frameDocument.createElement('link');
    style.rel = 'stylesheet';
    style.href = STYLE_URL;
    frameDocument.head.append(style);
    const mount = frameDocument.getElementById('tt-toolkit-frame-root');
    if (!mount) throw new Error('工具箱 iframe 挂载点不存在');

    mountToolkitApp(mount, {
      features: this.features,
      enabled: this.enabled,
      initialRoute: this.settings.lastRoute,
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
    );
  }

  async setFeatureEnabled(id, value) {
    const feature = this.features.find(item => item.id === id);
    if (!feature) return;
    if (value) await feature.activate();
    else {
      this.log.info('feature.disabling', { data: { featureId: id } });
      await feature.deactivate();
    }
    this.enabled[id] = value;
    await this.persist();
    this.log.info('feature.toggled', { data: { featureId: id, enabled: value } });
  }

  toggleWorkbench() {
    if (this.overlay.style.display === 'none') this.openWorkbench();
    else this.closeWorkbench();
  }

  openWorkbench() {
    if (mobile()) {
      this.workspace.style.left = '0px';
      this.workspace.style.top = '0px';
    } else {
      const point = clampPoint(
        this.settings.workspace.position ?? { x: (innerWidth - 900) / 2, y: (innerHeight - 680) / 2 },
        this.workspace.offsetWidth || 900,
        this.workspace.offsetHeight || 680,
      );
      this.workspace.style.left = `${point.x}px`;
      this.workspace.style.top = `${point.y}px`;
    }
    this.overlay.style.setProperty('display', 'block', 'important');
  }

  closeWorkbench() {
    this.overlay.style.setProperty('display', 'none', 'important');
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
    const options = ['compact', 'standard', 'maximized'];
    const index = options.indexOf(this.settings.workspace.size);
    this.settings.workspace.size = options[(index + 1) % options.length] ?? 'standard';
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

  resetLayout() {
    this.settings.launcher = { desktop: null, mobile: null };
    this.settings.workspace = { position: null, size: 'standard' };
    this.launcher.style.setProperty('left', '18px', 'important');
    this.launcher.style.setProperty('top', `${Math.max(80, innerHeight * 0.55)}px`, 'important');
    this.applyWorkspaceSize();
    this.workspace.style.left = `${Math.max(12, (innerWidth - this.workspace.offsetWidth) / 2)}px`;
    this.workspace.style.top = `${Math.max(12, (innerHeight - this.workspace.offsetHeight) / 2)}px`;
    void this.persist();
  }
}
