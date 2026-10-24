import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { evaluate, isSpace, MAX_EXPRESSION_LENGTH, type MathResult } from './evaluate';
import { formatResult } from './format';

/** An answer to offer: what Tab replaces (`eq`..`pos`) and with what. */
export interface Candidate {
  /** Right after the `=`. */
  eq: number;
  /** The caret, after any spaces typed past the `=`. */
  pos: number;
  /** The formatted answer, without a leading space. */
  answer: string;
}

/** `expr =` with only spaces after it; group 1 is everything before the last `=`. */
const ENDS_WITH_EQUALS = /^([\s\S]*)=( *)$/;
/** `a == b`, `x >= 3`, `x <= 3`, `a != b` are statements, not questions. */
const COMPARISON_BEFORE = /[=<>!]$/;
/**
 * Indentation, quote markers, then a heading or a list marker (with an
 * optional task box). Without this, `- 5 + 3 =` reads as minus five.
 * `-5` (no space) stays a sign, as markdown itself reads it.
 */
const BLOCK_PREFIX =
  /^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
/**
 * Characters an expression may contain — the scan back stops at the first
 * other one. U+00A0 / U+202F are thousands separators (`evaluate`).
 */
const EXPRESSION_CHAR = /[0-9   .,+\-*/^%()×·÷−–]/;
/** Syntax nodes inside which `=` is never a question. */
const EXCLUDED_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'Table']);
/** Parse budget for the caret's line, ms — a typing-time call. */
const PARSE_BUDGET_MS = 50;

function insideExcludedNode(state: EditorState, pos: number, lineTo: number): boolean {
  const tree = ensureSyntaxTree(state, lineTo, PARSE_BUDGET_MS) ?? syntaxTree(state);
  // Side 1: the node that holds the `=` character itself (`pos` is its start).
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (EXCLUDED_NODES.has(node.name)) return true;
  }
  return false;
}

/**
 * May an expression start at `from`? Not inside a word or a number: the
 * character before must not be a digit, `.`, `,`, a letter or a non-ASCII
 * space (`1e5`, `0x10`, `v1.2.3`, `.5`, `1 5000` all stay unanswered rather
 * than answered for their tail). And not right after a number with only
 * spaces between (`12 34 + 1`, `1 5000 + 1`): that is two adjacent numbers,
 * which `evaluate` already refused as a whole.
 */
function atTokenBoundary(text: string, from: number): boolean {
  const before = text[from - 1];
  if (before === undefined) return true;
  if (/[0-9.,\p{L}]/u.test(before)) return false;
  if (before > '\u007f' && /\s/.test(before)) return false;
  let i = from - 1;
  while (i >= 0 && isSpace(text[i])) i--;
  return !/[0-9]/.test(text[i] ?? '');
}

/**
 * The longest suffix of `text` made of expression characters that evaluates,
 * shrunk from the left until it does (`шаг 2) (3+4)` → `(3+4)`), trying only
 * starts at a token boundary. A run longer than `MAX_EXPRESSION_LENGTH` (not
 * counting spaces at its ends) is no answer at all, never its last part — and
 * the scan back stops there, so a huge line costs no more than a short one.
 */
function longestExpression(text: string): MathResult | null {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1])) end--;
  let start = end;
  while (start > 0 && EXPRESSION_CHAR.test(text[start - 1])) {
    start--;
    if (!isSpace(text[start]) && end - start > MAX_EXPRESSION_LENGTH) return null;
  }
  for (let from = start; from < end; from++) {
    if (isSpace(text[from]) || !atTokenBoundary(text, from)) continue;
    const result = evaluate(text.slice(from, end));
    if (result) return result;
  }
  return null;
}

/**
 * Is there a question `expr =` ending at `pos` (spaces after `=` allowed),
 * with nothing to its right on the line, outside code and tables, in a
 * markdown document? The rules are the spec's "When the ghost appears".
 */
export function findExpression(state: EditorState, pos: number): Candidate | null {
  if (state.facet(language)?.name !== 'markdown') return null;
  const line = state.doc.lineAt(pos);
  if (line.text.slice(pos - line.from).trim() !== '') return null;

  const match = ENDS_WITH_EQUALS.exec(line.text.slice(0, pos - line.from));
  if (!match) return null;
  const head = match[1];
  if (COMPARISON_BEFORE.test(head)) return null;

  const eq = line.from + head.length + 1;
  if (insideExcludedNode(state, eq - 1, line.to)) return null;

  const result = longestExpression(head.replace(BLOCK_PREFIX, ''));
  if (!result) return null;
  const answer = formatResult(result.value, result.style);
  return answer === null ? null : { eq, pos, answer };
}
