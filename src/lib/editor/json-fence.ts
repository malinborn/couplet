/**
 * Where the pretty-printed JSON lands (#47a).
 *
 * `json-format.ts` decides *what* the text becomes; this file decides *where*
 * it goes and what has to surround it. It is the single place both entry
 * points — the paste offer and the `Cmd+Shift+J` / menu command — build their
 * change from, so the two cannot drift.
 *
 * ## The decision
 *
 * Expanded JSON goes into a ```` ```json ```` fence whenever the document
 * around it is markdown that would otherwise render it.
 *
 * Bare pretty-printed JSON in a markdown document is not neutral text. Its
 * lines are indented by 4 or more spaces, its brackets read as link syntax
 * (`[` … `]` across lines — #51), and its blank-ish structure produces
 * paragraph breaks that were never in the data. The document ends up
 * displaying something that is not what the user pasted. A fence is the one
 * construct in markdown that means "these characters, exactly"; JSON is data,
 * and data is what a code block is for.
 *
 * The cost is one extra pair of lines in the source. That is visible, easily
 * deleted, and not silent — unlike the render damage it prevents.
 *
 * ## The three edge cases
 *
 * - **Already inside a fence.** No second fence. Nesting one fence inside
 *   another does not produce a nested block, it ends the outer one early, so
 *   the only safe answer is to re-indent in place. Detected structurally
 *   (`FencedCode` / `CodeBlock` ancestor), not by looking for backticks.
 * - **Not markdown at all.** A `.json` file opened in md-mini runs in code-file
 *   mode: the JSON language, no live preview, nothing to protect the text
 *   from. Fencing there would turn a valid JSON file into an invalid one. So
 *   the fence is conditional on markdown actually being the active language at
 *   that position.
 * - **Pasted mid-paragraph.** A fence has to own whole lines: an opening
 *   ```` ``` ```` with prose in front of it on the same line is not a fence at
 *   all. So when text precedes the JSON on its line, a newline is inserted
 *   before the fence, and when text follows it, a newline after. The prose
 *   keeps its characters and becomes its own paragraph. When only whitespace
 *   sits on either side, the replaced range is widened to swallow it instead,
 *   so no blank line is left behind.
 *
 * Undo is unaffected: the fence, the JSON and the added newlines are one
 * `insert` in one change in one transaction, so one `Cmd+Z` still puts the
 * document back exactly as it was.
 */

import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { analyzeJson } from './json-format';

/** The change to dispatch. `from`/`to` are current document coordinates. */
export interface JsonFormatPlan {
  from: number;
  to: number;
  insert: string;
  /** Whether the insert is wrapped in a ```json fence. Reported for tests. */
  fenced: boolean;
}

/**
 * Node names that mean "this position is already inside code".
 *
 * `CodeText` is listed as well as its parents because a resolve inside a fence
 * body lands on it directly, and an indented code block (`CodeBlock`) counts
 * too — text there is already displayed verbatim.
 */
const CODE_CONTEXT_NODES = new Set(['FencedCode', 'CodeBlock', 'CodeText']);

/**
 * True when a fence should be added around JSON inserted at `pos`.
 *
 * Two independent reasons to say no, in the order they are cheapest to check.
 */
export function shouldFenceAt(state: EditorState, pos: number): boolean {
  // Code-file mode (a .json file), or env mode, or the body of a fence whose
  // info string named a language that has been loaded — in all of those the
  // active language at `pos` is not markdown.
  if (!markdownLanguage.isActiveAt(state, pos, 1)) return false;

  // A fence with no info string, or one whose language has not loaded yet,
  // still parses as markdown inside. Catch it structurally.
  let node: SyntaxNode | null = syntaxTree(state).resolve(pos, 1);
  while (node) {
    if (CODE_CONTEXT_NODES.has(node.name)) return false;
    node = node.parent;
  }
  return true;
}

/**
 * Build the change that formats the JSON in `[from, to)`, or `null` when there
 * is nothing to do.
 *
 * `null` covers every "the button would do nothing" case at once: the text is
 * not JSON, or it is JSON that is already expanded *and* already in the right
 * place. The second half is why this returns a whole plan rather than a
 * string — already-pretty JSON sitting bare in a markdown paragraph still has
 * something worth changing, and the old text-only check could not see it.
 */
export function planJsonFormat(
  state: EditorState,
  from: number,
  to: number
): JsonFormatPlan | null {
  const text = state.sliceDoc(from, to);
  const analysis = analyzeJson(text);
  if (!analysis) return null;

  // The offer range routinely over-reaches — a paste lands against a newline,
  // a hand-made selection swallows one. Work on the trimmed span.
  const start = from + (text.length - text.trimStart().length);
  const end = to - (text.length - text.trimEnd().length);

  if (!shouldFenceAt(state, start)) {
    return analysis.alreadyFormatted
      ? null
      : { from: start, to: end, insert: analysis.formatted, fenced: false };
  }

  const doc = state.doc;
  const startLine = doc.lineAt(start);
  const endLine = doc.lineAt(end);

  // Whitespace-only on the line before the JSON: swallow it, so the fence
  // starts at column 0 instead of leaving an indented stub behind. Real text
  // before it: keep the text, push the fence onto its own line.
  const leading = doc.sliceString(startLine.from, start).trim() === '';
  const planFrom = leading ? startLine.from : start;
  const prefix = leading ? '' : '\n';

  const trailing = doc.sliceString(end, endLine.to).trim() === '';
  const planTo = trailing ? endLine.to : end;
  const suffix = trailing ? '' : '\n';

  const insert = `${prefix}\`\`\`json\n${analysis.formatted}\n\`\`\`${suffix}`;
  if (insert === doc.sliceString(planFrom, planTo)) return null;

  return { from: planFrom, to: planTo, insert, fenced: true };
}
