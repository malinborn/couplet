/** Viewport geometry of the drawer's pointer gestures, as pure functions. */

export interface Box {
  id: string;
  top: number;
  bottom: number;
}

/** A press becomes a drag once the pointer has moved this far (mockup). */
export const DRAG_THRESHOLD_PX = 5;

export function pastThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

/** Cards a ⇧-sweep crossed between two pointer positions, top to bottom. */
export function sweptIds(boxes: readonly Box[], fromY: number, toY: number): string[] {
  const lo = Math.min(fromY, toY);
  const hi = Math.max(fromY, toY);
  // With lo === hi (the press itself) this is the card under the pointer.
  return boxes.filter((b) => b.bottom > lo && b.top < hi).map((b) => b.id);
}

/** Where a dragged block lands: before the first other card whose middle is below `y`; `null` = the end. */
export function dropBefore(boxes: readonly Box[], y: number, dragged: ReadonlySet<string>): string | null {
  for (const b of boxes) {
    if (dragged.has(b.id)) continue;
    if (y < (b.top + b.bottom) / 2) return b.id;
  }
  return null;
}

/** `order` with `ids` taken out and put back, in their `order` order, before `before`. */
export function moveIds(order: readonly string[], ids: readonly string[], before: string | null): string[] {
  const moving = new Set(ids);
  const rest = order.filter((id) => !moving.has(id));
  const block = order.filter((id) => moving.has(id));
  const at = before === null ? -1 : rest.indexOf(before);
  rest.splice(at === -1 ? rest.length : at, 0, ...block);
  return rest;
}

/**
 * The x shift in a computed `transform` (`getComputedStyle(el).transform`:
 * `none`, `matrix(…)` or `matrix3d(…)` — mid-transition, the in-flight value).
 * A drawer sliding back after ⌥ is released still has its box shifted;
 * subtracting this gives the edge it is coming back to.
 */
export function translateXOf(transform: string): number {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (!m) return 0;
  const raw = m[2].split(',')[m[1] ? 12 : 4];
  const x = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(x) ? x : 0;
}

/** How far `el` is shifted sideways right now by its own transform (0 without a layout). */
export function slideOf(el: Element | undefined): number {
  if (!el || typeof getComputedStyle !== 'function') return 0;
  return translateXOf(getComputedStyle(el).transform);
}
