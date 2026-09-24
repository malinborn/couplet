import { DRAWER_MOVE_KEY, sortKindForCode } from './drawer-keys';
import type { SortKind } from './drawer-sort';

/** Spec §6: the drawer opens ~200 ms after the pointer rests on the notch. */
export const HOVER_OPEN_MS = 200;
/** A hover-opened drawer closes this long after the pointer leaves it (mockup). */
export const HOVER_CLOSE_MS = 320;
/** Resting on a card this long pulls it out, showing more text (spec §6). */
export const EXPAND_MS = 600;

/** A hover-opened drawer closes when the pointer leaves; a pinned one stays. */
export type DrawerMode = 'hover' | 'pinned';

export interface DrawerState {
  open: boolean;
  mode: DrawerMode | null;
  /** Type-to-filter query; `''` when not searching. */
  query: string;
  /** Card the arrow keys moved to; `null` until they are used. */
  kb: string | null;
  /** ⇧-selected tab ids. */
  selected: ReadonlySet<string>;
  /** ⇧ is held: the bottom hint shows only then (spec §6). */
  shiftHeld: boolean;
}

export const CLOSED: DrawerState = {
  open: false,
  mode: null,
  query: '',
  kb: null,
  selected: new Set(),
  shiftHeld: false,
};

/**
 * However it opens, an open drawer has the keyboard (spec §6, tabs-questions
 * Q5): hover and pinned differ only in whether the pointer leaving closes it.
 */
export function open(s: DrawerState, mode: DrawerMode): DrawerState {
  if (s.open) return mode === 'pinned' ? pin(s) : s;
  return { ...CLOSED, open: true, mode, shiftHeld: s.shiftHeld };
}

export function close(s: DrawerState): DrawerState {
  return s.open ? CLOSED : s;
}

export function pin(s: DrawerState): DrawerState {
  return s.open && s.mode !== 'pinned' ? { ...s, mode: 'pinned' } : s;
}

/** Typing commits to the drawer: a hover-opened one stops closing on leave. */
export function setQuery(s: DrawerState, query: string): DrawerState {
  if (!s.open) return s;
  return { ...s, query, kb: null, mode: query ? 'pinned' : s.mode };
}

/** First Esc clears the query, the next the selection, the last closes. */
export function escape(s: DrawerState): DrawerState {
  if (!s.open) return s;
  if (s.query) return setQuery(s, '');
  if (s.selected.size > 0) return clearSelection(s);
  return close(s);
}

/**
 * The card Enter opens and the keyboard ring sits on: the one the arrows
 * reached, else — while searching — the top result.
 */
export function kbTarget(s: DrawerState, visible: readonly string[]): string | null {
  if (s.kb !== null && visible.includes(s.kb)) return s.kb;
  return s.query ? (visible[0] ?? null) : null;
}

export const enterTarget = kbTarget;

/**
 * Arrow keys: from the current target, else from the active tab; with
 * neither, ↓ lands on the first card and ↑ on the last.
 */
export function moveKb(
  s: DrawerState,
  delta: 1 | -1,
  visible: readonly string[],
  activeId: string | null
): DrawerState {
  if (!s.open || visible.length === 0) return s;
  const current = kbTarget(s, visible);
  const from = visible.indexOf(current ?? activeId ?? '');
  if (from === -1) return { ...s, kb: delta === 1 ? visible[0] : visible[visible.length - 1] };
  const to = Math.min(visible.length - 1, Math.max(0, from + delta));
  return { ...s, kb: visible[to] };
}

/** The keyboard ring moves to `id` — the neighbour of a focused card that went away. */
export function setKb(s: DrawerState, id: string | null): DrawerState {
  return s.open && s.kb !== id ? { ...s, kb: id } : s;
}

/**
 * Where the keyboard goes when card `gone` disappears from the list (×,
 * ⌘-click, a group close): the next card that is still there, else the
 * nearest one above it. `null`: nothing of the old list is left.
 */
export function neighbourAfterRemoval(
  before: readonly string[],
  now: readonly string[],
  gone: string
): string | null {
  const i = before.indexOf(gone);
  if (i === -1) return null;
  const left = new Set(now);
  for (let j = i + 1; j < before.length; j++) if (left.has(before[j])) return before[j];
  for (let j = i - 1; j >= 0; j--) if (left.has(before[j])) return before[j];
  return null;
}

/** ⇧-click toggles one card; a ⇧-sweep toggles every card it passes, once. */
export function toggleMany(s: DrawerState, ids: readonly string[]): DrawerState {
  if (!s.open || ids.length === 0) return s;
  const selected = new Set(s.selected);
  for (const id of ids) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  return { ...s, selected };
}

export function clearSelection(s: DrawerState): DrawerState {
  return s.selected.size > 0 ? { ...s, selected: new Set() } : s;
}

export function setShift(s: DrawerState, held: boolean): DrawerState {
  return s.shiftHeld === held ? s : { ...s, shiftHeld: held };
}

/** «⇧ клик / протяжка — выделение · ⌘ клик — закрыть» — only while ⇧ is held. */
export function hintVisible(s: DrawerState): boolean {
  return s.open && s.shiftHeld;
}

/** The fields of a `KeyboardEvent` the routing reads. */
export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  /** 229 marks a key the IME consumed, even where `isComposing` is not yet set. */
  keyCode?: number;
}

export type DrawerKeyAction =
  | { kind: 'escape' }
  | { kind: 'sort'; sort: SortKind }
  | { kind: 'type'; char: string }
  | { kind: 'backspace' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'enter' }
  | { kind: 'carousel' }
  /** ⌦ or ⌫ with a ⇧-selection: «Закрыть выбранные». */
  | { kind: 'close-selected' }
  | { kind: 'none' };

/**
 * What a key does while the drawer is open (spec §6). `none` lets the event
 * through untouched. Sorts match `code`, so ⌘L is ⌘L in a Cyrillic layout; the
 * command key is ⌘ on a Mac and Ctrl elsewhere. ⌘J is not here: it is a
 * native menu item and never reaches the webview. ⌥+letter is text (on a Mac
 * it types ą, @, [), so it searches like any other character.
 *
 * Every action but `none` is the drawer's in any open drawer, hover-opened
 * included (tabs-questions Q5: strictly the spec) — Esc too.
 */
/**
 * `canCloseSelection`: a ⇧-selection exists and nothing else owns the keys
 * (no drag, no carousel). Then ⌦ closes it, and so does ⌫ while the query is
 * empty — with text, ⌫ edits the query. Matched on the code, any modifiers:
 * ⇧ is often still held from selecting, and ⌘⌫ means nothing in the drawer.
 */
export function drawerKeyAction(e: KeyLike, query: string, mac: boolean, canCloseSelection = false): DrawerKeyAction {
  if (e.isComposing || e.keyCode === 229) return { kind: 'none' };
  if (canCloseSelection && (e.code === 'Delete' || (e.code === 'Backspace' && !query))) {
    return { kind: 'close-selected' };
  }
  const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  if (e.key === 'Escape') return modified ? { kind: 'none' } : { kind: 'escape' };
  const command = mac ? e.metaKey : e.ctrlKey;
  if (command && !e.shiftKey && !e.altKey) {
    if (e.code === DRAWER_MOVE_KEY.code) return { kind: 'carousel' };
    const sort = sortKindForCode(e.code);
    return sort ? { kind: 'sort', sort } : { kind: 'none' };
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
    if (e.key === ' ' && !query) return { kind: 'none' };
    return { kind: 'type', char: e.key };
  }
  if (e.key === 'Backspace') return query ? { kind: 'backspace' } : { kind: 'none' };
  if (e.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  if (e.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (e.key === 'Enter') return { kind: 'enter' };
  return { kind: 'none' };
}
