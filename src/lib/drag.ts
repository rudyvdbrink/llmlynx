import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Follows a press on a resize handle (the edge of a side bar, a divider) until
 * it is let go: `onMove` gets how far the pointer has moved since the press, in
 * px along `axis`, and `onEnd` runs when it is let go. Meanwhile the handle has
 * data-dragging, and <html> has data-dragging set to the axis, which keeps the
 * resize cursor everywhere and stops text selection, transitions and frames
 * taking the pointer (see globals.css).
 */
export function followDrag(
  e: ReactPointerEvent<HTMLElement>,
  axis: "x" | "y",
  onMove: (delta: number) => void,
  onEnd?: () => void
) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const start = axis === "x" ? e.clientX : e.clientY;
  handle.setPointerCapture(e.pointerId);
  handle.dataset.dragging = "";
  document.documentElement.dataset.dragging = axis;
  const move = (ev: PointerEvent) => onMove((axis === "x" ? ev.clientX : ev.clientY) - start);
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("lostpointercapture", end);
    delete handle.dataset.dragging;
    delete document.documentElement.dataset.dragging;
    onEnd?.();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("lostpointercapture", end);
}

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
