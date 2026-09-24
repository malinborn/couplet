/**
 * Line endings at the disk boundary.
 *
 * CodeMirror 6 splits a document on `\r\n`, `\r` and `\n` alike and joins it
 * back with `\n` — so the editor only ever holds LF text, and any string that
 * still carries a `\r` is a different length from the document CM6 builds out
 * of it. That mismatch was the whole of the CRLF bug: `replaceContent` put the
 * caret at `content.length`, which lies past the end of the shorter document,
 * CM6 threw `RangeError: Selection points outside of document`, and the open
 * silently fell back to an empty Untitled window.
 *
 * The rule, therefore: text is normalized to LF exactly once, where it leaves
 * the disk (`readDocument` in `tauri/commands.ts`), and converted back to the
 * file's own ending exactly once, where it goes back (`writeDocument`).
 * Everything in between — the buffer, the disk baseline, the external-change
 * comparison, the diff an AI edit is applied through — speaks LF.
 */

export type LineEnding = 'lf' | 'crlf' | 'cr';

const SEPARATOR: Record<LineEnding, string> = {
  lf: '\n',
  crlf: '\r\n',
  cr: '\r',
};

/**
 * The line ending a file uses, or `fallback` when it has no line break at all.
 *
 * Mixed files resolve to the DOMINANT ending — the one with the most
 * occurrences — with ties going to whichever was seen first. Dominant rather
 * than first-seen because a mixed file is almost always a file of one kind
 * that picked up a few lines of the other (a paste, a patch from another
 * machine), and the first line is no more representative than any other.
 * The consequence is deliberate and worth knowing: the first save of a mixed
 * file makes it uniform, because the buffer holds no per-line record of which
 * ending each line had.
 *
 * `fallback` exists for text with no line break at all, which says nothing
 * about the file's convention. Opening one defaults to LF; re-reading one
 * after an external change keeps whatever the document already used, so a
 * CRLF file does not silently become LF just because it was briefly a single
 * line.
 */
export function detectLineEnding(text: string, fallback: LineEnding = 'lf'): LineEnding {
  const counts: Record<LineEnding, number> = { lf: 0, crlf: 0, cr: 0 };
  let first: LineEnding | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let kind: LineEnding;
    if (c === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10 /* \n */) {
        kind = 'crlf';
        i++;
      } else {
        kind = 'cr';
      }
    } else if (c === 10 /* \n */) {
      kind = 'lf';
    } else {
      continue;
    }
    counts[kind]++;
    first ??= kind;
  }
  if (first === null) return fallback;
  let best: LineEnding = first;
  for (const kind of ['lf', 'crlf', 'cr'] as const) {
    if (counts[kind] > counts[best]) best = kind;
  }
  return best;
}

/** `\r\n` and lone `\r` become `\n` — the only form CM6 holds. */
export function normalizeLineEndings(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * Convert LF text back to `ending`. Input is expected to be normalized (it is
 * the editor buffer); it is normalized again anyway, so a stray `\r` can never
 * turn into `\r\r\n`.
 */
export function applyLineEnding(text: string, ending: LineEnding): string {
  const lf = normalizeLineEndings(text);
  return ending === 'lf' ? lf : lf.replace(/\n/g, SEPARATOR[ending]);
}

/** A file's content as the editor wants it, plus what to write it back as. */
export interface DiskDocument {
  /** LF-only text. */
  text: string;
  lineEnding: LineEnding;
}

/** Split raw disk text into editor text and the ending to restore on save. */
export function fromDisk(raw: string, fallback: LineEnding = 'lf'): DiskDocument {
  return { text: normalizeLineEndings(raw), lineEnding: detectLineEnding(raw, fallback) };
}
