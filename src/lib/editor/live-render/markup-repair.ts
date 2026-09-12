import { EditorState, Transaction, type ChangeSet, type ChangeSpec } from '@codemirror/state';
import { markupModelField, type MarkupPair } from './atomic';

/**
 * Live-render's markup-repair layer.
 *
 * `atomic.ts` normalises the **caret**; nothing there looks at `tr.changes`.
 * That is the whole gap behind issue #32: the caret always sits in a legal
 * position, and an edit from that legal position still tears a marker pair in
 * half. `skipAtomic` widening a deletion over a whole `**` is *correct* as
 * caret policy and is exactly what corrupts the source.
 *
 * So this module enforces one invariant, at the only point every edit passes
 * through: **after any transaction, every marker pair that survives is still a
 * pair.** It is deliberately not a second place that guesses what the user
 * meant — `markup-delete.ts` owns intent for Backspace/Delete, where intent is
 * knowable from the key. Here we only ever repair the *result*.
 *
 * ### Distinguishing the two deletion cases
 *
 * §5.1 of the spec names the trap: a naive "markers may not be deleted" rule
 * blocks deleting a bold word entirely. The discriminator this module uses is
 * not the user event but the change's own shape, per pair:
 *
 * - the change touches **both** markers of a pair → the user is removing the
 *   whole span (select-and-delete, select-and-replace, whole-document rewrite).
 *   Nothing to repair; the pair is gone as a unit.
 * - the change touches **exactly one** marker → the pair was torn. Repair.
 *
 * And when a pair is torn, what is restored is decided by what *survives*, not
 * by what was intended: if content remains on the surviving side, the missing
 * marker is written back next to it (the surviving text keeps its formatting);
 * if nothing remains, the surviving marker is deleted too (the pair dies as a
 * unit rather than leaving `****` in the file).
 *
 * ### Why a transaction filter and not commands
 *
 * Edits reach the state from the keymap, from `applyDOMChange`, from paste,
 * from drag-and-drop, from `@codemirror/commands`' `deleteBy`, and from
 * `replaceSelection` in app code. The transaction is the only chokepoint. It is
 * also where `caretNormalizeFilter` already lives, so the two compose in a
 * documented order — see `liveRenderMarkupRepair` at the bottom.
 */

/** A change, in the coordinates of the document *before* the transaction. */
export interface PlainChange {
  from: number;
  to: number;
  insert: string;
}

/** How wide a pair is on screen — used to order nested repairs innermost-first. */
function span(pair: MarkupPair): number {
  return pair.closeTo - pair.openFrom;
}

function overlaps(from: number, to: number, a: number, b: number): boolean {
  return to > a && from < b;
}

/**
 * Repair one change against the pairs of the pre-edit document.
 *
 * Returns the change to apply instead, or `null` when the original is already
 * well-formed. Pure, and the only place the repair rules are written down.
 *
 * The deletion cases and the newline case are handled in one pass each because
 * a single change can be both (a multi-line paste over a selection that starts
 * inside one span and ends inside another).
 */
export function repairChange(pairs: readonly MarkupPair[], change: PlainChange): PlainChange | null {
  const isDeletion = change.to > change.from;
  const splitsLines = change.insert.includes('\n');
  if (!isDeletion && !splitsLines) return null;

  let from = change.from;
  let to = change.to;

  // Closing markers to write back before the inserted text, innermost first;
  // opening markers to write back after it, outermost first. Both orders matter
  // for nesting: `*a **b** c*` torn in the middle must come back as `**` then
  // `*`, not the reverse, or the rebuilt source nests wrong.
  let prefix = '';
  let suffix = '';

  // Extending the range over a surviving marker can bring a *further* pair into
  // the change (an outer span whose content just became empty), so the deletion
  // pass runs to a fixpoint. Four rounds is far past what real nesting reaches;
  // the bound exists so a pathological tree cannot spin here.
  for (let round = 0; round < 4; round++) {
    let grew = false;
    prefix = '';
    suffix = '';
    const closing: { text: string; span: number }[] = [];
    const opening: { text: string; span: number }[] = [];

    for (const pair of pairs) {
      const openHit = overlaps(from, to, pair.openFrom, pair.openTo);
      const closeHit = overlaps(from, to, pair.closeFrom, pair.closeTo);

      if (openHit && closeHit) continue; // the span is being removed whole

      if (!openHit && !closeHit) {
        // Neither marker is touched, but the content between them may be going
        // entirely — and an empty pair is not a pair. `****` parses as literal
        // text, so nothing hides it and four asterisks appear in a document the
        // user believes contains only prose. This is the case the delete keymap
        // cannot catch on its own: erasing a bold word one character at a time
        // ends with an ordinary deletion of the last content character, with no
        // marker anywhere near the caret.
        if (
          change.insert === '' &&
          to > from &&
          from <= pair.contentFrom &&
          to >= pair.contentTo
        ) {
          if (from > pair.openFrom || to < pair.closeTo) grew = true;
          from = Math.min(from, pair.openFrom);
          to = Math.max(to, pair.closeTo);
        }
        continue;
      }

      if (closeHit) {
        // The closing marker is going; the opening one survives. Take the
        // marker whole even if the change only clipped part of it, so no stray
        // half-marker is left behind.
        const nextFrom = Math.min(from, pair.closeFrom);
        const nextTo = Math.max(to, pair.closeTo);
        if (nextFrom !== from || nextTo !== to) grew = true;
        from = nextFrom;
        to = nextTo;
        if (from <= pair.contentFrom) {
          // Nothing of the content survives on the opening side — the pair dies
          // as a unit instead of leaving an orphaned `**`.
          if (from > pair.openFrom) grew = true;
          from = Math.min(from, pair.openFrom);
        } else {
          closing.push({ text: pair.closeText, span: span(pair) });
        }
      } else {
        const nextFrom = Math.min(from, pair.openFrom);
        const nextTo = Math.max(to, pair.openTo);
        if (nextFrom !== from || nextTo !== to) grew = true;
        from = nextFrom;
        to = nextTo;
        if (to >= pair.contentTo) {
          if (to < pair.closeTo) grew = true;
          to = Math.max(to, pair.closeTo);
        } else {
          opening.push({ text: pair.openText, span: span(pair) });
        }
      }
    }

    closing.sort((a, b) => a.span - b.span);
    opening.sort((a, b) => b.span - a.span);
    prefix = closing.map((c) => c.text).join('');
    suffix = opening.map((o) => o.text).join('');

    if (!grew) break;
  }

  if (splitsLines) {
    const split = splitAcrossLines(pairs, from, to, change.insert);
    from = split.from;
    to = split.to;
    prefix += split.prefix;
    suffix = split.suffix + suffix;
  }

  const insert = prefix + change.insert + suffix;
  if (from === change.from && to === change.to && insert === change.insert) return null;
  return { from, to, insert };
}

/**
 * A hidden marker pair cannot straddle a line break — `**жир\nным**` is not
 * bold, it is two lines of literal asterisks. So text carrying a newline into a
 * span closes it before the break and reopens it after: `**жир**` ⏎ `**ным**`.
 *
 * At the *edge* of the content there is nothing to keep formatted on that side,
 * so the insertion moves outside the span instead — closing and reopening there
 * would only produce an empty `****`.
 *
 * Nested spans are handled innermost-out, which is why this walks a sorted copy
 * and carries the position along: moving out of an inner span can land exactly
 * on an outer span's edge.
 */
function splitAcrossLines(
  pairs: readonly MarkupPair[],
  from: number,
  to: number,
  insert: string
): { from: number; to: number; prefix: string; suffix: string } {
  const enclosing = pairs
    .filter((p) => p.contentFrom <= from && to <= p.contentTo)
    .sort((a, b) => span(a) - span(b));

  let prefix = '';
  let suffix = '';
  let at = from;
  let end = to;

  for (const pair of enclosing) {
    if (at <= pair.contentFrom) {
      // At (or before) the content's start: step outside, left.
      if (at === end) at = end = pair.openFrom;
      continue;
    }
    if (end >= pair.contentTo) {
      if (at === end) at = end = pair.closeTo;
      continue;
    }
    prefix += pair.closeText;
    suffix = pair.openText + suffix;
  }

  return { from: at, to: end, prefix, suffix };
}

/**
 * Repair a whole `ChangeSet`. Returns a fresh `ChangeSpec[]` in pre-edit
 * coordinates, or `null` when nothing needed repairing.
 *
 * Working in pre-edit coordinates is what makes this composable at all: the
 * pairs are read from `tr.startState`, and every repaired range is expressed
 * against the same document, so the result is a plain array `changes()` can
 * resolve. Composing a second `ChangeSet` on top would need post-edit
 * coordinates and would have to map every pair through the very change being
 * repaired.
 */
export function repairChangeSet(
  pairs: readonly MarkupPair[],
  changes: ChangeSet
): ChangeSpec[] | null {
  const out: ChangeSpec[] = [];
  let repaired = false;

  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const original: PlainChange = { from: fromA, to: toA, insert: inserted.toString() };
    const fixed = repairChange(pairs, original);
    if (fixed) repaired = true;
    out.push(fixed ?? original);
  });

  return repaired ? out : null;
}

/**
 * The filter itself.
 *
 * Three things about its guards are load-bearing:
 *
 * - **Undo and redo are exempt.** History replays the *repaired* change's own
 *   inverse, which by construction restores a well-formed document — but that
 *   inverse deletes marker text this filter would read as "a pair being torn"
 *   and would then write the markers straight back, so undo would stop undoing.
 *   Measured: undo of a repaired Enter-inside-bold produced `**жир****ным**`
 *   before this guard existed.
 * - **It runs before `caretNormalizeFilter`.** CM6 applies transaction filters
 *   in reverse facet order, so being registered *after* it in `liveRenderAtomic`
 *   is what puts this one first. The caret is then normalised against the
 *   repaired document rather than the torn one.
 * - **It returns a plain spec, never a `Transaction`.** `filterTransaction`
 *   re-runs a returned `Transaction` through the whole chain; a spec is
 *   resolved with filtering off, so this cannot loop.
 */
export const markupRepairFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;

  const { pairs } = tr.startState.field(markupModelField);
  if (pairs.length === 0) return tr;

  const changes = repairChangeSet(pairs, tr.changes);
  if (!changes) return tr;

  // The selection is dropped on purpose rather than mapped: the repaired change
  // set has different lengths, so the transaction's own selection would land at
  // an offset that no longer means what it meant. `changes()` maps the current
  // selection through the new changes, which for every case here (a deletion, a
  // replacement, a line split) puts the caret at the end of what was inserted —
  // the same place the original transaction was aiming for.
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    changes: tr.startState.changes(changes),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent,
  };
});
