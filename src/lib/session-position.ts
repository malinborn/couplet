/**
 * Clamps for a restored caret and scroll line.
 *
 * A session can outlive the file it points at: the document may have been edited
 * or truncated on disk while couplet was closed, so stored offsets are only
 * hints. CodeMirror's `doc.line()` is 1-based and throws on 0.
 */

export function clampCursor(cursor: number, docLength: number): number {
  if (!Number.isFinite(cursor) || cursor < 0) return 0;
  return Math.min(cursor, docLength);
}

export function clampTopLine(topLine: number, docLines: number): number {
  if (!Number.isFinite(topLine) || topLine < 1) return 1;
  return Math.min(topLine, Math.max(1, docLines));
}
