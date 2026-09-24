/**
 * Type-to-filter in the drawer (spec §6): file names first — the start of
 * the name, then anywhere in it — then text. Everything here is synchronous
 * over a precomputed index, so a keystroke never waits for a disk read.
 *
 * Case is folded with `toLowerCase` (Cyrillic included); letters are not —
 * `ё` does not match `е`, as in the mockup. A keystroke costs one pass over
 * every indexed line: O(total lines) `includes` calls, no parsing.
 */

/** A file's text, digested once per drawer opening. */
export interface SearchIndex {
  /** Non-empty plain lines, fence markers left out. */
  lines: readonly string[];
  /** `lines`, lowercased. */
  lower: readonly string[];
}

export interface FilterEntry {
  id: string;
  name: string;
  /** `null` while the tab's text has not been read yet: matched by name only. */
  index: SearchIndex | null;
}

export type Match = { rank: 0 } | { rank: 1 } | { rank: 2; line: string };

export interface Segment {
  text: string;
  hit: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const LINE_BREAK = /\r?\n/;

/** One markdown line as a reader sees it: markers gone, whitespace trimmed. */
export function plainLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+] \[[ xX]\] /, '')
    .replace(/^\s*(?:[-*+]|\d+\.) /, '')
    .replace(/^>\s?/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|~~|`|\*/g, '')
    .trim();
}

export function indexText(md: string): SearchIndex {
  const lines: string[] = [];
  let inCode = false;
  for (const raw of md.split(LINE_BREAK)) {
    if (FENCE.test(raw)) {
      inCode = !inCode;
      continue;
    }
    // Inside a fence `#` and `*` are code, not markup.
    const plain = inCode ? raw.trim() : plainLine(raw);
    if (plain) lines.push(plain);
  }
  return { lines, lower: lines.map((l) => l.toLowerCase()) };
}

export function matchEntry(entry: FilterEntry, query: string): Match | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const at = entry.name.toLowerCase().indexOf(q);
  if (at === 0) return { rank: 0 };
  if (at > 0) return { rank: 1 };
  if (!entry.index) return null;
  const i = entry.index.lower.findIndex((l) => l.includes(q));
  return i === -1 ? null : { rank: 2, line: entry.index.lines[i] };
}

/** Matching entries, best rank first; within a rank, in their current order. */
export function filterEntries(
  entries: readonly FilterEntry[],
  query: string
): { id: string; match: Match }[] {
  const hits: { id: string; match: Match; order: number }[] = [];
  entries.forEach((entry, order) => {
    const match = matchEntry(entry, query);
    if (match) hits.push({ id: entry.id, match, order });
  });
  hits.sort((a, b) => a.match.rank - b.match.rank || a.order - b.order);
  return hits.map(({ id, match }) => ({ id, match }));
}

/** `text` split into runs, the occurrences of `query` marked. */
export function highlight(text: string, query: string): Segment[] {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  // Lowercasing can change the length ('İ'); offsets into `lower` would then
  // cut `text` in the wrong places.
  if (!q || lower.length !== text.length) return [{ text, hit: false }];
  const out: Segment[] = [];
  let i = 0;
  for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
    if (j > i) out.push({ text: text.slice(i, j), hit: false });
    out.push({ text: text.slice(j, j + q.length), hit: true });
    i = j + q.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

/** Past this many characters a hit would be cut off by the card's edge. */
const SNIPPET_CUT_AFTER = 42;
/** How much of the line before the hit is kept once it is cut. */
const SNIPPET_LEAD = 24;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The line a text match is shown with, cut so the hit stays in view. */
export function hitSnippet(line: string, query: string): string {
  const j = line.toLowerCase().indexOf(query.toLowerCase());
  if (j <= SNIPPET_CUT_AFTER) return line;
  let from = j - SNIPPET_LEAD;
  if (isLowSurrogate(line.charCodeAt(from))) from += 1;
  return `…${line.slice(from)}`;
}
