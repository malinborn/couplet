import { EditorSelection, StateEffect, StateField, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { ContinuableKind } from './inline-continuation';

/**
 * A format carried onto a new line by Shift+Enter, before any text exists to
 * hold it.
 *
 * Plain Enter at the end of a bold line leaves the format behind: a marker pair
 * cannot straddle a line break (`CLAUDE.md`, "Enter inside a span"), so the
 * break goes after the closing marker and the new line is plain. Shift+Enter is
 * the "keep formatting" variant, and the obvious way to build it — writing
 * `****` on the new line with the caret in the middle — puts four literal
 * asterisks on screen and leaves them in the file the moment the user changes
 * their mind. So this is state, exactly like `continuationField`'s pending
 * format: **nothing is written until the first character is typed**, and then
 * that character is written wrapped (`**x**`, caret at the inner edge, so the
 * rest of the word continues the format the ordinary way).
 *
 * `layers` are outermost first, carrying the markers verbatim from the span the
 * caret was in, so `__x__` stays `__` and `***x***` comes back as both.
 */
export interface CarryLayer {
  kind: ContinuableKind;
  open: string;
  close: string;
}

export interface CarriedFormat {
  /** Where the carry began — the new line's start, after any indentation. */
  origin: number;
  /** Where the caret must be for the carry to apply. */
  caret: number;
  layers: CarryLayer[];
}

/** Effect carrying a carried format, or `null` to clear it. Post-change coordinates. */
export const setCarriedFormat = StateEffect.define<CarriedFormat | null>();

/**
 * Re-validated on every transaction rather than remembered, for the same
 * reason `continuationField` is: caret still at `caret`, only blanks typed
 * since `origin`, and still on the same line. Move away and come back, and the
 * format is gone — it is not a mode.
 */
function stillCarried(state: EditorState, value: CarriedFormat): boolean {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== value.caret) return false;
  if (value.origin > value.caret) return false;
  if (state.doc.lineAt(value.origin).number !== state.doc.lineAt(value.caret).number) return false;
  return /^[^\S\n]*$/.test(state.sliceDoc(value.origin, value.caret));
}

export const carryField: StateField<CarriedFormat | null> = StateField.define<CarriedFormat | null>({
  create: () => null,
  update(value, tr) {
    // Mapped before the effects, as in `continuationField`: an effect sent with
    // changes is already in post-change coordinates.
    if (value && tr.docChanged) {
      value = {
        origin: tr.changes.mapPos(value.origin, -1),
        caret: tr.changes.mapPos(value.caret, 1),
        layers: value.layers,
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(setCarriedFormat)) value = effect.value;
    }
    if (!value || value.layers.length === 0) return null;
    return stillCarried(tr.state, value) ? value : null;
  },
});

/** First characters that are markdown syntax rather than text — see `planCarryInsert`. */
const MARKUP_START = /^[*_~`#>+-]/;

export function carriedFormatAt(state: EditorState, pos: number): CarriedFormat | null {
  const value = state.field(carryField, false) ?? null;
  return value && value.caret === pos ? value : null;
}

/**
 * The first character typed at a carried caret, written inside the carried
 * markers. Returns `null` to let CM6 insert normally, which is right for:
 *
 * - whitespace first — `** x**` does not parse, so a space stays plain and the
 *   carry moves along with the caret, ready for the first real character;
 * - anything carrying a line break (a paste) — the format belongs to a line;
 * - a markdown marker character first (`MARKUP_START`): wrapped, `*` under bold
 *   is `*****` — a thematic break — and `-`/`#`/`>` at a line start are the user
 *   starting a list, heading or quote, not bold text. The plain insertion moves
 *   the caret off the carry, which ends it.
 *
 * Trailing whitespace of a multi-character insertion goes after the closing
 * marker for the same parsing reason, and then the caret follows it out.
 */
export function planCarryInsert(state: EditorState, from: number, to: number, insert: string): TransactionSpec | null {
  if (from !== to || !insert || /^\s/.test(insert) || MARKUP_START.test(insert) || insert.includes('\n')) return null;
  const carry = carriedFormatAt(state, from);
  if (!carry) return null;

  const core = insert.replace(/\s+$/, '');
  const trailing = insert.slice(core.length);
  const open = carry.layers.map((l) => l.open).join('');
  const close = carry.layers
    .map((l) => l.close)
    .reverse()
    .join('');
  const text = open + core + close + trailing;
  return {
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(trailing ? from + text.length : from + open.length + core.length),
    effects: setCarriedFormat.of(null),
    userEvent: 'input.type',
  };
}

/**
 * A format key at a carried caret toggles that format *in the carry*: the
 * matching key ends its layer — the same off switch the pending format has
 * (Cmd+B for bold, …) — and any other adds one, innermost. The ordinary toggle
 * would write an empty pair (`**`) here, move the caret off the carry and drop
 * the format the user just carried.
 */
export function toggleCarriedKind(carry: CarriedFormat, kind: ContinuableKind, marker: string): TransactionSpec {
  const layers = carry.layers.some((l) => l.kind === kind)
    ? carry.layers.filter((l) => l.kind !== kind)
    : [...carry.layers, { kind, open: marker, close: marker }];
  return { effects: setCarriedFormat.of(layers.length ? { ...carry, layers } : null) };
}
