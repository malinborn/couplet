import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';

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

export function linkQueryAt(state: EditorState, pos: number): LinkQuery | null {
  const line = state.doc.lineAt(pos);
  const match = TRIGGER.exec(state.sliceDoc(line.from, pos));
  if (!match) return null;
  const from = pos - match[0].length;
  if (!markdownLanguage.isActiveAt(state, from, 1)) return null;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (NO_PICKER.has(node.name)) return null;
  }
  const to = state.sliceDoc(pos, pos + 2) === ']]' ? pos + 2 : pos;
  return { from, to, query: match[1] };
}
