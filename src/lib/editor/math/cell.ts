import { evaluate, parseNumberLiteral, type MathResult } from './evaluate';
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

/** Thousands spaces in a stored answer: plain, no-break and narrow no-break. */
const SPACES = /[ \u00A0\u202F]/g;

/**
 * A stored answer as text to compare: spaces dropped, then trailing fraction
 * zeros and a then-bare separator (`439.40` → `439.4`, `3 600` → `3600`).
 * Nothing else — a leading zero, `-0` or a sign stay as written.
 */
function normaliseStored(text: string): string {
  const plain = text.replace(SPACES, '');
  return /[.,]/.test(plain) ? plain.replace(/0+$/, '').replace(/[.,]$/, '') : plain;
}

/**
 * The value of a cell (or cell-editor text) that is exactly `<expr> =`, with
 * optional spaces around. Strict on purpose, unlike the ghost's trigger: no
 * prose before the expression, no block prefix to cut, no longest-suffix
 * search — `Итого 5 + 3 =` is not one. A leading `- ` is a unary minus: a cell
 * has no list syntax.
 */
function evaluateQuestion(text: string): MathResult | null {
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
 * `<number>` must be one literal as `evaluate` reads them (valid thousands
 * groups, one separator, a leading `-`). Then **text** is compared, never a
 * rounded value: the stored number, with spaces and trailing fraction zeros
 * dropped, must equal what Tab would write minus its thousands spaces. So
 * `= 3600` for `3 600` and `= 439.40` pass, and `99999999999.5` for
 * `99999999999`, `3.3333333333999`, `06` or `-0` do not — the marker means
 * "this is exactly our answer".
 *
 * The decimal separator: when the expression wrote a fraction (`1.5`, `1,5`)
 * its separator is the human's, and the answer must use it (`1.5 * 3 = 4,5`
 * stays text). Without one, either separator is accepted (`9 / 2 = 4,5`).
 * Pure.
 */
export function verifiedCell(text: string): VerifiedCell | null {
  const title = text.trim();
  const eq = title.lastIndexOf('=');
  if (eq < 0) return null;
  const answer = title.slice(eq + 1).trim();
  if (!parseNumberLiteral(answer)) return null;
  const computed = evaluateQuestion(title.slice(0, eq + 1));
  if (!computed) return null;
  const expected = formatResult(computed.value, {
    decimalComma: computed.style.decimalComma,
    thousandsSpace: false,
  });
  if (expected === null) return null;
  let stored = normaliseStored(answer);
  // No fraction in the expression: `formatResult` wrote `.`, the human may write `,`.
  if (!computed.fractional) stored = stored.replace(',', '.');
  return stored === expected ? { answer, title } : null;
}
