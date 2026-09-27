/**
 * The two drawers as one keyboard (spec «Оба дровера вместе», «Клавиатура»):
 * which one has the keys, the stash's query, sort, repo chip and ring, and
 * what a key does while the stash has the keys. Pure — the runes store wraps
 * it (`stash-store.svelte.ts`), `TabDrawer` routes keys through it.
 */
import type { KeyLike } from '../tabs/drawer-state';
import type { StashSort } from './stash-view';
import type { StashEntry, StashMode } from './types';

export type DrawerFocus = 'tabs' | 'stash';

export interface StashState {
  open: boolean;
  /** Which drawer has the keys. `'stash'` only while open. */
  focus: DrawerFocus;
  query: string;
  /** A mode, kept across opens for the window's life (mockup `aria-pressed`). */
  sort: StashSort;
  /** The repo filter chip; `null`: the whole stash. */
  repoChip: string | null;
  /** The card the arrows reached; `null` until they are used. */
  kb: string | null;
  /** The stash or «Удалённые» (stage 06). Every opening, close and put-away comes back to the stash. */
  mode: StashMode;
}

export const STASH_CLOSED: StashState = {
  open: false,
  focus: 'tabs',
  query: '',
  sort: 'changed',
  repoChip: null,
  kb: null,
  mode: 'stash',
};

/** Every opening starts clean, in the stash view, filtered by the window's repo (mockup `openStash`). */
export function openStash(s: StashState, windowRepo: string | null): StashState {
  if (s.open) return s.focus === 'stash' ? s : { ...s, focus: 'stash' };
  return { ...s, open: true, focus: 'stash', query: '', kb: null, repoChip: windowRepo, mode: 'stash' };
}

export function closeStash(s: StashState): StashState {
  return s.open ? { ...s, open: false, focus: 'tabs', query: '', kb: null, mode: 'stash' } : s;
}

/** «Удалённые»: one query box for both views, so the switch starts it empty (mockup `setStashView`). */
export function showTrash(s: StashState): StashState {
  return s.open ? { ...s, mode: 'trash', query: '', kb: null } : s;
}

/**
 * Back to the stash with an empty query — «← в тайник», Esc, and every
 * put-away (mockup `stashTabs`), which calls it whatever the view.
 */
export function showStash(s: StashState): StashState {
  if (s.mode === 'stash' && s.query === '' && s.kb === null) return s;
  return { ...s, mode: 'stash', query: '', kb: null };
}

export function focusDrawer(s: StashState, focus: DrawerFocus): StashState {
  const next: DrawerFocus = focus === 'stash' && !s.open ? 'tabs' : focus;
  return next === s.focus ? s : { ...s, focus: next };
}

export function setStashQuery(s: StashState, query: string): StashState {
  return { ...s, query, kb: null };
}

export function setStashSort(s: StashState, sort: StashSort): StashState {
  return s.sort === sort ? s : { ...s, sort };
}

export function setRepoChip(s: StashState, repoChip: string | null): StashState {
  return { ...s, repoChip, kb: null };
}

/** First Esc clears the query, the next closes the stash (spec «Esc»). */
export function escapeStash(s: StashState): StashState {
  return s.query ? setStashQuery(s, '') : closeStash(s);
}

/** ⌫ edits the query; on an empty one it drops the repo chip (mockup); then nothing. */
export function backspaceStash(s: StashState): StashState {
  if (s.query) return setStashQuery(s, s.query.slice(0, -1));
  if (s.repoChip !== null) return setRepoChip(s, null);
  return s;
}

/** The card Enter opens: the one the arrows reached, else — while searching — the top result. */
export function stashKbTarget(s: StashState, visible: readonly string[]): string | null {
  if (s.kb !== null && visible.includes(s.kb)) return s.kb;
  return s.query ? (visible[0] ?? null) : null;
}

export function moveStashKb(s: StashState, delta: 1 | -1, visible: readonly string[]): StashState {
  if (visible.length === 0) return s;
  const from = visible.indexOf(stashKbTarget(s, visible) ?? '');
  if (from === -1) return { ...s, kb: delta === 1 ? visible[0] : visible[visible.length - 1] };
  const to = Math.min(visible.length - 1, Math.max(0, from + delta));
  return { ...s, kb: visible[to] };
}

/** ⌘L / ⌘R / ⌘U in the stash (spec: «изменение ⌘L · открытие ⌘R · тип ⌘U»). */
export interface StashSortKey {
  sort: StashSort;
  /** `KeyboardEvent.code` the handler matches — layout independent. */
  code: string;
  accelerator: string;
}

/**
 * The same physical keys as the tabs drawer's sorts (`DRAWER_SORT_KEYS`), each
 * meaning this drawer's sort — so `drawer-keys.test.ts` already keeps them off
 * the menu, and `stash-state.test.ts` fails if the two tables drift apart.
 */
export const STASH_SORT_KEYS: readonly StashSortKey[] = [
  { sort: 'changed', code: 'KeyL', accelerator: 'CmdOrCtrl+L' },
  { sort: 'opened', code: 'KeyR', accelerator: 'CmdOrCtrl+R' },
  { sort: 'kind', code: 'KeyU', accelerator: 'CmdOrCtrl+U' },
];

export type StashKeyAction =
  | { kind: 'escape' }
  | { kind: 'sort'; sort: StashSort }
  | { kind: 'type'; char: string }
  | { kind: 'backspace' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'enter' }
  | { kind: 'none' };

/** What a key does while the stash has the keys. `none` lets the event through. */
export function stashKeyAction(e: KeyLike, query: string, mac: boolean): StashKeyAction {
  if (e.isComposing || e.keyCode === 229) return { kind: 'none' };
  const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  if (e.key === 'Escape') return modified ? { kind: 'none' } : { kind: 'escape' };
  const command = mac ? e.metaKey : e.ctrlKey;
  if (command && !e.shiftKey && !e.altKey) {
    const sort = STASH_SORT_KEYS.find((k) => k.code === e.code)?.sort;
    return sort ? { kind: 'sort', sort } : { kind: 'none' };
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
    if (e.key === ' ' && !query) return { kind: 'none' };
    return { kind: 'type', char: e.key };
  }
  if (e.key === 'Backspace') return { kind: 'backspace' };
  if (e.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  if (e.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (e.key === 'Enter') return { kind: 'enter' };
  return { kind: 'none' };
}

/** Bare ← / → move the keys between the drawers (spec); → from the tabs also opens the stash. */
export function arrowFocus(e: KeyLike): 'left' | 'right' | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft') return 'left';
  if (e.key === 'ArrowRight') return 'right';
  return null;
}

/**
 * After a reload: cards that were on screen and were put away again (another
 * window's dedup: «поднять его наверх», or our own put-away of a path that was
 * already in the stash) pulse; tags that were not there pop.
 *
 * `stash-changed` carries `ids` when Rust knows them (roadmap A6). Pass them as
 * `ids` to narrow the diff to those entries — but only as the union of every
 * event since the previous load: a reload that coalesces several events must
 * omit `ids` if any of them came without, or it would hide their pulses. With
 * no `ids` the whole list is diffed.
 */
export function pulses(
  prev: readonly StashEntry[],
  next: readonly StashEntry[],
  shown: ReadonlySet<string>,
  ids?: readonly string[]
): { pulse: string[]; newTags: Map<string, string[]> } {
  const before = new Map(prev.map((e) => [e.id, e]));
  const named = ids === undefined ? null : new Set(ids);
  const pulse: string[] = [];
  const newTags = new Map<string, string[]>();
  for (const e of next) {
    if (named !== null && !named.has(e.id)) continue;
    const old = before.get(e.id);
    if (!old) continue;
    if (shown.has(e.id) && (e.stashedAt ?? 0) > (old.stashedAt ?? 0)) pulse.push(e.id);
    const added = e.tags.filter((tag) => !old.tags.includes(tag));
    if (added.length > 0) newTags.set(e.id, added);
  }
  return { pulse, newTags };
}
