/**
 * Stash stage 04: how wide the two drawers are, and when the window must widen
 * for them (spec «Оба дровера вместе → Никогда не перекрываются»; mockup
 * `NARROW_AT`, `MIN_BOTH`). Pure — `TabDrawer` applies the widths with
 * `style:width`, `window-widen.ts` moves the window. All widths in CSS px.
 */

/** Below this viewport width both drawers squeeze side by side with compact cards. */
export const NARROW_AT = 960;
/** The gap between squeezed drawers: the tabs notch shows in it. */
export const DRAWER_GAP = 40;
/** A squeezed drawer is not narrower than this while the window can still widen. */
export const DRAWER_MIN = 320;
/** 2 × 320 + 40: below this the window widens while the stash is open. */
export const MIN_BOTH = DRAWER_MIN * 2 + DRAWER_GAP;
export const TABS_WIDTH = 420;
export const TABS_FRACTION = 0.52;
export const STASH_WIDTH = 400;
export const STASH_FRACTION = 0.36;
/** Less page than this between the drawers is no room for the window carousel (mockup). */
export const CAROUSEL_MIN_BAND = 60;

export interface DrawerLayout {
  tabs: number;
  stash: number;
  /** Below `NARROW_AT`: with the stash open, both drawers squeeze and cards go compact. */
  narrow: boolean;
}

/**
 * Wide: tabs `min(420, 52%)`, stash `min(400, 36%)` — the page and the carousel
 * show between them (the spec's «420 / 400» are the caps; the fractions are the
 * mockup's, which wins on look). Narrow with the stash open: each
 * `min(normal, (vw − 40) / 2)`, which is ≥ 320 across the spec's 680–960 band.
 * The `max(320px, …)` floor is left out on purpose: below 680 the window widens
 * (`planWiden`), and where it may not (fullscreen, Split View, a small work
 * area) halves that never overlap beat 320 px that do.
 */
export function drawerLayout(viewport: number, stashOpen: boolean): DrawerLayout {
  const narrow = viewport < NARROW_AT;
  if (stashOpen && narrow) {
    const half = Math.max(0, (viewport - DRAWER_GAP) / 2);
    return { tabs: Math.min(TABS_WIDTH, half), stash: Math.min(STASH_WIDTH, half), narrow };
  }
  return {
    tabs: Math.min(TABS_WIDTH, viewport * TABS_FRACTION),
    stash: Math.min(STASH_WIDTH, viewport * STASH_FRACTION),
    narrow,
  };
}

export function needsWiden(viewport: number): boolean {
  return viewport > 0 && viewport < MIN_BOTH;
}

export interface Band {
  left: number;
  right: number;
}

/**
 * The page a dragged tab card can open the window carousel over: right of the
 * tabs drawer, left of the stash drawer when it is open. None between squeezed
 * drawers (spec: «карусель здесь не появляется») or when it is a sliver.
 */
export function pageBand(tabsRight: number, stashLeft: number | null, viewport: number, narrow: boolean): Band | null {
  if (stashLeft !== null && narrow) return null;
  const right = stashLeft ?? viewport;
  return right - tabsRight > CAROUSEL_MIN_BAND ? { left: tabsRight, right } : null;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface WidenInput {
  /** `window.innerWidth`, CSS px (page zoom applied). */
  viewport: number;
  /** Inner size, logical px. */
  inner: Size;
  /** Outer frame, logical px. */
  outer: Rect;
  /** The monitor's work area (no menu bar, no Dock), logical px. */
  workArea: Rect;
}

export interface WidenPlan {
  /** The new inner size, logical px (`setSize` sets the inner size). */
  inner: Size;
  /** Where the outer frame moves first, or `null` to stay. */
  position: { x: number; y: number } | null;
}

/**
 * The window grows to fit both drawers: `MIN_BOTH` CSS px of content, i.e.
 * `MIN_BOTH × zoom` logical px (zoom = logical inner width / CSS width, so a
 * 125 % page zoom is counted), clamped to the work area, and moved left when
 * its right edge would cross it. `null`: nothing to do.
 */
export function planWiden(input: WidenInput): WidenPlan | null {
  const { viewport, inner, outer, workArea } = input;
  if (!needsWiden(viewport) || inner.width <= 0) return null;
  const zoom = inner.width / viewport;
  const frame = Math.max(0, outer.width - inner.width);
  const outerWidth = Math.min(Math.ceil(MIN_BOTH * zoom) + frame, workArea.width);
  const innerWidth = outerWidth - frame;
  if (innerWidth <= inner.width) return null;
  const right = workArea.x + workArea.width;
  const x = outer.x + outerWidth > right ? Math.max(workArea.x, right - outerWidth) : outer.x;
  return { inner: { width: innerWidth, height: inner.height }, position: x === outer.x ? null : { x, y: outer.y } };
}

/** The window is still as it was widened — so putting it back undoes no resize of the human's. */
export function stillWidened(current: Size, widened: Size): boolean {
  return Math.abs(current.width - widened.width) <= 1 && Math.abs(current.height - widened.height) <= 1;
}
