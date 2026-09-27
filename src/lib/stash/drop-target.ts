/**
 * Where a dragged card would land (stash stage 04). Tab cards: the stash
 * drawer or the stash zone at the bottom of the tabs drawer put them away;
 * the unfiltered list reorders; the rest of the tabs drawer cancels; the page
 * is the window carousel's (plan 05). Stash cards: anywhere on the tabs drawer
 * opens them here (mockup `hitTarget`). The caller hit-tests the rectangles.
 */
export type DragSource = 'tabs' | 'stash';

export type DropTarget = 'list' | 'stash-zone' | 'stash-drawer' | 'tabs-drawer' | 'page' | 'none';

export interface DropHits {
  stashDrawer: boolean;
  /** The stash area at the bottom of the tabs drawer — inside it, so tested first. */
  stashZone: boolean;
  list: boolean;
  /** The tabs drawer or its notch. */
  tabsDrawer: boolean;
}

export function resolveDrop(src: DragSource, hits: DropHits, filtered: boolean): DropTarget {
  if (src === 'stash') return hits.tabsDrawer || hits.list ? 'tabs-drawer' : 'none';
  if (hits.stashDrawer) return 'stash-drawer';
  if (hits.stashZone) return 'stash-zone';
  if (hits.list) return filtered ? 'none' : 'list';
  if (hits.tabsDrawer) return 'none';
  return 'page';
}
