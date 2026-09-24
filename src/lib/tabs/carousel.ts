/**
 * The window carousel (plan 05; mockup drawer-carousel.html): what it offers,
 * where its keyboard goes, how its edges scroll. Pure — `WindowCarousel.svelte`
 * holds the DOM and the frame loop, `TabDrawer.svelte` the gesture.
 */
import type { KeyLike } from './drawer-state';

/** One window a tab can move to — `CarouselWindow` in src-tauri/src/tab_commands.rs. */
export interface CarouselWindow {
  label: string;
  number: number | null;
  project: string | null;
  branch: string | null;
  tabCount: number;
  activePath: string | null;
  /** The start of its active document. Untrusted text: rendered as text only. */
  head: string;
}

export type CarouselItem = { kind: 'new' } | ({ kind: 'window' } & CarouselWindow);

/** Where moved tabs go — `MoveTarget` in src-tauri/src/tab_commands.rs. */
export type MoveTarget = { kind: 'window'; label: string } | { kind: 'new-window' };

/** «+ Новое окно» first, then the windows in Rust's order (most recently focused first). */
export function carouselItems(windows: readonly CarouselWindow[]): CarouselItem[] {
  return [{ kind: 'new' }, ...windows.map((w) => ({ kind: 'window' as const, ...w }))];
}

export function targetOf(item: CarouselItem): MoveTarget {
  return item.kind === 'new' ? { kind: 'new-window' } : { kind: 'window', label: item.label };
}

/** The keyboard starts on the window the human was in last; alone, on «+ Новое окно». */
export function initialKb(items: readonly CarouselItem[]): number {
  return items.length > 1 ? 1 : 0;
}

export function moveKbIndex(index: number, delta: 1 | -1, count: number): number {
  return count === 0 ? 0 : Math.min(count - 1, Math.max(0, index + delta));
}

export const THUMB_MIN_PX = 190;
export const THUMB_MAX_PX = 320;
export const THUMB_GUTTER_PX = 64;
/** The width a thumbnail's document is laid out at before it is scaled down to the thumbnail. */
export const DOC_WIDTH_PX = 640;

export function thumbWidth(carouselWidth: number): number {
  return Math.round(Math.max(THUMB_MIN_PX, Math.min(THUMB_MAX_PX, carouselWidth - THUMB_GUTTER_PX)));
}

/** The top and bottom 22 % of the view scroll while the dragged card is in them. */
export const EDGE_ZONE = 0.22;
/** Pixels per frame at the very edge. */
export const EDGE_SPEED_PX = 16;
/** Reduced motion: the edge zone steps half a view this often instead of gliding (D11). */
export const REDUCED_STEP_MS = 400;
/** The «got it» pulse on a thumbnail before the carousel goes. */
export const GOT_MS = 420;

/** −1…1: how deep `y` is in the top (−) or bottom (+) edge zone of `top`…`bottom`; 0 between them. */
export function edgeVelocity(y: number, top: number, bottom: number): number {
  const zone = (bottom - top) * EDGE_ZONE;
  if (zone <= 0) return 0;
  let v = 0;
  if (y < top + zone) v = -(top + zone - y) / zone;
  else if (y > bottom - zone) v = (y - (bottom - zone)) / zone;
  return Math.max(-1, Math.min(1, v));
}

export function clampOffset(offset: number, max: number): number {
  return Math.max(0, Math.min(Math.max(0, max), offset));
}

/** One frame of the edge glide: slow at the zone's inner edge, fastest at the view's. */
export function glide(offset: number, v: number, max: number): number {
  return clampOffset(offset + v * Math.abs(v) * EDGE_SPEED_PX, max);
}

/** `glide` for reduced motion: half a view per `REDUCED_STEP_MS`, no frames in between. */
export function reducedStep(
  offset: number,
  v: number,
  max: number,
  viewHeight: number,
  lastStepAt: number,
  now: number
): { offset: number; lastStepAt: number } {
  if (v === 0 || now - lastStepAt < REDUCED_STEP_MS) return { offset, lastStepAt };
  return { offset: clampOffset(offset + (Math.sign(v) * viewHeight) / 2, max), lastStepAt: now };
}

/** Thumbnails shrink to 88 % as they leave the middle of the view. */
export function thumbScale(center: number, mid: number, half: number): number {
  if (half <= 0) return 1;
  return 1 - Math.min(1, Math.abs(center - mid) / half) * 0.12;
}

/** The offset that shows the item spanning `top`…`bottom` (track coordinates), `pad` around it. */
export function revealOffset(
  offset: number,
  top: number,
  bottom: number,
  viewHeight: number,
  max: number,
  pad = 28
): number {
  if (top - pad < offset) return clampOffset(top - pad, max);
  if (bottom + pad > offset + viewHeight) return clampOffset(bottom + pad - viewHeight, max);
  return offset;
}

/** Up while a dragged card is over the page right of the drawer, inside the window (D9). */
export function wantsCarousel(x: number, y: number, drawerRight: number, width: number, height: number): boolean {
  return x > drawerRight - 4 && x < width && y > 0 && y < height;
}

export type CarouselKey = 'up' | 'down' | 'choose' | 'cancel' | 'none';

/** The carousel's own keys (D10). Anything else: `none`. */
export function carouselKey(e: KeyLike): CarouselKey {
  if (e.isComposing || e.keyCode === 229) return 'none';
  if (e.metaKey || e.ctrlKey || e.altKey) return 'none';
  switch (e.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Enter':
      return 'choose';
    case 'Escape':
      return 'cancel';
    default:
      return 'none';
  }
}
