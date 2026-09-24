import { sortKindForCode } from './drawer-keys';
import type { SortKind } from './drawer-sort';

/** Spec §6: the drawer opens ~200 ms after the pointer rests on the notch. */
export const HOVER_OPEN_MS = 200;
/** A hover-opened drawer closes this long after the pointer leaves it (mockup). */
export const HOVER_CLOSE_MS = 320;
/** Resting on a card this long pulls it out, showing more text (spec §6). */
export const EXPAND_MS = 600;
/**
 * A hover-opened drawer that left the keyboard with the editor takes it once
 * the pointer has rested inside it this long (tabs-questions Q5). Entering
 * alone is not enough: the drawer slides in under a pointer resting on the
 * notch, so the first twitch of the mouse would already be "inside".
 */
export const DWELL_CAPTURE_MS = 500;
/**
 * The dwell is not armed until the pointer has moved this far from where it
 * was when the drawer hover-opened: a twitch of the hand resting on the notch
 * is not a decision to use the drawer.
 */
export const DWELL_ARM_PX = 20;

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
  /**
   * The drawer takes the keyboard. `false` only for a hover-open that came
   * right after typing in the editor (tabs-questions Q5, approved): the
   * pointer resting on the notch mid-sentence must not steal the next
   * letters. It becomes `true` once the pointer enters the drawer, it is
   * pinned (click, ⌘J), or it was opened pinned.
   */
  typing: boolean;
}

export const CLOSED: DrawerState = {
  open: false,
  mode: null,
  query: '',
  kb: null,
  selected: new Set(),
  shiftHeld: false,
  typing: false,
};

/** `captureTyping`: for a hover-open, whether the last key before it went somewhere other than an editable field. */
export function open(s: DrawerState, mode: DrawerMode, captureTyping = true): DrawerState {
  if (s.open) return mode === 'pinned' ? pin(s) : s;
  return { ...CLOSED, open: true, mode, shiftHeld: s.shiftHeld, typing: mode === 'pinned' || captureTyping };
}

export function close(s: DrawerState): DrawerState {
  return s.open ? CLOSED : s;
}

export function pin(s: DrawerState): DrawerState {
  return s.open && (s.mode !== 'pinned' || !s.typing) ? { ...s, mode: 'pinned', typing: true } : s;
}

/** The pointer entered the drawer itself: from now on it takes the keyboard. */
export function captureTyping(s: DrawerState): DrawerState {
  return s.open && !s.typing ? { ...s, typing: true } : s;
}

export function keysCaptured(s: DrawerState): boolean {
  return s.open && s.typing;
}

/**
 * Typing commits to the drawer: a hover-opened one stops closing on leave,
 * and keeps the keyboard (pinned ⇒ typing).
 */
export function setQuery(s: DrawerState, query: string): DrawerState {
  if (!s.open) return s;
  return { ...s, query, kb: null, mode: query ? 'pinned' : s.mode, typing: s.typing || !!query };
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
  | { kind: 'none' };

/**
 * What a key does while the drawer is open (spec §6). `none` lets the event
 * through untouched. Sorts match `code`, so ⌘L is ⌘L in a Cyrillic layout; the
 * command key is ⌘ on a Mac and Ctrl elsewhere. ⌘J is not here: it is a
 * native menu item and never reaches the webview. ⌥+letter is text (on a Mac
 * it types ą, @, [), so it searches like any other character.
 *
 * The caller computes the action first and then asks `actionAllowed` whether
 * the drawer may take it; only an allowed action stops the event.
 */
export function drawerKeyAction(e: KeyLike, query: string, mac: boolean): DrawerKeyAction {
  if (e.isComposing || e.keyCode === 229) return { kind: 'none' };
  const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  if (e.key === 'Escape') return modified ? { kind: 'none' } : { kind: 'escape' };
  const command = mac ? e.metaKey : e.ctrlKey;
  if (command && !e.shiftKey && !e.altKey) {
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

/**
 * Whether the drawer may take `a`. Sort keys work in any open drawer: the Q5
 * rule only keeps printable typing (and, for now, Esc) with the editor until
 * the drawer has the keyboard, and letting ⌘U through would run CodeMirror's
 * `undoSelection` behind an open drawer.
 */
export function actionAllowed(s: DrawerState, a: DrawerKeyAction): boolean {
  return s.open && (s.typing || a.kind === 'sort');
}
