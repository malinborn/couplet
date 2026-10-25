import { evaluate, parseNumberLiteral, type NumberStyle } from './evaluate';
import { formatResult } from './format';

/**
 * A verified table cell: what the table widget shows in place of the cell's
 * text (`answer`, the stored number as written) and its tooltip (`title`).
 */
export interface VerifiedCell {
  answer: string;
  /** The cell's whole trimmed text — `338 * 1.3 = 439.4`. */
  title: string;
}

/**
 * Class on a table cell's text element while it shows a verified answer.
 * Code that maps rendered characters back to the source (the format toolbar,
 * the caret, ⌘F's cell highlights) checks it: the rendered text is the answer
 * alone, not the source.
 */
export const COMPUTED_CELL_CLASS = 'cm-md-cell-computed';

/** Characters that turn a trailing `=` into a comparison: `==`, `<=`, `>=`, `!=`. */
const COMPARISON = new Set(['=', '<', '>', '!']);

/** The style both sides of the comparison are formatted in — a style-free key. */
const PLAIN: NumberStyle = { decimalComma: false, thousandsSpace: false };

/**
 * The value of a cell (or cell-editor text) that is exactly `<expr> =`, with
 * optional spaces around. Strict on purpose, unlike the ghost's trigger: no
 * prose before the expression, no block prefix to cut, no longest-suffix
 * search — `Итого 5 + 3 =` is not one. A leading `- ` is a unary minus: a cell
 * has no list syntax.
 */
function evaluateQuestion(text: string): { value: number; style: NumberStyle } | null {
  const question = text.trim();
  if (!question.endsWith('=')) return null;
  const before = question.slice(0, -1);
  if (COMPARISON.has(before[before.length - 1] ?? '')) return null;
  return evaluate(before.trim());
}

/**
 * The answer the cell editor offers for `text` — the editor's text before the
 * caret — when it is exactly `<expr> =` + optional spaces: `338 * 1.3 =` →
 * `439.4`, in the input's number style. `null` when there is nothing to offer.
 * Pure.
 */
export function cellHint(text: string): string | null {
  const result = evaluateQuestion(text);
  return result ? formatResult(result.value, result.style) : null;
}

/**
 * A cell that is exactly `<expr> = <number>` whose number is our answer for
 * `<expr>`: the view shows the number with a marker; anything else stays text.
 *
 * Split on the last `=`. `<expr> =` follows {@link cellHint}'s strict rule;
 * `<number>` is one literal as `evaluate` reads them (thousands spaces, a
 * decimal comma, a leading `-`). The two are compared as **values at the
 * answer's precision**: both formatted by `formatResult` in one plain style
 * and compared as strings. So the human's own style and trailing zeros pass
 * (`= 3600` for `3 600`, `= 4.5` for `4,5`, `= 439.40`), float noise passes
 * (`0.1 + 0.2 = 0.3`), and anything else — a stale number, a hand-rounded one
 * (`10 / 3 = 3.33`) — does not: the marker means "this is exactly what Tab
 * would have written". Pure.
 */
export function verifiedCell(text: string): VerifiedCell | null {
  const title = text.trim();
  const eq = title.lastIndexOf('=');
  if (eq < 0) return null;
  const answer = title.slice(eq + 1).trim();
  const stored = parseNumberLiteral(answer);
  if (!stored) return null;
  const computed = evaluateQuestion(title.slice(0, eq + 1));
  if (!computed) return null;
  const expected = formatResult(computed.value, PLAIN);
  if (expected === null || formatResult(stored.value, PLAIN) !== expected) return null;
  return { answer, title };
}
