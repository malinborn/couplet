/**
 * The stash drawer's query (spec «Поиск → Язык запроса»: text, `#тег`, a
 * phrase in quotes — combined freely). Stage 04 matches by substring over the
 * title and the entry's preview, reusing the tabs drawer's ranking; stage 05
 * swaps `matchStashText` for `stash_search` (FTS5 trigram) and keeps the
 * parsing and the tag filter.
 */
import { matchEntry, type Match, type SearchIndex } from '../tabs/drawer-filter';

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
