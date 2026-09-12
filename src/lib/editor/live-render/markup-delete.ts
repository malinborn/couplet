import {
  EditorSelection,
  EditorState,
  Prec,
  findClusterBreak,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markupModelField, type MarkupPair } from './atomic';

/**
 * Backspace and Delete at the edge of a hidden span, in live-render.
 *
 * `markup-repair.ts` guarantees the source stays well-formed, but it cannot
 * recover *intent*: after `skipAtomic` has widened a Backspace over the whole
 * closing `**`, the change that arrives at the filter says "delete `**`" and
 * the only well-formed repair of that is to put the `**` back — i.e. a
 * Backspace that does nothing. Intent has to be expressed where it is still
 * known, which is at the key.
 *
 * The rule is one sentence: **delete the character that is visually adjacent
 * to the caret.** Markers are painted at zero width, so the character next to
 * the caret on screen is found by stepping over any markers between them
 * first. Everything the spec's §3.1 table asks for falls out of that:
 *
 * | caret (on `Абзац с **жирным** словом.`) | key | deletes |
 * |---|---|---|
 * | 18, just past the closing `**` | Backspace | `м` at 15 — the last content character |
 * | 10, at the content's start | Backspace | the space at 7 — outside the span |
 * | 16, at the content's end | Delete | the space at 18 — outside the span |
 * | 8, before the opening `**` | Delete | `ж` at 10 — the first content character |
 *
 * The pairs that print at the same pixel agree by construction: offsets 16 and
 * 18 are one point on screen, and both answer "delete `м`" for Backspace and
 * "delete the space" for Delete. That symmetry is the test that the rule is
 * about the screen rather than about offsets.
 *
 * The one case that is not a single character: emptying a span's content
 * removes the **pair**, in the same transaction. Otherwise the last Backspace
 * over a bold word would leave `****` sitting in the file — visible, because
 * `****` parses as literal text and nothing hides it.
 */

/** Both markers of every pair, as flat ranges — what the caret steps over. */
function markerRanges(pairs: readonly MarkupPair[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const p of pairs) {
    out.push({ from: p.openFrom, to: p.openTo });
    out.push({ from: p.closeFrom, to: p.closeTo });
  }
  return out;
}

/**
 * Walk `pos` across every marker immediately adjacent to it in `direction`,
 * landing on the offset the caret occupies *visually*. Loops because nested
 * spans stack their markers: at the end of `***both***` there are two closing
 * markers between the caret and the last content character.
 */
function skipMarkers(
  markers: readonly { from: number; to: number }[],
  pos: number,
  forward: boolean
): number {
  for (let guard = 0; guard < 8; guard++) {
    const next = forward
      ? markers.find((m) => m.from === pos)
      : markers.find((m) => m.to === pos);
    if (!next) return pos;
    pos = forward ? next.to : next.from;
  }
  return pos;
}

/**
 * The range a Backspace/Delete at `pos` should actually remove, or `null` to
 * let the default command handle it.
 *
 * `null` is returned whenever no marker sits between the caret and the
 * character it is about to delete — the overwhelmingly common case, and the one
 * where CM6's own `deleteCharBackward` (word/cluster/indent aware) is better
 * than anything re-implemented here.
 */
export function visibleDeleteRange(
  state: EditorState,
  pairs: readonly MarkupPair[],
  pos: number,
  forward: boolean
): { from: number; to: number } | null {
  const markers = markerRanges(pairs);
  const visual = skipMarkers(markers, pos, forward);
  if (visual === pos) return null;

  const doc = state.doc;
  if (forward ? visual >= doc.length : visual <= 0) {
    // Nothing visible on that side. Deleting the markers themselves would be
    // the only other reading, and it is the wrong one — the span is intact and
    // the user asked to delete a character, not to unformat.
    return null;
  }

  // Grapheme clusters, not code units — an emoji or a combining mark next to a
  // span must go in one press like it does everywhere else.
  const line = doc.lineAt(visual);
  const offset = visual - line.from;
  let from: number;
  let to: number;
  if (forward) {
    from = visual;
    to = line.from + findClusterBreak(line.text, offset, true);
  } else {
    from = line.from + findClusterBreak(line.text, offset, false);
    to = visual;
  }
  // The visible neighbour is on the other side of a line break. Joining lines
  // is the default command's job, and it knows about list markers and indents.
  if (from === to) return null;

  // Emptying a span takes the whole pair with it, and an empty *outer* span
  // then goes too (`***x***` → nothing), so this cascades.
  for (let guard = 0; guard < 8; guard++) {
    const emptied = pairs.find((p) => p.contentFrom === from && p.contentTo === to);
    if (!emptied) break;
    from = emptied.openFrom;
    to = emptied.closeTo;
  }

  return { from, to };
}

function deleteVisibleChar(view: EditorView, forward: boolean): boolean {
  const model = view.state.field(markupModelField, false);
  if (!model || model.pairs.length === 0) return false;
  const sel = view.state.selection.main;
  // A non-empty selection is not a character delete — it is a range removal,
  // and `markup-repair.ts` is the layer that keeps that one well-formed.
  if (!sel.empty) return false;

  const range = visibleDeleteRange(view.state, model.pairs, sel.head, forward);
  if (!range) return false;

  view.dispatch({
    changes: range,
    selection: EditorSelection.cursor(range.from),
    scrollIntoView: true,
    userEvent: forward ? 'delete.forward' : 'delete.backward',
  });
  return true;
}

/**
 * `Prec.highest`, and not by preference.
 *
 * Backspace carries `inputType: "deleteContentBackward"` in the view's
 * `PendingKeys` table, so on a contenteditable it is not resolved from
 * `keydown` alone. At `Prec.high` the binding is never entered *and the failure
 * is not a clean fall-through* — the DOM-derived change is applied instead.
 * That is how `- b` once became `  b` (see `CLAUDE.md`). Delete is bound at the
 * same precedence for symmetry, so the two keys cannot drift apart.
 *
 * This keymap is registered after `blockFormatKeymap`, which is also
 * `Prec.highest`: CM6 tries equal-precedence handlers in registration order, so
 * stripping a heading / list / quote at block start still wins. The two never
 * actually compete — one is about the start of a block, the other about the
 * edge of an inline span — but the order is fixed on purpose rather than by
 * accident.
 */
export const markupDeleteKeymap: Extension = Prec.highest(
  keymap.of([
    { key: 'Backspace', run: (view) => deleteVisibleChar(view, false) },
    { key: 'Delete', run: (view) => deleteVisibleChar(view, true) },
  ])
);
