import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * Where the `[[` picker is (file-links D5): pure, so the live-render
 * inspector can stay out of the picker's way without importing the picker.
 */

/** `[[` and what follows it on the line, up to the caret — no bracket, no line break. */
const TRIGGER = /\[\[([^[\]\n]*)$/;

/** Where a `[[` is text, not a picker (Q8). */
const NO_PICKER = new Set([
  'InlineCode',
  'CodeText',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
  'URL',
  'Autolink',
]);

export interface LinkQuery {
  /** Start of `[[`. */
  from: number;
  /** The caret, or past a trailing `]]` (`closeBrackets` turns `[[` into `[[|]]`). */
  to: number;
  query: string;
}

/**
 * May a picker start at `pos` (Q8)? Markdown is the language there, and it is
 * not inside code, an HTML block or a link's URL. Also decides where `/link`
 * is offered: it would insert `[[]]` exactly here.
 */
export function pickerAllowedAt(state: EditorState, pos: number): boolean {
  if (!markdownLanguage.isActiveAt(state, pos, 1)) return false;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (NO_PICKER.has(node.name)) return false;
  }
  return true;
}

/**
 * Where a dropped link may land (file-links D7): never inside or touching
 * code, an HTML block, a table or a link (its text, URL or brackets). Both
 * sides of `pos` are checked: `[x](y)` typed at a row's start becomes part
 * of the table, after a closing fence it turns the fence into text, inside a
 * URL it breaks the link. Stricter than the `[[` picker on purpose — a drop
 * cannot be taken back with the next keystroke the way a typed `[[` can.
 */
const NO_LINK_DROP = new Set([...NO_PICKER, 'Table', 'Link', 'Image', 'LinkMark']);

/**
 * A blank line right under one of these is not a free line: GFM continues a
 * table with the next non-blank line, and HTML blocks (kinds 6/7) end only at
 * a blank line, so text written there joins the block.
 */
const ABSORBS_NEXT_LINE = new Set(['Table', 'HTMLBlock', 'CommentBlock']);

function insideAny(tree: Tree, pos: number, side: -1 | 1, names: ReadonlySet<string>): boolean {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
    if (names.has(node.name)) return true;
  }
  return false;
}

export function linkDropAllowedAt(state: EditorState, pos: number): boolean {
  const end = Math.min(state.doc.length, pos + 1);
  // A state built on the spot may have no tree yet (CLAUDE.md).
  const tree = ensureSyntaxTree(state, end, 50) ?? syntaxTree(state);
  for (const side of [-1, 1] as const) {
    if (!markdownLanguage.isActiveAt(state, pos, side)) return false;
    if (insideAny(tree, pos, side, NO_LINK_DROP)) return false;
  }
  const line = state.doc.lineAt(pos);
  if (line.number > 1 && line.text.trim() === '') {
    const above = state.doc.line(line.number - 1);
    if (insideAny(tree, above.to, -1, ABSORBS_NEXT_LINE)) return false;
  }
  return true;
}

export function linkQueryAt(state: EditorState, pos: number): LinkQuery | null {
  const line = state.doc.lineAt(pos);
  const match = TRIGGER.exec(state.sliceDoc(line.from, pos));
  if (!match) return null;
  const from = pos - match[0].length;
  if (!pickerAllowedAt(state, from)) return null;
  const to = state.sliceDoc(pos, pos + 2) === ']]' ? pos + 2 : pos;
  return { from, to, query: match[1] };
}
