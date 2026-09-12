import { foldEffect, unfoldEffect, foldedRanges } from '@codemirror/language';
import {
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { headingFoldRange } from './folding';

/**
 * Folds survive the Raw switch, because Raw is where people go to *look*.
 *
 * `foldedRanges` is a StateField of its own, so it outlives
 * `previewCompartment.reconfigure([])` — but the fold indicator lives on the
 * heading line decoration, which does not. In Raw the collapsed section
 * therefore looked simply gone, with nothing on screen saying why. Someone who
 * opened Raw to see the structure of their document instead saw a document
 * missing most of its body.
 *
 * Unfolding on the way in and refolding on the way out is the fix; the memory
 * of what was open has to be a StateField rather than a module variable so its
 * positions are mapped through any edit made while in Raw.
 */
class StashedFold extends RangeValue {
  eq(other: RangeValue): boolean {
    return other instanceof StashedFold;
  }
}

const stashedFold = new StashedFold();

const setFoldStash = StateEffect.define<readonly { from: number; to: number }[]>();
const clearFoldStash = StateEffect.define<null>();

export const foldStashField = StateField.define<RangeSet<StashedFold>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setFoldStash)) {
        value = RangeSet.of(
          effect.value.map((r) => stashedFold.range(r.from, r.to)),
          true
        );
      } else if (effect.is(clearFoldStash)) {
        value = RangeSet.empty;
      }
    }
    return value;
  },
});

/** Ranges currently in the stash, oldest-first. Exposed for tests. */
export function stashedFolds(state: EditorState): { from: number; to: number }[] {
  const field = state.field(foldStashField, false);
  if (!field) return [];
  const out: { from: number; to: number }[] = [];
  field.between(0, state.doc.length, (from, to) => {
    out.push({ from, to });
  });
  return out;
}

/**
 * Effects that unfold everything and remember what was open. Empty when
 * nothing is folded — which also means a second call cannot overwrite a live
 * stash with an empty one, and `applyPreviewConfig` does re-run for reasons
 * unrelated to the engine.
 */
export function foldSuspendEffects(state: EditorState): StateEffect<unknown>[] {
  const ranges: { from: number; to: number }[] = [];
  const effects: StateEffect<unknown>[] = [];

  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    ranges.push({ from, to });
    effects.push(unfoldEffect.of({ from, to }));
  });

  if (ranges.length === 0) return [];
  return [...effects, setFoldStash.of(ranges)];
}

/**
 * Effects that refold whatever was stashed and clear the stash either way.
 *
 * The stashed `to` is deliberately discarded: the section may have grown or
 * shrunk while the user was in Raw, so the extent is re-derived from the
 * heading. `headingFoldRange` rather than `foldable` — the latter answers for
 * every registered fold service, so deleting a heading in Raw and coming back
 * refolded whatever construct the orphaned position happened to land in.
 */
export function foldRestoreEffects(state: EditorState): StateEffect<unknown>[] {
  const stash = state.field(foldStashField, false);
  if (!stash || stash.size === 0) return [];

  const doc = state.doc;
  const effects: StateEffect<unknown>[] = [clearFoldStash.of(null)];
  const seenLines = new Set<number>();

  stash.between(0, doc.length, (from) => {
    const line = doc.lineAt(Math.min(from, doc.length));
    if (seenLines.has(line.number)) return;
    seenLines.add(line.number);

    const range = headingFoldRange(state, line.from, line.to);
    if (range && range.from < range.to) effects.push(foldEffect.of(range));
  });

  return effects;
}

/** Entering Raw: drop every fold, remembering it. */
export function stashAndUnfoldAll(view: EditorView): void {
  const effects = foldSuspendEffects(view.state);
  if (effects.length > 0) view.dispatch({ effects });
}

/** Leaving Raw: put the remembered folds back. */
export function restoreStashedFolds(view: EditorView): void {
  const effects = foldRestoreEffects(view.state);
  if (effects.length > 0) view.dispatch({ effects });
}

export const foldMemory: Extension = foldStashField;
