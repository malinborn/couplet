/**
 * A window's tabs as plain data: their order, which one is active, what each
 * shows. Every function returns a new state and never mutates, so the tab
 * controller can prepare a change, await something, and only then commit it.
 */

export interface TabMeta {
  /** Minted by Rust; also names an untitled tab's sidecar. */
  id: string;
  /** `null` for an untitled tab. */
  path: string | null;
  /** Unsaved text. For a background tab this can only be an untitled one. */
  dirty: boolean;
  /** When the tab was opened, ms since the epoch — the drawer's ⌘L. */
  openedAt: number;
  /** The last moment it was active in a focused window — ⌘R. `0`: never. */
  viewedAt: number;
  /**
   * An agent put it up while nobody was looking, and nobody has looked since
   * (spec §2). It shimmers in the drawer and on the notch until it is seen.
   */
  unviewed: boolean;
}

export interface TabListState {
  tabs: readonly TabMeta[];
  activeId: string | null;
}

export function emptyTabList(): TabListState {
  return { tabs: [], activeId: null };
}

export function activeTab(s: TabListState): TabMeta | undefined {
  return s.tabs.find((t) => t.id === s.activeId);
}

export function findById(s: TabListState, id: string): TabMeta | undefined {
  return s.tabs.find((t) => t.id === id);
}

export function findByPath(s: TabListState, path: string): TabMeta | undefined {
  return s.tabs.find((t) => t.path === path);
}

/** Right after the active tab, at the end when nothing is active. Does not activate it. */
export function insertAfterActive(s: TabListState, tab: TabMeta): TabListState {
  const at = s.tabs.findIndex((t) => t.id === s.activeId);
  const tabs = [...s.tabs];
  tabs.splice(at === -1 ? tabs.length : at + 1, 0, tab);
  return { ...s, tabs };
}

/** At `index`, clamped to the end. Does not activate it. */
export function insertAt(s: TabListState, index: number, tab: TabMeta): TabListState {
  const tabs = [...s.tabs];
  tabs.splice(Math.min(Math.max(index, 0), tabs.length), 0, tab);
  return { ...s, tabs };
}

/** `tab` takes `oldId`'s place; if `oldId` was active, `tab` is. */
export function replaceTab(s: TabListState, oldId: string, tab: TabMeta): TabListState {
  return {
    tabs: s.tabs.map((t) => (t.id === oldId ? tab : t)),
    activeId: s.activeId === oldId ? tab.id : s.activeId,
  };
}

/**
 * Remove `id`. When it was the active tab, its right neighbour becomes active,
 * else its left one. `nextActiveId` is the active tab afterwards, `null` when
 * none is left.
 */
export function removeTab(
  s: TabListState,
  id: string
): { state: TabListState; nextActiveId: string | null } {
  const at = s.tabs.findIndex((t) => t.id === id);
  if (at === -1) return { state: s, nextActiveId: s.activeId };
  const tabs = s.tabs.filter((t) => t.id !== id);
  const nextActiveId =
    s.activeId !== id ? s.activeId : (tabs[at] ?? tabs[at - 1] ?? null)?.id ?? null;
  return { state: { tabs, activeId: nextActiveId }, nextActiveId };
}

export function setActive(s: TabListState, id: string): TabListState {
  return findById(s, id) ? { ...s, activeId: id } : s;
}

export function updateTab(
  s: TabListState,
  id: string,
  patch: Partial<Omit<TabMeta, 'id'>>
): TabListState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** ⌘1…⌘9: the n-th tab, 1-based and literal — ⌘9 is the ninth, not the last. */
export function tabByIndex(s: TabListState, n: number): TabMeta | undefined {
  return n >= 1 ? s.tabs[n - 1] : undefined;
}

/** ⌃Tab / ⌃⇧Tab: the next or previous tab in order, wrapping. */
export function neighbour(s: TabListState, delta: 1 | -1): TabMeta | undefined {
  if (s.tabs.length < 2) return undefined;
  const at = s.tabs.findIndex((t) => t.id === s.activeId);
  if (at === -1) return undefined;
  return s.tabs[(at + delta + s.tabs.length) % s.tabs.length];
}

/**
 * The drawer's order (drag, sorts). `order` must name every tab exactly once;
 * anything else — a tab opened or closed while the drawer computed it — is
 * refused and `s` comes back unchanged, as it does for the same order.
 */
export function reorderTabs(s: TabListState, order: readonly string[]): TabListState {
  if (order.length !== s.tabs.length) return s;
  const byId = new Map(s.tabs.map((t) => [t.id, t]));
  const tabs: TabMeta[] = [];
  for (const id of order) {
    const tab = byId.get(id);
    if (!tab) return s;
    tabs.push(tab);
    byId.delete(id);
  }
  return tabs.every((t, i) => t === s.tabs[i]) ? s : { ...s, tabs };
}
