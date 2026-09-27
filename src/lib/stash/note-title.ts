/**
 * A note's title, exactly as Rust's `stash::notes::title_of` makes it (plan
 * D16): the stash shows Rust's, the tab card and the window title this one,
 * live. A line-for-line port, not a re-derivation — both suites read
 * `src-tauri/tests/fixtures/note-titles.json`, and a failing case means this
 * file drifted from `notes.rs`, never that the fixture is wrong.
 */

/** `TITLE_MAX_CHARS`: code points (`Array.from`), as Rust counts `char`s. */
export const NOTE_TITLE_MAX = 120;

/**
 * `LINE_PREFIXES`: stripped from the start of a non-heading line, repeatedly,
 * in this order (the task markers before the bare bullet they start with).
 * Nothing is trimmed between strips — `>  - x` keeps its `- `.
 */
const LINE_PREFIXES = ['> ', '- [ ] ', '- [x] ', '- [X] ', '- '] as const;

// Rust's `trim` is written to be exactly `String.prototype.trim`'s set (its
// `is_title_space`: `White_Space` minus U+0085, plus U+FEFF), so `.trim()` and
// `.trimEnd()` here are the port, not an approximation.

/** Nothing but whitespace: such a tab is still a blank new note. */
export function isBlankText(text: string): boolean {
  return text.trim() === '';
}

/**
 * `[start, end)` of the first non-blank line, split on `\n`. Walks line by
 * line and never splits the whole text: this runs on every keystroke. A
 * trailing `\r` stays in the span; `.trim()` drops it, as Rust's
 * `strip_suffix('\r')` + `trim` does.
 */
function firstLineSpan(text: string): [number, number] | null {
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(start, end).trim() !== '') return [start, end];
    if (nl === -1) return null;
    start = nl + 1;
  }
}

/**
 * `heading_text`: the text of an ATX heading (`#` to `######`, then a space, a
 * tab or the end of the line), without an optional closing `#` sequence.
 * `null` when `line` is not a heading — `#tag` and `#######` are ordinary text.
 */
function headingText(line: string): string | null {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === '#') hashes++;
  if (hashes === 0 || hashes > 6) return null;
  const rest = line.slice(hashes);
  if (rest !== '' && !rest.startsWith(' ') && !rest.startsWith('\t')) return null;
  const text = rest.trim();
  const withoutClosing = text.replace(/#+$/, '');
  if (withoutClosing === '') return '';
  // `# C#` keeps its `#`: a closing sequence must be separated by a space or
  // a tab (CommonMark), nothing else from the trim set — `# T #` keeps it.
  if (withoutClosing.endsWith(' ') || withoutClosing.endsWith('\t')) return withoutClosing.trim();
  return text;
}

/** `strip_line_prefixes`: literal prefixes only, first match wins, repeat. */
function stripLinePrefixes(line: string): string {
  let rest = line;
  strip: for (;;) {
    for (const prefix of LINE_PREFIXES) {
      if (rest.startsWith(prefix)) {
        rest = rest.slice(prefix.length);
        continue strip;
      }
    }
    return rest;
  }
}

/**
 * The display title of a note: its first line, a heading's text if that line
 * is one (then with NO prefix stripping), without markdown markers. `null` for
 * a note with nothing to show (the UI says «Без названия»).
 */
export function noteTitle(text: string): string | null {
  const span = firstLineSpan(text);
  if (span === null) return null;
  const line = text.slice(span[0], span[1]).trim();
  const raw = headingText(line) ?? stripLinePrefixes(line);
  const plain = raw.replace(/[*`]/g, '');
  const clipped = Array.from(plain.trim()).slice(0, NOTE_TITLE_MAX).join('');
  const title = clipped.trimEnd();
  return title === '' ? null : title;
}

/** What follows the first non-blank line — a note's body under its title. */
export function afterFirstLine(text: string): string {
  const span = firstLineSpan(text);
  return span === null ? '' : text.slice(span[1] + 1);
}
