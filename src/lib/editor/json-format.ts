/**
 * Detecting and pretty-printing JSON (#30). Pure — no CM6, no DOM.
 *
 * The scenario is a JSON blob that lives in a database as one plain line and
 * arrives here through the clipboard. The re-indentation itself is
 * `json-reformat.ts`; everything below decides *whether to offer*, which is
 * the part that can be wrong in ways a user notices.
 *
 * Note what formatting is **not**: it is not `JSON.stringify(JSON.parse(s))`.
 * That round-trip silently rewrote every number through a JS double and threw
 * away duplicate keys — see #46 and the header of `json-reformat.ts`.
 */

import { reformatJson } from './json-reformat';

/**
 * Above this, we neither parse nor offer.
 *
 * Scanning a multi-megabyte string blocks the only thread the editor has, and
 * it would run on every single paste. The cap is generous enough for any log
 * line or database column and cheap to check.
 */
export const MAX_JSON_INPUT = 2_000_000;

export interface JsonAnalysis {
  /** The pretty-printed form, two-space indented. */
  formatted: string;
  /** Byte-for-byte identical to the trimmed input — nothing to offer. */
  alreadyFormatted: boolean;
  /** `object` or `array`; scalars are never candidates. See `analyzeJson`. */
  shape: 'object' | 'array';
}

/**
 * Decide whether a chunk of text is JSON worth offering to expand.
 *
 * The tight part is what gets rejected:
 *
 * - **Scalars.** `42`, `"hello"`, `true` and `null` are all valid JSON, and
 *   pretty-printing them does nothing. Worse, a pasted bare number would fire
 *   the offer constantly. Only objects and arrays qualify.
 * - **Text that merely contains JSON.** `see {"a":1} above` is not offered:
 *   the candidate must be JSON *end to end* after trimming. This is separate
 *   from the question of where the paste lands in the document — a pure-JSON
 *   paste into the middle of a markdown paragraph is still offered.
 * - **Already-expanded JSON.** Re-indenting it changes nothing, so the offer
 *   would be a toast with a button that does not do anything. (Where the
 *   result *lands* can still be worth changing — that is `json-fence.ts`'s
 *   question, not this one's.)
 *
 * Returns `null` when there is nothing to offer, for any of those reasons.
 */
export function analyzeJson(text: string): JsonAnalysis | null {
  if (text.length > MAX_JSON_INPUT) return null;

  const trimmed = text.trim();
  if (trimmed.length < 2) return null;

  // Cheap structural gate before the scanner: rejects prose, markdown and
  // scalars without paying for a scan on every keystroke-sized paste.
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const shape: 'object' | 'array' | null =
    first === '{' && last === '}' ? 'object' : first === '[' && last === ']' ? 'array' : null;
  if (shape === null) return null;

  const reformatted = reformatJson(trimmed);
  if (reformatted === null) return null;
  // The bracket gate above already implies this; keeping the check means the
  // two notions of "shape" can never quietly disagree.
  if (reformatted.shape !== shape) return null;

  return { formatted: reformatted.text, alreadyFormatted: reformatted.text === trimmed, shape };
}

/**
 * True when this text should raise the "expand it?" offer on paste.
 *
 * Split out from `analyzeJson` so the offer policy is one named thing rather
 * than a condition repeated at each call site.
 */
export function shouldOfferFormat(text: string): boolean {
  const analysis = analyzeJson(text);
  return analysis !== null && !analysis.alreadyFormatted;
}

/**
 * The pretty-printed replacement for a chunk of text, or `null` if it is not
 * JSON or is already expanded.
 *
 * Leading and trailing whitespace inside the range is dropped: the range came
 * either from a paste (whose own whitespace is not worth preserving) or from a
 * selection the user made by hand, which routinely over-reaches by a newline.
 */
export function formatJsonText(text: string): string | null {
  const analysis = analyzeJson(text);
  if (!analysis || analysis.alreadyFormatted) return null;
  return analysis.formatted;
}
