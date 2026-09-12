import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
  type ChangeSpec,
} from '@codemirror/state';
import { markupModelField, type MarkupPair, type PairKind } from './atomic';

/**
 * Live-render's **delimiter-run guard** — issue #66.
 *
 * `markup-repair.ts` keeps every marker *pair* a pair. That is not the same
 * invariant as "the result is still markdown". CommonMark's flanking rules say
 * a closing `**` may not be preceded by whitespace and an opening `**` may not
 * be followed by it, so `**как **` has a well-formed pair and still is not
 * bold: Lezer produces no `StrongEmphasis`, nothing hides the asterisks, and
 * four characters of raw markup appear in a document the user believes is
 * prose. That is #66 exactly, and it is the reason this is a *second* filter
 * rather than another rule inside the first one — they answer different
 * questions about the same edit.
 *
 * Measured, all three of these produced `ПРивет **как **` on `dev-preview`:
 *
 * | gesture | before | after |
 * |---|---|---|
 * | Space at the content end | `ПРивет **как**` | `ПРивет **как **` |
 * | Backspace at the content end | `ПРивет **как x**` | `ПРивет **как **` |
 * | programmatic insert of `" мир "` | `ПРивет **как**` | `ПРивет **как мир **` |
 *
 * So the invariant cannot be held at the keymap or at the input handler. Only
 * the transaction sees all three.
 *
 * ### Why this one works in post-edit coordinates
 *
 * `markup-repair.ts` deliberately works in *pre-edit* coordinates, because it
 * reasons about which markers a change tears and that is a statement about the
 * document the change was written against. This guard reasons about the
 * opposite thing — **what the text looks like afterwards** — and the tell is
 * that all three rows above are different changes with the same result. So it
 * maps each pre-edit pair's four edges through `tr.changes` and reads
 * `tr.newDoc`, which is the cheapest honest way to ask "is this still
 * markdown".
 *
 * The pairs still have to come from `tr.startState`: once the markup is broken
 * there is no `StrongEmphasis` node in the new tree to find, which is the whole
 * symptom. The mapped marker text is therefore re-checked against `newDoc`
 * before a pair is touched (`markersSurvived`) — a pair whose markers were
 * rewritten by the repair layer or by a wholesale replacement is somebody
 * else's business, and skipping it is always safe.
 *
 * ### The repair is always the same
 *
 * Whitespace that ends up against the inside of a marker belongs *outside* the
 * span. `**как **` → `**как** `, `** как**` → ` **как**`. The characters are
 * never dropped and never rewritten — only moved across the marker — so no
 * markdown that depends on exact whitespace (a two-space hard line break, the
 * indentation of a list continuation) can be damaged by this.
 *
 * A span whose content becomes *entirely* whitespace loses its markers
 * instead: `** **` is literal text by the same flanking rule, and there is no
 * position for the space that would make it bold.
 *
 * ### Inline code is deliberately not in the set
 *
 * Code spans have no flanking rule — `` `как ` `` is a perfectly good
 * `InlineCode`, measured — and the space inside it is content the user can see
 * and meant to type. Moving it would be a bug, not a repair. Links are out for
 * the same reason: the whitespace rule is about *delimiter runs*, and `[`…`]`
 * is not one.
 */

/** The pair kinds CommonMark's flanking rules apply to. */
const DELIMITER_RUN: ReadonlySet<PairKind> = new Set<PairKind>([
  'strong',
  'emphasis',
  'strikethrough',
]);

export function isDelimiterRunPair(pair: MarkupPair): boolean {
  return DELIMITER_RUN.has(pair.kind);
}

/** The slice of a document this module needs — `Text` satisfies it. */
export interface DocSlice {
  sliceString(from: number, to: number): string;
}

/** Position mapping through the transaction being inspected. */
export type MapPos = (pos: number, assoc: -1 | 1) => number;

/**
 * One relocation: the whitespace at `[from, to)` of the post-change document
 * moves across a marker. `landsAfter` is the post-change position the
 * corrective change inserts it at — a caret that was sitting in the run should
 * be put back at `corrective.mapPos(landsAfter, 1)`, which is the far side of
 * the reinserted text.
 */
export interface WhitespaceMove {
  from: number;
  to: number;
  landsAfter: number;
}

export interface WhitespaceCorrection {
  /** In post-change (`tr.newDoc`) coordinates — compose onto `tr.changes`. */
  changes: ChangeSpec[];
  moves: WhitespaceMove[];
}

function leadingWhitespace(text: string): number {
  let n = 0;
  while (n < text.length && /\s/.test(text[n])) n++;
  return n;
}

function trailingWhitespace(text: string): number {
  let n = 0;
  while (n < text.length && /\s/.test(text[text.length - 1 - n])) n++;
  return n;
}

/**
 * The whole rule, as a pure function of the mapped pair edges and the resulting
 * text. Returns `null` when every pair is already well-formed — the common
 * case, and the one that has to stay cheap, since this runs on every
 * transaction.
 *
 * Pairs are visited innermost-first and a correction is dropped if it would
 * overlap one already emitted, so nested spans cannot produce two changes over
 * the same characters.
 */
export function whitespaceCorrections(
  pairs: readonly MarkupPair[],
  mapPos: MapPos,
  doc: DocSlice
): WhitespaceCorrection | null {
  const ordered = pairs
    .filter(isDelimiterRunPair)
    .slice()
    .sort((a, b) => a.closeTo - a.openFrom - (b.closeTo - b.openFrom));

  const changes: ChangeSpec[] = [];
  const moves: WhitespaceMove[] = [];
  const claimed: { from: number; to: number }[] = [];

  const free = (from: number, to: number): boolean =>
    !claimed.some((r) => to > r.from && from < r.to);

  for (const pair of ordered) {
    // The four biases are the whole difficulty of working in post-edit
    // coordinates, and getting any of them backwards silently disables the
    // guard: with `contentTo` biased -1, a space typed at the content's end
    // maps to *before* itself, the marker slice then reads `" **"` instead of
    // `"**"`, `markersSurvived` fails and the pair is skipped — i.e. exactly
    // #66, still broken, with every unit test green.
    //
    // The rule: text inserted at a *content* edge is content (bias it in),
    // text inserted at a *span* edge is not (bias it out).
    const openFrom = mapPos(pair.openFrom, 1);
    const contentFrom = mapPos(pair.contentFrom, -1);
    const contentTo = mapPos(pair.contentTo, 1);
    const closeTo = mapPos(pair.closeTo, -1);

    // A pair whose markers no longer read as themselves was rewritten by
    // another layer (or replaced wholesale). Not ours to repair.
    if (doc.sliceString(openFrom, contentFrom) !== pair.openText) continue;
    if (doc.sliceString(contentTo, closeTo) !== pair.closeText) continue;
    if (contentTo <= contentFrom) continue; // empty — `markup-repair.ts` owns it

    const content = doc.sliceString(contentFrom, contentTo);
    const lead = leadingWhitespace(content);

    if (lead === content.length) {
      // All whitespace. No placement of the markers makes this a span, so the
      // span goes and the whitespace stays.
      if (!free(openFrom, closeTo)) continue;
      claimed.push({ from: openFrom, to: closeTo });
      changes.push({ from: openFrom, to: contentFrom, insert: '' });
      changes.push({ from: contentTo, to: closeTo, insert: '' });
      continue;
    }

    const trail = trailingWhitespace(content);
    if (!lead && !trail) continue;
    if (!free(openFrom, closeTo)) continue;
    claimed.push({ from: openFrom, to: closeTo });

    if (trail) {
      changes.push({ from: contentTo - trail, to: contentTo, insert: '' });
      changes.push({ from: closeTo, to: closeTo, insert: content.slice(content.length - trail) });
      moves.push({ from: contentTo - trail, to: contentTo, landsAfter: closeTo });
    }
    if (lead) {
      changes.push({ from: contentFrom, to: contentFrom + lead, insert: '' });
      changes.push({ from: openFrom, to: openFrom, insert: content.slice(0, lead) });
      moves.push({ from: contentFrom, to: contentFrom + lead, landsAfter: openFrom });
    }
  }

  if (changes.length === 0) return null;
  changes.sort((a, b) => (a as { from: number }).from - (b as { from: number }).from);
  return { changes, moves };
}

/**
 * The filter.
 *
 * Registered **before** `markupRepairFilter` in `index.ts`, which — because CM6
 * runs transaction filters in reverse facet order — is what makes it run
 * *after* it. That order is the point: the repair layer may itself write a
 * marker back next to surviving whitespace, and this guard has to see the
 * finished text. `caretNormalizeFilter` stays last, so the caret is normalised
 * against the document that will actually exist.
 *
 * Undo and redo are exempt for the same reason they are exempt in
 * `markup-repair.ts`: history replays an inverse that reconstructs a document
 * this app already accepted, and "correcting" it would stop undo from undoing.
 *
 * Like its neighbours it returns a plain spec rather than a `Transaction`, so
 * `filterTransaction` resolves it with filtering off and cannot loop.
 */
export const markupWhitespaceFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;

  const { pairs } = tr.startState.field(markupModelField);
  if (pairs.length === 0) return tr;

  const result = whitespaceCorrections(pairs, (pos, assoc) => tr.changes.mapPos(pos, assoc), tr.newDoc);
  if (!result) return tr;

  const corrective = ChangeSet.of(result.changes, tr.newDoc.length);
  const before = tr.selection ?? tr.startState.selection.map(tr.changes);

  // A caret standing in whitespace that just moved goes with it — otherwise
  // deflecting the space the user typed would leave the caret behind it, back
  // inside the span, where the next space would be deflected all over again.
  const after = EditorSelection.create(
    before.ranges.map((range) => {
      if (range.empty) {
        const move = result.moves.find((m) => range.head >= m.from && range.head <= m.to);
        if (move) return EditorSelection.cursor(corrective.mapPos(move.landsAfter, 1));
      }
      return range.map(corrective);
    }),
    before.mainIndex
  );

  return {
    changes: tr.changes.compose(corrective),
    selection: after,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});
