// 视口判定与安全区度量。只在宿主顶层文档测量，iframe 内的数值由外壳桥接。

// 手机横屏可能超过 720px；短屏触控设备仍使用手机模式。
const mobileQuery = matchMedia('(max-width: 720px), (pointer: coarse) and (max-height: 720px)');

export function mobile() {
  return mobileQuery.matches;
}

// Android 使用宿主 --tt-inset-*，iOS 使用 env；只在顶层文档测量。
export function measureSafeArea() {
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
