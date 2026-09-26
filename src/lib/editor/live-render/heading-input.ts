import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import type { EditorState, Extension, TransactionSpec } from '@codemirror/state';
import { isLiveRenderActive } from './inline-continuation';

/**
 * A run of one to six `#` and nothing else — an ATX heading marker so far —
 * optionally behind a blockquote prefix, since a heading inside a quote is
 * rendered too (`> ## h`).
 */
const HEADING_RUN = /^(?:[ \t]*>[ \t]?)*#{1,6}$/;

/**
 * `#` alone is not a heading: CommonMark needs whitespace after the run, so
 * typing `#` and going straight into the text produced the literal `#привет`.
 * In live-render that is invisible as a mistake — the line simply refuses to
 * become a heading and there is no markup on screen to explain why.
 *
 * So the space is supplied on the first character that is not a `#`. Typing
 * more `#` still works, which is the point: the run has to stay open long
 * enough to choose a level.
 *
 * Returns null when it does not apply, and the caller falls through to the
 * normal insertion.
 */
export function headingSpaceRedirect(
  state: EditorState,
  from: number,
  to: number,
  insert: string
): TransactionSpec | null {
  if (from !== to) return null;
  // One character at a time. A paste or an IME commit is not someone building
  // up a heading marker, and rewriting it would be a surprise.
  if (Array.from(insert).length !== 1) return null;
  // `#` extends the run; whitespace already does the job by itself.
  if (insert === '#' || /^\s$/.test(insert)) return null;

  const line = state.doc.lineAt(from);
  if (!HEADING_RUN.test(line.text.slice(0, from - line.from))) return null;

  // Already separated — the run is a heading marker and the caret sits before
  // its space. Adding another would just push the text along.
  if (/^[ \t]/.test(line.text.slice(from - line.from))) return null;

  return {
    changes: { from, to, insert: ` ${insert}` },
    selection: EditorSelection.cursor(from + 1 + insert.length),
    userEvent: 'input.type',
  };
}

export function headingSpaceInput(): Extension {
  return EditorView.inputHandler.of((view, from, to, insert) => {
    if (!isLiveRenderActive(view.state)) return false;
    const spec = headingSpaceRedirect(view.state, from, to, insert);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  });
}
