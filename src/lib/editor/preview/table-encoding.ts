/** CRLF and lone CR -> LF. Textareas hand out LF already; this is defensive. */
function normalizeEol(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Trailing blank lines never survive into a cell — a row is one line. */
function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, '');
}

/**
 * The per-character half of the encoding: escaping and line joining, both of
 * which act on each character independently. Split out from `encodeForCommit`
 * so `encodedOffset` can encode a *prefix* and get an answer that agrees with
 * encoding the whole string — which the trailing-newline strip, the one
 * position-dependent step, would otherwise break.
 */
function encodeBody(value: string): string {
  return value.replace(/\|/g, '\\|').split('\n').join('<br>');
}

export function encodeForCommit(textareaValue: string): string {
  return encodeBody(stripTrailingNewlines(normalizeEol(textareaValue)));
}

export function decodeForEdit(cellText: string): string {
  return cellText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\\|/g, '|');
}

/**
 * Where `offset` in a textarea's value lands in `encodeForCommit(value)`.
 *
 * Needed by the comment button while a cell edit overlay is open (#60): the
 * comment anchors to a range in the *document*, so the overlay is committed
 * first and the selection has to be carried across the encoding. `|` becomes
 * two characters and a newline becomes four, so the offsets do not survive on
 * their own.
 *
 * Offsets past the trailing newlines the commit strips clamp to the end of
 * what actually got written.
 */
export function encodedOffset(textareaValue: string, offset: number): number {
  const body = stripTrailingNewlines(normalizeEol(textareaValue));
  const clamped = Math.max(0, Math.min(offset, body.length));
  return encodeBody(body.slice(0, clamped)).length;
}
