// 宿主主题桥（阶段 0）
//
// 工作台跑在 iframe 里，宿主文档 :root 上的 --SmartTheme* 令牌不会自动继承过来。
// 这里从宿主文档的 documentElement 计算样式读出真实值，写进目标文档根节点的
// 内联变量，供 ui/tokens.css 的 --ttk-host-* 通道使用。
//
// 在宿主文档自身建立桥时，源与目标相同：CSS 变量本来就能解析，不需要写内联值，
// 但仍会读一次宿主明暗，供“跟随宿主”主题决定原生控件配色。

const BRIDGED_TOKENS = Object.freeze([
    ['--ttk-host-tint', '--SmartThemeBlurTintColor'],
    ['--ttk-host-body', '--SmartThemeBodyColor'],
    ['--ttk-host-muted', '--SmartThemeEmColor'],
    ['--ttk-host-accent', '--SmartThemeQuoteColor'],
    ['--ttk-host-font', '--mainFontFamily'],
    ['--ttk-host-mono', '--monoFontFamily'],
]);

// 宿主自身声明 color-scheme: only light，无法据此判断明暗。
// 改为按宿主模糊底色的相对亮度推断，让 iframe 内的原生控件跟随实际明暗。
function detectScheme(sourceDocument, tint) {
    const rgb = toRgb(sourceDocument, tint);
    if (!rgb)
        return 'dark';
    const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return luminance > 140 ? 'light' : 'dark';
}

// 借用宿主文档把任意合法颜色语法规范化为 rgb()/rgba()，避免自己解析 oklch 等格式。
function toRgb(sourceDocument, value) {
    if (!value)
        return null;
    const probe = sourceDocument.createElement('span');
    probe.style.color = value;
    if (!probe.style.color)
        return null;
    probe.style.display = 'none';
    (sourceDocument.body ?? sourceDocument.documentElement).append(probe);
    const normalized = sourceDocument.defaultView.getComputedStyle(probe).color;
    probe.remove();
    const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(normalized);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function readSource(sourceDocument) {
    const values = {};
    const view = sourceDocument.defaultView;
    if (view) {
        const computed = view.getComputedStyle(sourceDocument.documentElement);
        for (const [target, source] of BRIDGED_TOKENS) {
            const raw = computed.getPropertyValue(source).trim();
            if (raw)
                values[target] = raw;
        }
    }
    return { values, scheme: detectScheme(sourceDocument, values['--ttk-host-tint']) };
}

function resolveSourceDocument(targetDocument, sourceWindow) {
    try {
        if (sourceWindow && sourceWindow !== targetDocument.defaultView)
            return { document: sourceWindow.document, sameAsTarget: false };
    }
    catch {
        // 跨源访问会抛错：保持 CSS 回退值，不阻断工具箱。
        return { document: null, sameAsTarget: false };
    }
    return { document: targetDocument, sameAsTarget: true };
}

/**
 * 建立宿主主题桥。
 * @param {Document} targetDocument 需要被注入令牌的文档（工作台 iframe，或宿主文档自身）。
 * @param {{ sourceWindow?: Window, onSchemeChange?: (scheme: string) => void }} [options]
 * @returns {{ read: () => { values: Record<string, string>, scheme: string }, sync: () => void, dispose: () => void }}
 */
export function createThemeBridge(targetDocument, options = {}) {
    const requestedSource = options.sourceWindow
        ?? (targetDocument.defaultView ? targetDocument.defaultView.parent ?? undefined : undefined);
    const resolved = resolveSourceDocument(targetDocument, requestedSource);
    const sourceDocument = resolved.document;
    const sameAsTarget = resolved.sameAsTarget;

    let latest = sourceDocument ? readSource(sourceDocument) : { values: {}, scheme: 'dark' };
    let observer = null;
    let eventSource = null;
    let frame = 0;
    let disposed = false;

    const publish = () => {
        if (disposed)
            return;
        const previousScheme = latest.scheme;
        latest = sourceDocument ? readSource(sourceDocument) : { values: {}, scheme: 'dark' };
        // 源与目标相同时变量本就能解析，写内联值只会污染宿主根节点。
        if (sourceDocument && !sameAsTarget)
            for (const [name, value] of Object.entries(latest.values))
                targetDocument.documentElement.style.setProperty(name, value);
        if (latest.scheme !== previousScheme)
            options.onSchemeChange?.(latest.scheme);
    };

    // 宿主主题色是内联写在 documentElement 上的，属性变化即可捕获；
    // rAF 合并同一批写入，避免用户拖动颜色滑块时每个属性变化都重读计算样式。
    const schedule = () => {
        if (disposed || frame)
            return;
        const raf = targetDocument.defaultView?.requestAnimationFrame;
        if (!raf) {
            publish();
            return;
        }
        frame = raf.call(targetDocument.defaultView, () => {
            frame = 0;
            publish();
        });
    };

    if (sourceDocument) {
        const MutationObserverImpl = sourceDocument.defaultView?.MutationObserver ?? MutationObserver;
        observer = new MutationObserverImpl(schedule);
        observer.observe(sourceDocument.documentElement, {
            attributes: true,
            attributeFilter: ['style', 'class'],
        });
        // 属性观察已覆盖主题变量改写；设置事件用于兜底自定义 CSS 等非内联变更。
        eventSource = (sameAsTarget ? targetDocument.defaultView : requestedSource)
            ?.SillyTavern?.getContext?.()?.eventSource ?? null;
        eventSource?.on?.('settings_updated', schedule);
    }

    publish();

    return {
        read: () => latest,
        sync: publish,
        dispose: () => {
            disposed = true;
            if (frame)
                targetDocument.defaultView?.cancelAnimationFrame?.(frame);
            frame = 0;
            observer?.disconnect();
            observer = null;
            try {
                eventSource?.removeListener?.('settings_updated', schedule);
            }
            catch {
                // 宿主事件接口不可用时忽略：属性观察仍然有效。
            }
            eventSource = null;
        },
    };
}

export { toRgb as __toRgbForTest };
