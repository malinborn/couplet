import { ChangeSet, Text, type EditorState } from '@codemirror/state';
import { computeChangedLineRanges, computeReplacement, type LineRange, type Replacement } from './editor/content-diff';
import { setAiHighlights, type AiHighlightRange } from './editor/ai-highlight';
import type { AiCommandPayload } from './tauri/events';

/**
 * Resolve the document position an `ai show` command should scroll to.
 *
 * `line` (1-based, per the socket protocol) wins over `find` when both are
 * present — the CLI only ever sends one, but the precedence keeps this total.
 * Neither given means "just focus the window", so it resolves to the top of
 * the document.
 */
export function resolveShowTarget(
  state: EditorState,
  target: Pick<AiCommandPayload, 'line' | 'find'>
): number | null {
  if (target.line !== null) {
    const clamped = Math.min(Math.max(target.line, 1), state.doc.lines);
    return state.doc.line(clamped).from;
  }
  if (target.find !== null) {
    const idx = state.doc.toString().indexOf(target.find);
    return idx === -1 ? null : idx;
  }
  return 0;
}

/**
 * 1-based inclusive line range the `edit` response reports as `changed_lines`,
 * covering the inserted span `[repl.from, repl.from + repl.insert.length)` in
 * the document that results from applying `repl` — `state` must already be
 * that post-change state, mirroring how the AI-highlight field reads effect
 * positions. A pure deletion (`insert` empty) has no span to cover, so it
 * reports the single line the deletion point now sits on.
 */
export function changedLineRanges(state: EditorState, repl: Replacement): [number, number] {
  const start = state.doc.lineAt(repl.from).number;
  if (repl.insert.length === 0) {
    return [start, start];
  }
  // endPos is just past the inserted text; back up one character so a trailing
  // newline in the insert doesn't roll the range onto the following,
  // untouched line.
  const endPos = repl.from + repl.insert.length;
  const end = state.doc.lineAt(endPos - 1).number;
  return [start, end];
}

/**
 * Document-coordinate spans for the 1-based inclusive `lineRanges`, resolved
 * against `doc` — which must be the *post-change* document, since AI-highlight
 * effect values are read in the transaction's end state.
 *
 * Out-of-range line numbers are clamped rather than thrown on: the ranges come
 * from a pure text diff, and a caller passing a doc that has since moved on
 * should degrade to a misplaced highlight, never to a crashed editor.
 */
export function docRangesForLineRanges(doc: Text, lineRanges: readonly LineRange[]): AiHighlightRange[] {
  const clamp = (n: number): number => Math.min(Math.max(n, 1), doc.lines);
  return lineRanges.map(([start, end]) => ({
    from: doc.line(clamp(start)).from,
    to: doc.line(clamp(end)).to,
  }));
}

/** An agent's `edit`, worked out against a state but not applied. */
export interface AiEdit {
  /** One coalescing span — keeps CM6's selection mapping and scroll intact. */
  changes: ChangeSet;
  /** Where the change starts, in the resulting document: where `show` puts the caret. */
  from: number;
  /** One highlight per changed region, in the resulting document (issue #27). */
  highlights: AiHighlightRange[];
  /** 1-based inclusive `changed_lines` for the response. */
  changedLines: LineRange[];
}

/** `null` when `newContent` is what `state` already holds. */
export function buildAiEdit(state: EditorState, newContent: string): AiEdit | null {
  const oldContent = state.doc.toString();
  const repl = computeReplacement(oldContent, newContent);
  if (!repl) return null;
  const changes = ChangeSet.of(repl, state.doc.length);
  // Positions must be post-change: the highlight field reads effect values in
  // the end state — hence the diff runs against `newContent`.
  const lineRanges = computeChangedLineRanges(oldContent, newContent);
  const highlights = docRangesForLineRanges(Text.of(newContent.split('\n')), lineRanges);
  // A pure deletion produces no new lines to report: the single span's line.
  const changedLines =
    lineRanges.length > 0 ? lineRanges : [changedLineRanges(state.update({ changes }).state, repl)];
  return { changes, from: repl.from, highlights, changedLines };
}

/**
 * `buildAiEdit` applied to a state with no view — a background tab's. An
 * ordinary undoable transaction carrying the highlight, so both are there
 * when the tab is shown; with `show` the caret moves to the change.
 */
export function applyAiEditToState(
  state: EditorState,
  newContent: string,
  show: boolean
): { state: EditorState; result: AiEdit } | null {
  const edit = buildAiEdit(state, newContent);
  if (!edit) return null;
  const next = state.update({
    changes: edit.changes,
    ...(show ? { selection: { anchor: edit.from } } : {}),
    effects: setAiHighlights.of(edit.highlights),
  }).state;
  return { state: next, result: edit };
}
