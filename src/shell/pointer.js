// 悬浮球与工作台共用的几何约束与指针手势。

export const MIN_FLOATING_WIDTH = 240;
// 给标题栏、两层导航和至少一行完整操作控件留出空间。
export const MIN_FLOATING_HEIGHT = 320;

export function clampPoint(point, width, height, margin = 8, bottomMargin = margin, bounds = { left: 0, top: 0, width: innerWidth, height: innerHeight }) {
  return {
    x: Math.min(Math.max(bounds.left + margin, point.x), Math.max(bounds.left + margin, bounds.left + bounds.width - width - margin)),
    y: Math.min(Math.max(bounds.top + margin, point.y), Math.max(bounds.top + margin, bounds.top + bounds.height - height - bottomMargin)),
  };
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

export function resizable(target, handle, { enabled, bounds, onResizeEnd }) {
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
