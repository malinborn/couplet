import {
  CharCategory,
  EditorSelection,
  Prec,
  findClusterBreak,
  type EditorState,
  type Extension,
  type RangeSet,
} from '@codemirror/state';
import { keymap, type Command, type EditorView } from '@codemirror/view';
import { markupModelField, type HiddenMarkSpan } from './atomic';
import { isLiveRenderActive } from './inline-continuation';

/**
 * Live-render — **word-wise motion, selection and deletion across hidden
 * markers** (#73).
 *
 * ## The bug, and why `atomicRanges` could not have caught it
 *
 * `EditorView.atomicRanges` is consulted by `moveByChar`, `moveVertically`,
 * `MouseSelection` and `deleteBy`'s `skipAtomic` — but every one of them calls
 * `skipAtomicRanges`, and that function only moves a position that is
 * **strictly inside** a range (`pos > from && pos < to`). Group commands stop
 * *exactly at* a marker boundary, never inside one, so the atomic layer sees
 * nothing to fix. It normalises the caret; it has never had an opinion about
 * how far a word jump should go.
 *
 * What actually happens is one level up, in the group predicate. CM6 builds it
 * from the first character it moves over:
 *
 * ```js
 * function byGroup(view, pos, start) {
 *   let cat = categorize(start)
 *   return next => { …; return cat == categorize(next) }
 * }
 * ```
 *
 * From the **outer** offset of `Абзац с **жирным** словом.` (content 10..16,
 * closing marker 16..18) an Option+Left first moves over `*`, which categorises
 * as `Other`. The run therefore consists of the two asterisks and ends where
 * the letters begin. The caret travels from 18 to 16 — **two offsets and zero
 * pixels**, because the markers are painted at zero width. `deleteByGroup`
 * scans the same way and deletes exactly the closing `**`, which
 * `markup-repair.ts` then correctly writes straight back, making Option+Backspace
 * a complete no-op.
 *
 * Measured on `dev-preview` before this module existed:
 *
 * | caret | key | selection after | document |
 * |---|---|---|---|
 * | 18 | Option+Left | 16 | unchanged |
 * | 18 | Option+Backspace | 18 | **unchanged** |
 * | 18 | Shift+Option+Left | 16–18 | unchanged (an invisible selection) |
 * | 16 | Option+Delete | 16 | **unchanged** |
 * | 8 | Option+Right | 10 | unchanged |
 *
 * From the inner offset every one of them was already correct, which is the
 * whole shape of the report: press Left once and it starts working.
 *
 * **This bug predates the format-aware caret (#67) and was made findable by
 * it.** Before the caret had a shape, the two offsets were indistinguishable,
 * so "the shortcut sometimes doesn't work" had no observable cause and read as
 * flakiness. The feature that exposed it is the one that shows which offset you
 * are on.
 *
 * ## The fix
 *
 * Run the group scan over the text the user can **see**: step across any hidden
 * range before reading each character, so markers are never a group of their
 * own and never terminate somebody else's. That is the same rule
 * `markup-delete.ts` applies one character at a time ("delete the character
 * that is visually adjacent to the caret"), generalised from a character to a
 * group — which is why this lives beside it rather than inside `atomic.ts`.
 *
 * The set consulted is the full hidden `RangeSet`, not just emphasis pairs: a
 * link's `](url)`, a list bullet and a blockquote `>` are equally invisible and
 * equally wrong to treat as words.
 *
 * ## Why it hands back to CM6 whenever it can
 *
 * Every command here returns `false` unless a hidden range actually lies
 * between the caret and the destination. That is not an optimisation, it is how
 * bidirectional text keeps working: CM6's motion is *visual*
 * (`moveVisually`/`moveByChar`), while the scan below — like CM6's own
 * `deleteByGroup` — is in document order. The two agree on any single-direction
 * line and can disagree inside a bidi run, so the divergence is confined to the
 * lines that have the bug. On everything else the default command runs
 * untouched.
 */

/**
 * Step across every hidden range immediately adjacent to `pos` in the
 * direction of travel, landing on the offset the caret occupies *visually*.
 *
 * Loops because nested spans stack their markers: at the end of `***both***`
 * there are two closing markers between the caret and the last visible
 * character. The strictly-inside case is handled too, defensively — a caret
 * should never be there (that is `caretNormalizeFilter`'s job), but a scan that
 * started outside can reach it.
 */
function skipHidden(hidden: RangeSet<HiddenMarkSpan>, pos: number, forward: boolean): number {
  for (let guard = 0; guard < 16; guard++) {
    let moved = false;
    hidden.between(pos - 1, pos + 1, (from, to) => {
      const inside = pos > from && pos < to;
      const touching = forward ? from === pos : to === pos;
      if (!inside && !touching) return;
      const next = forward ? to : from;
      if (next !== pos) {
        pos = next;
        moved = true;
      }
    });
    if (!moved) break;
  }
  return pos;
}

/** Does any hidden range lie within `[from, to)`? The gate on taking a command over at all. */
export function hiddenInRange(state: EditorState, from: number, to: number): boolean {
  if (to <= from) return false;
  let found = false;
  state.field(markupModelField).hidden.between(from, to, (f, t) => {
    if (t > from && f < to) found = true;
  });
  return found;
}

/**
 * Where a word-wise jump from `pos` should land, counting only visible text.
 *
 * Deliberately mirrors `@codemirror/commands`' `deleteByGroup` loop — same
 * `charCategorizer`, same cluster breaks, same "a single leading space does not
 * start the run" rule — with one line added: `skipHidden` before each character
 * is read. Keeping the shape identical is the point; a re-derived word rule
 * would drift from the rest of the editor on the first unusual character.
 *
 * Two positions are tracked rather than one, and that separation is
 * load-bearing. `scanFrom` may sit on the far side of a marker run in order to
 * *read* the next character, while `landing` only ever advances when a visible
 * character is actually consumed. Collapsing them puts the caret on the wrong
 * side of an opening marker: walking left out of `**жирным**` reads the space
 * before the span (which ends the run) from offset 8, and would answer 8 —
 * outside the bold — where the user expects 10, inside it, which is also where
 * a click just before the word lands.
 */
export function visibleGroupTarget(state: EditorState, pos: number, forward: boolean): number {
  const { hidden } = state.field(markupModelField);
  const categorize = state.charCategorizer(pos);

  let landing = pos;
  let scanFrom = pos;
  let cat: CharCategory | null = null;
  let first = true;

  for (;;) {
    const scan = skipHidden(hidden, scanFrom, forward);
    const line = state.doc.lineAt(scan);

    if (scan === (forward ? line.to : line.from)) {
      // Nothing visible left on this line. If the key has not moved anything
      // yet, cross the line break rather than being a dead press — same
      // concession CM6's own group commands make.
      if (landing === pos && line.number !== (forward ? state.doc.lines : 1)) {
        landing = scan + (forward ? 1 : -1);
      }
      break;
    }

    const next = line.from + findClusterBreak(line.text, scan - line.from, forward);
    const ch = line.text.slice(
      Math.min(scan, next) - line.from,
      Math.max(scan, next) - line.from
    );
    const nextCat = categorize(ch);
    if (cat !== null && nextCat !== cat) break;
    // A single space at the very start of the jump is swallowed without
    // starting a run, so Option+Right from just after a word takes the space
    // *and* the word that follows it.
    if (ch !== ' ' || !first) cat = nextCat;
    first = false;

    scanFrom = next;
    landing = next;
  }

  return landing;
}

/**
 * Pull each end of a selection off a hidden marker that sits at the selection's
 * own boundary, so the range covers the **visible** text and nothing else.
 *
 * Without this, extending backward from the outer offset produces `[10, 18)` —
 * visually "жирным", but structurally "жирным" *plus its closing marker*. The
 * selection looks identical on screen and behaves differently the moment it is
 * used: typing over it deletes one marker, `markup-repair.ts` correctly
 * concludes the pair has nothing left to wrap, and the bold is gone. Measured:
 * selecting the word from the outer offset and typing `X` gave `Абзац с X
 * словом.`, while the same gesture one offset to the left gave
 * `Абзац с **X** словом.` That is exactly the "you had to know which offset you
 * were on" failure this issue is about, one step further along.
 *
 * Only the endpoints move, and only inward, so markers *interior* to a
 * selection are untouched — selecting across a whole span still replaces the
 * whole span. It is also idempotent: once an endpoint is off the marker there
 * is nothing left to skip, so a selection grown over several presses keeps its
 * anchor still.
 */
function shrinkToVisible(
  hidden: RangeSet<HiddenMarkSpan>,
  from: number,
  to: number
): { from: number; to: number } {
  if (to <= from) return { from, to };
  const start = skipHidden(hidden, from, true);
  const end = skipHidden(hidden, to, false);
  return end <= start ? { from, to } : { from: start, to: end };
}

/** The main range, when this module is entitled to answer for it at all. */
function soleEmptyRange(state: EditorState): { head: number; anchor: number } | null {
  if (!isLiveRenderActive(state)) return null;
  if (state.selection.ranges.length > 1) return null;
  const range = state.selection.main;
  return { head: range.head, anchor: range.anchor };
}

function wordMotion(forward: boolean, extend: boolean): Command {
  return (view: EditorView) => {
    const { state } = view;
    const range = soleEmptyRange(state);
    if (!range) return false;
    // A non-empty selection collapses to an edge under CM6's own rule, and that
    // rule needs no help from here.
    if (!extend && state.selection.main.from !== state.selection.main.to) return false;

    const target = visibleGroupTarget(state, range.head, forward);
    if (target === range.head) return false;
    if (!hiddenInRange(state, Math.min(range.head, target), Math.max(range.head, target))) {
      return false;
    }

    let selection;
    if (extend) {
      const { hidden } = state.field(markupModelField);
      const backwards = target < range.anchor;
      const shrunk = shrinkToVisible(
        hidden,
        Math.min(range.anchor, target),
        Math.max(range.anchor, target)
      );
      selection = backwards
        ? EditorSelection.range(shrunk.to, shrunk.from)
        : EditorSelection.range(shrunk.from, shrunk.to);
    } else {
      selection = EditorSelection.cursor(target);
    }

    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

function wordDelete(forward: boolean): Command {
  return (view: EditorView) => {
    const { state } = view;
    if (state.readOnly) return false;
    const range = soleEmptyRange(state);
    if (!range) return false;
    // Deleting a non-empty selection is not a word operation.
    if (state.selection.main.from !== state.selection.main.to) return false;

    const target = visibleGroupTarget(state, range.head, forward);
    if (target === range.head) return false;
    const from = Math.min(range.head, target);
    const to = Math.max(range.head, target);
    if (!hiddenInRange(state, from, to)) return false;

    // The range deliberately spans the markers it crosses rather than carving
    // around them. `markup-repair.ts` then decides what a half-emptied span
    // should become — the pair dies as a unit when nothing of its content
    // survives, and is written back next to what does — and
    // `markup-whitespace.ts` moves any whitespace the deletion stranded against
    // a marker back outside it. Re-deriving either of those judgements here
    // would be a second, quietly diverging copy of both.
    view.dispatch({
      changes: { from, to },
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    });
    return true;
  };
}

/**
 * `Prec.highest`, for the same reason `markupDeleteKeymap` carries it: the main
 * keymap (which contains `defaultKeymap`) is registered in `setup.ts` *before*
 * `previewCompartment`, and CM6 tries equal-precedence handlers in registration
 * order, so anything merely `high` here would still lose to the default group
 * commands.
 *
 * The `mac:` spellings mirror `defaultKeymap`'s exactly — Option on macOS,
 * Control elsewhere — so the same physical gesture is intercepted on every
 * platform rather than only on the one it was reported from.
 */
export const markupWordKeymap: Extension = Prec.highest(
  keymap.of([
    {
      key: 'Mod-ArrowLeft',
      mac: 'Alt-ArrowLeft',
      run: wordMotion(false, false),
      shift: wordMotion(false, true),
      preventDefault: true,
    },
    {
      key: 'Mod-ArrowRight',
      mac: 'Alt-ArrowRight',
      run: wordMotion(true, false),
      shift: wordMotion(true, true),
      preventDefault: true,
    },
    {
      key: 'Mod-Backspace',
      mac: 'Alt-Backspace',
      run: wordDelete(false),
      preventDefault: true,
    },
    {
      key: 'Mod-Delete',
      mac: 'Alt-Delete',
      run: wordDelete(true),
      preventDefault: true,
    },
  ])
);
