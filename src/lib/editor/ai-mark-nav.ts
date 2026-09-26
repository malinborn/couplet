import { EditorSelection, type EditorState, type StateEffect, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldedRanges, unfoldEffect } from '@codemirror/language';
import { aiHighlightRanges } from './ai-highlight';
import { aiCommentField, CommentWidget } from './ai-comment';
import { aiAskField } from './ai-ask';

/** Forwards (⌘') or backwards (⌘⇧'). */
export type AiMarkDirection = 1 | -1;

/**
 * Starts of the highlighted edits, one per run of spans.
 *
 * A single `couplet edit` often arrives as several spans that touch or overlap
 * — a changed word followed by a changed word. Reading them as one mark means
 * one ⌘' per edit, not one per fragment of it.
 */
function highlightStarts(state: EditorState): number[] {
  const ranges = aiHighlightRanges(state).sort((a, b) => a.from - b.from);
  const out: number[] = [];
  let end = -1;
  for (const { from, to } of ranges) {
    if (from > end) out.push(from);
    end = Math.max(end, to);
  }
  return out;
}

/**
 * One position per comment thread: where its anchored fragment starts, or,
 * with nothing left to anchor to, where its card is.
 *
 * The card sits at the end of the line, which for an anchored thread is the
 * wrong place to land — the fragment is what the comment is about. An anchor
 * disappears when its text is deleted (CM6 drops a mark mapped to zero width),
 * so "orphaned" here means "has no anchor in the field", not the
 * `CommentSpec.orphaned` flag alone.
 */
function commentStarts(state: EditorState): number[] {
  const set = state.field(aiCommentField, false);
  if (!set) return [];
  const anchors = new Map<string, number>();
  const cards = new Map<string, number>();
  set.between(0, state.doc.length, (from, to, value) => {
    const widget = (value.spec as { widget?: unknown }).widget;
    if (widget instanceof CommentWidget) {
      cards.set(widget.spec.thread.id, from);
      return;
    }
    const id = (value.spec as { threadId?: string }).threadId;
    if (id && to > from && !anchors.has(id)) anchors.set(id, from);
  });
  const out = [...anchors.values()];
  for (const [id, pos] of cards) if (!anchors.has(id)) out.push(pos);
  return out;
}

/** Every pending question's widget position. */
function askPositions(state: EditorState): number[] {
  const set = state.field(aiAskField, false);
  if (!set) return [];
  const out: number[] = [];
  set.between(0, state.doc.length, (from) => {
    out.push(from);
  });
  return out;
}

/**
 * Every place an AI left in the document, sorted, each position once.
 *
 * Built from the three fields on every call rather than cached: the fields
 * already map through every edit, so a copy could only ever be staler than
 * they are. Line washes and pulses are not marks — they repeat a span or fade
 * on their own — which is why highlights go through `aiHighlightRanges`.
 */
export function aiMarkPositions(state: EditorState): number[] {
  const all = new Set([...highlightStarts(state), ...commentStarts(state), ...askPositions(state)]);
  return [...all].sort((a, b) => a - b);
}

/**
 * The mark to jump to from the caret head, wrapping around the document.
 *
 * Strictly after (or before) the head, so a caret sitting on a mark moves on
 * to the next one instead of staying put. `null` when there are no marks.
 */
export function nextAiMark(state: EditorState, dir: AiMarkDirection): number | null {
  const marks = aiMarkPositions(state);
  if (marks.length === 0) return null;
  const head = state.selection.main.head;
  if (dir === 1) return marks.find((pos) => pos > head) ?? marks[0];
  // No `findLast`: the tsconfig lib is ES2020.
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i] < head) return marks[i];
  return marks[marks.length - 1];
}

/**
 * The transaction for a jump: collapse the caret onto the mark, open any fold
 * hiding it, scroll it to the middle of the screen. `null` with no marks.
 *
 * Built from the state alone so the test env, which has no DOM, can apply it.
 * CM6's `foldState` also drops a fold the new head lands in, but only as a
 * side effect of a selection change; unfolding explicitly keeps "the caret
 * never lands in hidden text" from resting on that detail.
 */
export function aiMarkJump(state: EditorState, dir: AiMarkDirection): TransactionSpec | null {
  const pos = nextAiMark(state, dir);
  if (pos === null) return null;
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (from < pos && pos < to) effects.push(unfoldEffect.of({ from, to }));
  });
  effects.push(EditorView.scrollIntoView(pos, { y: 'center' }));
  return { selection: EditorSelection.cursor(pos), effects, userEvent: 'select' };
}

/**
 * ⌘' / ⌘⇧' — driven by the native menu (`ai_next_mark` / `ai_prev_mark` in
 * `menu.rs`), not a CM6 keymap, so the keys also work while focus is in a
 * comment box. Focuses the editor for the same reason: the caret it just
 * moved should be the one that takes the next keystroke. Does nothing, and
 * says nothing, when there are no marks.
 */
export function gotoAiMark(view: EditorView, dir: AiMarkDirection): boolean {
  const spec = aiMarkJump(view.state, dir);
  if (!spec) return false;
  view.dispatch(spec);
  view.focus();
  return true;
}
