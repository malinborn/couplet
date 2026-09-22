/**
 * The table cell editor's key bindings — **the** declaration of them (#68, #69).
 *
 * This list is not documentation of what the handler does; it is what the
 * handler consults. `showCellEditor`'s `keydown` resolves the event through
 * {@link matchCellBinding} and switches on the {@link CellAction} it answers
 * with, and the hover cheatsheet renders the same rows through
 * `hotkey-label.ts`. So a key renamed here changes both at once, and a key
 * added without a description does not compile.
 *
 * That is deliberate and the project has the scar for it: the comment
 * accelerator is declared in `menu.rs` while the toolbar captions read
 * `keybindings.ts`, the two drifted, and 💬 ended up advertising no key at all
 * (#59). The cure there was a mirror plus a test that fails on divergence. Here
 * there is nothing to mirror, because there is only one list.
 *
 * Note what is **not** here: none of this is a CM6 keymap. While the overlay is
 * open the keyboard belongs to a `<textarea>` in `document.body`, which CM6
 * never sees — which is what lets these keys coexist with the two-Enter exit
 * from a fenced code block (#52) and with Tab indenting a list (#24) rather
 * than shadowing them. The key specs are written in CM6's notation anyway,
 * because `hotkeyLabel` already renders that notation and a second spelling of
 * "⌘⇧⏎" is the drift this file exists to prevent.
 */

export type CellAction =
  /** Write the field into the cell and stop. */
  | 'commit'
  /** Throw the field away and stop. */
  | 'cancel'
  /** Commit, then open the next row in the same column — or leave the table. */
  | 'row-next'
  /** Commit, then open the next column of this row, wrapping. */
  | 'col-next'
  /** Commit, then open the previous column of this row, wrapping. */
  | 'col-prev'
  /** Commit, then open a fresh row right below this one. */
  | 'new-row'
  /** Do nothing: let the textarea insert its own line break. */
  | 'break';

export interface CellBinding {
  /** CM6-style key spec — the notation `hotkeyLabel()` renders. */
  key: string;
  action: CellAction;
  /**
   * i18n key for the cheatsheet's right-hand column — not literal text.
   * `TABLE_CELL_BINDINGS` below is module-level, evaluated before `main.ts`
   * installs the catalog, so a literal string here would freeze in whatever
   * language happened to be active at import time (normally none yet).
   * Resolved with `t()` in `table-hotkey-sheet.ts`'s `buildSheet()`, which
   * runs on hover/focus, well after boot. `matchCellBinding` never reads
   * this field, so retexting it changes no behaviour.
   *
   * Named `descriptionKey`, not `description` — a bare `description` reads
   * as text at the call site, and `selection-toolbar.ts` / `block-templates.ts`
   * already made the same rename (`ariaLabelKey`, `labelKey`) for the same
   * reason.
   */
  descriptionKey: string;
  /**
   * i18n key for a second line under the description, for a key whose
   * behaviour has an edge worth naming. Kept on the binding rather than in
   * the sheet so it cannot describe a key that no longer exists.
   *
   * Named `noteKey` for the same reason `descriptionKey` is not `description`.
   */
  noteKey?: string;
}

/**
 * Order is the cheatsheet's reading order, not a precedence: every spec below
 * matches a disjoint set of events, so {@link matchCellBinding} can never have
 * two candidates.
 */
export const TABLE_CELL_BINDINGS: readonly CellBinding[] = [
  { key: 'Tab', action: 'col-next', descriptionKey: 'editor.table_keys.col_next' },
  {
    key: 'Shift-Tab',
    action: 'col-prev',
    descriptionKey: 'editor.table_keys.col_prev',
    noteKey: 'editor.table_keys.col_prev_note',
  },
  {
    key: 'Enter',
    action: 'row-next',
    descriptionKey: 'editor.table_keys.row_next',
    noteKey: 'editor.table_keys.row_next_note',
  },
  { key: 'Shift-Enter', action: 'break', descriptionKey: 'editor.table_keys.break' },
  { key: 'Mod-Enter', action: 'commit', descriptionKey: 'editor.table_keys.commit' },
  { key: 'Mod-Shift-Enter', action: 'new-row', descriptionKey: 'editor.table_keys.new_row' },
  { key: 'Escape', action: 'cancel', descriptionKey: 'editor.table_keys.cancel' },
];

/** The parts of a `KeyboardEvent` a binding can depend on. */
export interface CellKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

interface ParsedSpec {
  base: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function parseSpec(key: string): ParsedSpec {
  const parts = key.split('-');
  const base = parts.pop() ?? '';
  return {
    base,
    mod: parts.includes('Mod') || parts.includes('Cmd') || parts.includes('Ctrl'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt') || parts.includes('Option'),
  };
}

/**
 * Which binding, if any, the user just pressed.
 *
 * `Mod` is Command **or** Control, matching CM6's own reading, so a Linux user
 * gets the same behaviour from Ctrl that a Mac user gets from ⌘. The match is
 * exact on every modifier, which is what keeps `Enter`, `Shift-Enter`,
 * `Mod-Enter` and `Mod-Shift-Enter` from shadowing one another regardless of
 * the order they are declared in.
 */
export function matchCellBinding(
  event: CellKeyEvent,
  bindings: readonly CellBinding[] = TABLE_CELL_BINDINGS
): CellBinding | null {
  const mod = event.metaKey || event.ctrlKey;
  for (const binding of bindings) {
    const spec = parseSpec(binding.key);
    if (spec.base !== event.key) continue;
    if (spec.mod !== mod) continue;
    if (spec.shift !== event.shiftKey) continue;
    if (spec.alt !== event.altKey) continue;
    return binding;
  }
  return null;
}
