import { evaluate } from './evaluate';
import { formatResult } from './format';

/**
 * A computed table cell: what the table widget shows in place of the cell's
 * text (`answer`) and what it puts in the tooltip (`expression`).
 */
export interface ComputedCell {
  answer: string;
  /** The cell's trimmed text, `=` included — exactly what is stored. */
  expression: string;
}

/**
 * Class on a table cell's text element while it shows an answer. Code that
 * maps rendered characters back to the source (the format toolbar) checks it:
 * an answer's characters are not the source's.
 */
export const COMPUTED_CELL_CLASS = 'cm-md-cell-computed';

/** Characters that turn a trailing `=` into a comparison: `==`, `<=`, `>=`, `!=`. */
const COMPARISON = new Set(['=', '<', '>', '!']);

/**
 * The answer a table cell shows when its whole text is `<expr> =`.
 *
 * Strict on purpose, unlike the ghost's trigger: no prose before the
 * expression, no block prefix to cut, no longest-suffix search — `Итого 5 + 3 =`
 * stays text. Spaces (any `trim()` strips, the no-break ones included) may
 * follow the `=`. A leading `- ` is a unary minus: a cell has no list syntax.
 * `null` when the cell is not such an expression, or `evaluate`/`formatResult`
 * have no honest answer for it. Pure.
 */
export function computeCell(text: string): ComputedCell | null {
  const expression = text.trim();
  if (!expression.endsWith('=')) return null;
  const before = expression.slice(0, -1);
  if (COMPARISON.has(before[before.length - 1] ?? '')) return null;
  const result = evaluate(before.trim());
  if (!result) return null;
  const answer = formatResult(result.value, result.style);
  return answer === null ? null : { answer, expression };
}
