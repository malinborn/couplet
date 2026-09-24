import type { SortKind } from './drawer-sort';

/**
 * The drawer's sort keys (spec §6: ⌘L / ⌘R / ⌘U, only while it is open).
 *
 * Deliberately not native menu items, unlike every other key in this app: a
 * menu accelerator fires whether or not the drawer is open, and the rest of
 * the time these keys belong to the editor — ⌘U is CodeMirror's
 * `undoSelection`. While the drawer is open its capture-phase keydown
 * handler owns them, matched on `e.code` so the layout does not matter.
 * `drawer-keys.test.ts` fails if `menu.rs` ever claims one: a native
 * accelerator is resolved before the webview sees the key.
 */
export interface DrawerSortKey {
  sort: SortKind;
  /** `KeyboardEvent.code` the handler matches. */
  code: string;
  /** Tauri notation — for captions (`acceleratorLabel`) and the collision test. */
  accelerator: string;
}

export const DRAWER_SORT_KEYS: readonly DrawerSortKey[] = [
  { sort: 'opened', code: 'KeyL', accelerator: 'CmdOrCtrl+L' },
  { sort: 'viewed', code: 'KeyR', accelerator: 'CmdOrCtrl+R' },
  { sort: 'ai', code: 'KeyU', accelerator: 'CmdOrCtrl+U' },
];

/**
 * «В окно…» (plan 05, D10): the carousel for the selection, else the card the
 * arrows are on, else the active tab. A drawer key like the sorts, for the
 * same reason — while the drawer is closed ⌘M is nobody's, and a native item
 * would fire whether the drawer is open or not.
 */
export const DRAWER_MOVE_KEY = { code: 'KeyM', accelerator: 'CmdOrCtrl+M' } as const;

export function sortKindForCode(code: string): SortKind | undefined {
  return DRAWER_SORT_KEYS.find((key) => key.code === code)?.sort;
}
