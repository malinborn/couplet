import type { TabMeta } from './tab-model';

/** The drawer's one-shot arrangements (spec §6): ⌘L, ⌘R, ⌘U. */
export type SortKind = 'opened' | 'viewed' | 'ai';

function viewedKey(tab: TabMeta, activeId: string | null): number {
  // The active tab is being looked at right now.
  return tab.id === activeId ? Number.MAX_SAFE_INTEGER : tab.viewedAt;
}

function compare(kind: SortKind, activeId: string | null, a: TabMeta, b: TabMeta): number {
  switch (kind) {
    case 'opened':
      return b.openedAt - a.openedAt;
    case 'viewed':
      return viewedKey(b, activeId) - viewedKey(a, activeId);
    case 'ai':
      return Number(b.unviewed) - Number(a.unviewed) || (a.unviewed ? b.openedAt - a.openedAt : 0);
  }
}

/**
 * The tab order after arranging by `kind`. A one-shot permutation, not a
 * mode: the result becomes the new manual order, and dragging works on it
 * again at once. Ties keep their current relative order.
 *
 * - `opened`: newest opened first ("Latest").
 * - `viewed`: the active tab, then the most recently viewed.
 * - `ai`: tabs an agent put up that nobody has seen yet, newest first; the
 *   rest keep their order.
 */
export function sortedOrder(tabs: readonly TabMeta[], kind: SortKind, activeId: string | null): string[] {
  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort((x, y) => compare(kind, activeId, x.tab, y.tab) || x.index - y.index)
    .map(({ tab }) => tab.id);
}
