/**
 * The stash drawer's query (spec «Поиск → Язык запроса»: text, `#тег`, a
 * phrase in quotes — combined freely). Stage 04 matches by substring over the
 * title and the entry's preview, reusing the tabs drawer's ranking; stage 05
 * swaps `matchStashText` for `stash_search` (FTS5 trigram) and keeps the
 * parsing and the tag filter.
 */
import { matchEntry, type Match, type SearchIndex, type Segment } from '../tabs/drawer-filter';

/**
 * Rust's `TAG_MAX_CHARS` (`stash/entries.rs`), in characters. Plan D14 said
 * 40; any shorter than Rust would cut tags Rust stores (the agent CLI may set
 * up to 64), so the UI keeps Rust's limit instead.
 */
export const TAG_MAX = 64;

export interface StashQuery {
  /** Normalized tags (`normalizeTag`); each must match the start of a tag or the repo. */
  tags: string[];
  /** Everything else, lower-cased, single-spaced; phrases lose their quotes. */
  text: string;
}

/**
 * Rust's `char::is_whitespace` (Unicode White_Space) has U+0085, which JS `\s`
 * lacks; `\s`'s extra U+FEFF only turns into `-` here, never an error there.
 */
const EDGE_SPACE = /^[\s\u0085]+|[\s\u0085]+$/g;
const INNER_SPACE = /[\s\u0085]+/g;

/**
 * A tag as the stash stores it — Rust's `normalize_tag` (trim, leading `#`s
 * off, trim, lower-case) — plus what Rust refuses made acceptable instead:
 * inner spaces become `-`, and a tag over `TAG_MAX` characters is cut (by code
 * point, as Rust counts, so an emoji is never split). `null`: empty.
 */
export function normalizeTag(raw: string): string | null {
  const joined = raw
    .replace(EDGE_SPACE, '')
    .replace(/^#+/, '')
    .replace(EDGE_SPACE, '')
    .toLowerCase()
    .replace(INNER_SPACE, '-');
  const tag = Array.from(joined).slice(0, TAG_MAX).join('');
  return tag || null;
}

/** A phrase (closing quote optional — it is being typed) or a bare word. */
const TOKEN = /"([^"]*)"?|(\S+)/g;

export function parseStashQuery(raw: string): StashQuery {
  const tags: string[] = [];
  const words: string[] = [];
  for (const m of raw.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim();
      if (phrase) words.push(phrase);
      continue;
    }
    const word = m[2];
    if (word.startsWith('#')) {
      const tag = normalizeTag(word);
      if (tag) tags.push(tag);
    } else {
      words.push(word);
    }
  }
  return { tags, text: words.join(' ').toLowerCase() };
}

export interface StashCandidate {
  title: string;
  repo: string | null;
  tags: readonly string[];
  /** `indexText(entry.preview)`; `null`: title only. */
  index: SearchIndex | null;
}

/**
 * The text part alone — the one piece stage 05 replaces with `stash_search`
 * hits. The tabs drawer's ranks: title prefix 0, title substring 1, a line of
 * the preview 2 (with that line). `text` is non-empty and lower-cased.
 */
export function matchStashText(c: StashCandidate, text: string): Match | null {
  return matchEntry({ id: '', name: c.title, index: c.index }, text);
}

/**
 * `null`: filtered out. Every query tag must match the start of one of the
 * candidate's tags or its repo; then, with no text, `{ rank: 0 }` (the sort
 * decides), else `matchStashText`.
 */
export function matchStash(c: StashCandidate, q: StashQuery): Match | null {
  const all = c.repo ? [c.repo, ...c.tags] : c.tags;
  for (const tag of q.tags) {
    if (!all.some((t) => t.toLowerCase().startsWith(tag))) return null;
  }
  if (!q.text) return { rank: 0 };
  return matchStashText(c, q.text);
}

/*
 * The search query language (spec «Поиск»), mirrored from Rust
 * `stash::search::parse_query`. Both are held to
 * `src-tauri/tests/fixtures/stash-queries.json`: the drawer highlights with
 * this parse while Rust searches with its own, and the two must agree on what
 * a term is. Its `#tag` is Rust's exact stored tag, unlike `parseStashQuery`'s
 * prefix-over-tags-and-repo rule, which the drawer keeps on the client.
 */

/** FTS5's trigram tokenizer matches nothing for a string shorter than this. */
export const TRIGRAM_MIN = 3;

export interface SearchTerm {
  text: string;
  phrase: boolean;
}

export interface SearchQuery {
  /** As Rust's `normalize_tag` stores them, no duplicates, in order of appearance. */
  tags: string[];
  terms: SearchTerm[];
}

// Rust's `is_separator`. Not `\s`: JavaScript's `\s` and Rust's White_Space
// disagree (U+FEFF, U+0085), and the two parsers must split identically.
const SEPARATORS = new Set([' ', '\t', '\n', '\r', ' ', '　']);

function isSeparator(c: string): boolean {
  return SEPARATORS.has(c);
}

function trimSeparators(chars: string[]): string {
  let a = 0;
  let b = chars.length;
  while (a < b && isSeparator(chars[a])) a++;
  while (b > a && isSeparator(chars[b - 1])) b--;
  return chars.slice(a, b).join('');
}

// Rust's `str::trim` and `char::is_whitespace`: the Unicode White_Space
// property, which has U+0085 and lacks U+FEFF — both unlike `\s`.
const WS_EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
const WS_ANY = /\p{White_Space}/u;

/**
 * Rust's `entries::normalize_tag` returning `Ok(Some(_))`, else `null`: the
 * word stays a plain term (only `#`s, White_Space inside, or over `TAG_MAX`
 * code points), because as a tag it could match nothing and dropping it would
 * widen the result.
 */
function storedTag(word: string): string | null {
  const tag = word.replace(WS_EDGES, '').replace(/^#+/, '').replace(WS_EDGES, '');
  if (!tag || WS_ANY.test(tag) || [...tag].length > TAG_MAX) return null;
  return tag.toLowerCase();
}

export function parseSearchQuery(input: string): SearchQuery {
  // Code points, like Rust's chars: a surrogate pair is one element.
  const chars = [...input];
  const q: SearchQuery = { tags: [], terms: [] };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (isSeparator(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let end = i + 1;
      while (end < chars.length && chars[end] !== '"') end++;
      const phrase = trimSeparators(chars.slice(i + 1, end));
      if (phrase) q.terms.push({ text: phrase, phrase: true });
      // Past the closing quote; an unterminated phrase ran to the end.
      i = end + 1;
      continue;
    }
    const start = i;
    while (i < chars.length && !isSeparator(chars[i]) && chars[i] !== '"') i++;
    const word = chars.slice(start, i).join('');
    const tag = word.startsWith('#') ? storedTag(word) : null;
    if (tag === null) q.terms.push({ text: word, phrase: false });
    else if (!q.tags.includes(tag)) q.tags.push(tag);
  }
  return q;
}

/**
 * Only the text terms of `query`, as a query again — what the drawer sends to
 * `stash_search` while it filters tags itself. Rust re-parses it to the same
 * terms: a term never holds `"`, and a `#` word kept as a term here is one
 * Rust keeps as a term too.
 */
export function searchText(query: string): string {
  return parseSearchQuery(query)
    .terms.map((term) => (term.phrase ? `"${term.text}"` : term.text))
    .join(' ');
}

/** Long enough for trigrams; counted in code points, as Rust counts chars. */
export function isLongTerm(term: SearchTerm): boolean {
  return [...term.text].length >= TRIGRAM_MIN;
}

/** `text` split into runs, every occurrence of every term marked, overlaps merged. */
export function highlightTerms(text: string, terms: readonly SearchTerm[]): Segment[] {
  const lower = text.toLowerCase();
  // Lowercasing can change the length ('İ'); offsets into `lower` would then
  // cut `text` in the wrong places.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const needle = term.text.toLowerCase();
    if (!needle) continue;
    for (let j = lower.indexOf(needle); j !== -1; j = lower.indexOf(needle, j + needle.length)) {
      ranges.push([j, j + needle.length]);
    }
  }
  return segmentsFromRanges(text, ranges);
}

/**
 * `text` split into runs at `ranges` — `[from, to)` in UTF-16 units, the unit
 * Rust's `StashHit.ranges` are given in. Unsorted, overlapping and
 * out-of-range input is tolerated.
 */
export function segmentsFromRanges(text: string, ranges: readonly (readonly [number, number])[]): Segment[] {
  const clamp = (n: number): number => Math.max(0, Math.min(n, text.length));
  const sorted = ranges
    .map(([a, b]): [number, number] => [clamp(a), clamp(b)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let i = 0;
  for (const [a, b] of merged) {
    if (a > i) out.push({ text: text.slice(i, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    i = b;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}
