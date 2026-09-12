/**
 * Where the pretty-printed JSON lands (#47a).
 *
 * `json-format.ts` decides *what* the text becomes; this file decides *where*
 * it goes and what has to surround it. It is the single place both entry
 * points — the paste offer and the `Cmd+Shift+J` / menu command — build their
 * change from, so the two cannot drift.
 *
 * ## The rule (the owner's, keyed on file type)
 *
 * | Buffer | Result |
 * |---|---|
 * | `.md`, `.markdown`, `.txt`, untitled | wrapped in a ```json fence |
 * | `.json` | bare, exactly as it formats today |
 * | anything else (`.py`, `.cs`, `.sh`, …) | bare — **never** a fence |
 *
 * The reasoning is the third row. Those files open as one big code block, so a
 * markdown fence is foreign to them — and worse than foreign: three backticks
 * written into a `.py` or `.cs` buffer is a syntax error inserted into valid
 * source code. The fence is therefore strictly opt-in for markdown-flavoured
 * buffers, never a default, and the check is the file type rather than
 * anything about the editor's current state.
 *
 * That last point is the reason this does not ask CodeMirror which language is
 * active. `Editor.svelte` loads a code language **asynchronously**, and for a
 * file whose extension matches no language it never reconfigures at all — in
 * both cases markdown is still the active language while a `.py` file sits on
 * screen. Asking the file type closes that window; asking the editor does not.
 *
 * ## Why a fence at all, in the buffers that get one
 *
 * Bare pretty-printed JSON in a markdown document is not neutral text. Its
 * lines are indented by 4 or more spaces, its brackets read as link syntax
 * (`[` … `]` across lines — #51), and its structure produces paragraph breaks
 * that were never in the data. The document ends up displaying something that
 * is not what the user pasted. A fence is the one construct in markdown that
 * means "these characters, exactly".
 *
 * ## The two calls still left to this file
 *
 * - **Already inside a fence.** No second fence. Nesting one fence inside
 *   another does not produce a nested block, it ends the outer one early, so
 *   the only safe answer is to re-indent in place. Detected structurally
 *   (`FencedCode` / `CodeBlock` ancestor), not by looking for backticks.
 * - **Pasted mid-paragraph.** A fence has to own whole lines: an opening
 *   ```` ``` ```` with prose in front of it on the same line is not a fence at
 *   all. So when text precedes the JSON on its line, a newline is inserted
 *   before the fence, and when text follows it, a newline after. The prose
 *   keeps its characters and becomes its own paragraph. When only whitespace
 *   sits on either side, the replaced range is widened to swallow it instead,
 *   so no blank line is left behind.
 *
 * Undo is unaffected in every branch of the rule: fenced or bare, the whole
 * result is one `insert` in one change in one transaction, so one `Cmd+Z` puts
 * the document back exactly as it was.
 */

import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { analyzeJson } from './json-format';
import { isMarkdownBuffer } from './file-language';

/** Point the editor state at the file it is showing. `null` is untitled. */
export const setDocumentPath = StateEffect.define<string | null>();

/**
 * The path of the file in this window, or `null` for an untitled buffer.
 *
 * A StateField rather than a prop because the fence decision is made inside a
 * CM6 `Command` (`Cmd+Shift+J`) and a `ViewPlugin` (the paste notifier), and
 * neither can be handed an extra argument.
 *
 * `Editor.svelte` installs it per window and keeps it current from
 * `fileState.filePath`, which covers open, save-as and new alike.
 */
export const documentPathField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDocumentPath)) return effect.value;
    }
    return value;
  },
});

/** Install the field. Appended per window in `Editor.svelte`. */
export const jsonDocumentPath: Extension = documentPathField;

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
 *
 * A state with no `documentPathField` reads as untitled, i.e. markdown. That is
 * right for the editor (`Editor.svelte` always installs it, and a window with
 * no file open genuinely is untitled) and it is the honest default for a plain
 * `EditorState` in a test — but it does mean the field, not an omission, is
 * what keeps a `.py` buffer safe.
 */
export function shouldFenceAt(state: EditorState, pos: number): boolean {
  if (!isMarkdownBuffer(state.field(documentPathField, false) ?? null)) return false;

  // Inside a fence already, or inside an indented code block. Structural, so a
  // fence with no info string counts the same as ```json.
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
