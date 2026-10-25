/**
 * Where a dragged card would land (stash stage 04). Tab cards: the stash
 * drawer or the stash zone at the bottom of the tabs drawer put them away;
 * the unfiltered list reorders; the rest of the tabs drawer cancels; the page
 * is the window carousel's (plan 05). Stash cards: anywhere on the tabs drawer
 * opens them here (mockup `hitTarget`). The caller hit-tests the rectangles.
 * File links (plan 03): a stash card over the text, or a tab card with ⌥,
 * inserts a link there ('text').
 */
export type DragSource = 'tabs' | 'stash';

export type DropTarget = 'list' | 'stash-zone' | 'stash-drawer' | 'tabs-drawer' | 'page' | 'text' | 'none';

export interface DropHits {
  stashDrawer: boolean;
  /** The stash area at the bottom of the tabs drawer — inside it, so tested first. */
  stashZone: boolean;
  list: boolean;
  /** The tabs drawer or its notch. */
  tabsDrawer: boolean;
  /** The editor's text, where a link may be dropped (file links D7). Absent: no link drops. */
  text?: boolean;
}

/**
 * `linkMode`: ⌥ is held during a tab-card drag (D7) — over the page the card
 * links instead of moving, so the carousel ('page') is never the answer. A
 * stash card is always in link mode over the text.
 */
export function resolveDrop(src: DragSource, hits: DropHits, filtered: boolean, linkMode = false): DropTarget {
  if (src === 'stash') {
    if (hits.tabsDrawer || hits.list) return 'tabs-drawer';
    if (hits.stashDrawer) return 'none';
    return hits.text ? 'text' : 'none';
  }
  if (hits.stashDrawer) return 'stash-drawer';
  if (hits.stashZone) return 'stash-zone';
  if (hits.list) return filtered ? 'none' : 'list';
  if (hits.tabsDrawer) return 'none';
  if (linkMode) return hits.text ? 'text' : 'none';
  return 'page';
}
