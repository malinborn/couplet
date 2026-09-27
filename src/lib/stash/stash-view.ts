/**
 * What the stash drawer shows (spec «Дровер тайника»): one flat list, no
 * sections; sorts «изменение · открытие · тип» (changed = the later of the
 * last edit and the last put-away, roadmap A9); an entry open as a tab in
 * THIS window is not shown (the drawers are a move, not two views of one
 * document). Pure.
 */
import type { Match, SearchIndex } from '../tabs/drawer-filter';
import { plural, t } from '../i18n';
import type { StashEntry, StashHit } from './types';
import { matchStash, parseStashQuery } from './stash-query';

export type StashSort = 'changed' | 'opened' | 'kind';

/**
 * The most cards the drawer renders; the rest are counted in a «ещё N» row. A
 * stash is years of notes, and a card is a heavy node — typing narrows the
 * list long before anyone scrolls past this many.
 */
export const STASH_RENDER_CAP = 200;

/** Rust's `changed_at` (`stash/entries.rs`): one meaning for the drawer and the agent. */
export function changedAt(e: StashEntry): number {
  return Math.max(e.modifiedAt, e.stashedAt ?? 0);
}

/**
 * Rust's last tie-break is `rowid`, newest row first; the client has no rowid,
 * but ids are `s<unix ms>-<salt>` (`stash/ids.rs`), so the later id is the
 * newer entry. Compared by code unit, not `localeCompare`: a total order.
 */
function byIdDesc(a: StashEntry, b: StashEntry): number {
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Rust's `sort_key`, descending, key by key. */
function compare(sort: StashSort, a: StashEntry, b: StashEntry): number {
  const changed = changedAt(b) - changedAt(a);
  switch (sort) {
    case 'changed':
      return changed || byIdDesc(a, b);
    case 'opened':
      return (b.openedAt ?? 0) - (a.openedAt ?? 0) || changed || byIdDesc(a, b);
    case 'kind':
      return (a.kind === b.kind ? 0 : a.kind === 'note' ? -1 : 1) || changed || byIdDesc(a, b);
  }
}

/** A note with no text-derived title reads «Без названия»; a file's title is its name (Rust). */
export function entryTitle(e: StashEntry, untitled: string): string {
  return e.title ?? untitled;
}

export interface ViewInput {
  entries: readonly StashEntry[];
  indexes: ReadonlyMap<string, SearchIndex>;
  /** Paths open as tabs in this window. */
  openHere: ReadonlySet<string>;
  repoChip: string | null;
  query: string;
  sort: StashSort;
  untitled: string;
  /**
   * `stash_search`'s answer for the query's text, in relevance order (stash
   * stage 05); `null` or absent: no text, or the search failed — the local
   * substring filter applies.
   */
  hits?: readonly StashHit[] | null;
}

export interface ViewRow {
  entry: StashEntry;
  match: Match;
  /** The search hit this row came from; `null` on the local path. */
  hit: StashHit | null;
}

export interface StashView {
  rows: ViewRow[];
  /** Everything in the stash (not deleted), whatever the filter. */
  total: number;
  /** Entries that pass the filter but are open as tabs here. */
  openHere: number;
  /** The query's text part, lower-cased — what the cards highlight. */
  text: string;
}

export function stashView(input: ViewInput): StashView {
  const q = parseStashQuery(input.query);
  // The default list already excludes the trash (roadmap A8); a trashed row
  // that slips in anyway is inert, never a card.
  const total = input.entries.reduce((n, e) => (e.deletedAt === null ? n + 1 : n), 0);
  const rows: ViewRow[] = [];
  let openHere = 0;
  const hits = input.hits ?? null;
  // Rust matched the text; the tags keep stage 04's prefix rule here.
  const tagsOnly = { tags: q.tags, text: '' };
  const candidates: Iterable<[StashEntry, StashHit | null]> = hits
    ? listCopies(input.entries, hits)
    : input.entries.map((e): [StashEntry, null] => [e, null]);
  for (const [entry, hit] of candidates) {
    if (entry.deletedAt !== null) continue;
    // The one repo rule, with or without a query: the list copy's repo. The
    // search never filters by repo (`SearchRequest`).
    if (input.repoChip !== null && entry.repo !== input.repoChip) continue;
    const match = matchStash(
      {
        title: entryTitle(entry, input.untitled),
        repo: entry.repo,
        tags: entry.tags,
        index: input.indexes.get(entry.id) ?? null,
      },
      hit ? tagsOnly : q
    );
    if (!match) continue;
    if (input.openHere.has(entry.path)) {
      openHere++;
      continue;
    }
    rows.push({ entry, match, hit });
  }
  // Hits stay in relevance order (plan 05 D11): the sort applies again once
  // the query is cleared.
  if (!hits) {
    rows.sort((x, y) => (q.text ? x.match.rank - y.match.rank : 0) || compare(input.sort, x.entry, y.entry));
  }
  return { rows, total, openHere, text: hits ? '' : q.text };
}

/**
 * Each hit with the list's copy of its entry, so a tag change or a pulse shown
 * since the search answered stays on the card. A hit the list lacks is
 * dropped, never rendered from its own copy: that copy is DB-only (the drawer
 * searches with `enrich: false`), and the id is one just removed — or new,
 * and the reload that brings it searches again. Before the first load the
 * list is empty, so hits show nothing.
 */
function listCopies(entries: readonly StashEntry[], hits: readonly StashHit[]): [StashEntry, StashHit][] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return hits.flatMap((h): [StashEntry, StashHit][] => {
    const listed = byId.get(h.entry.id);
    return listed ? [[listed, h]] : [];
  });
}

/** A note's preview without its first non-empty line — the title, already on the card. */
export function dropFirstLine(md: string): string {
  const lines = md.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim());
  return i < 0 ? '' : lines.slice(i + 1).join('\n');
}

/** A file ref's path from its repo down (`docs/plans/a.md`), else the whole path. */
export function repoRelativePath(path: string, repo: string | null): string {
  if (!repo) return path;
  const marker = `/${repo}/`;
  const at = path.indexOf(marker);
  return at < 0 ? path : path.slice(at + marker.length);
}

export type When =
  | { kind: 'now' }
  | { kind: 'today'; time: string }
  | { kind: 'yesterday' }
  | { kind: 'days'; days: number };

/** Less than this ago reads «только что». */
export const JUST_NOW_MS = 60_000;
const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Local midnight of `ms`'s day, `offset` days later. Calendar days, so DST
 * does not shift «вчера». Today's is the instant Rust's `stashedToday` counts
 * from (`clock::local_day_start_ms`), so «отложено сегодня N» on the bar and
 * «сегодня …» on the cards agree.
 */
function dayStart(ms: number, offset = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}

/**
 * «отложено только что / сегодня 01:55 / вчера / 3 дня назад» (mockup `when`),
 * in local time. A moment ahead of `now` (another machine's clock, via a
 * synced notes folder) reads «только что», as the mockup's `m <= 0`.
 */
export function whenOf(at: number, now: number): When {
  if (now - at < JUST_NOW_MS) return { kind: 'now' };
  if (at >= dayStart(now)) {
    const d = new Date(at);
    return { kind: 'today', time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  if (at >= dayStart(now, -1)) return { kind: 'yesterday' };
  return { kind: 'days', days: calendarDaysAgo(at, now) };
}

/**
 * Local midnights between `at`'s day and `now`'s: 0 today (or ahead of `now`),
 * 1 yesterday — the count «N дней назад» shows, so the trash's «удалится через
 * N дн.» built on it always pairs with «удалена …».
 */
export function calendarDaysAgo(at: number, now: number): number {
  // Round, not floor: a DST day is 23 or 25 hours long.
  return Math.max(0, Math.round((dayStart(now) - dayStart(at)) / DAY_MS));
}

export function formatWhen(w: When): string {
  switch (w.kind) {
    case 'now':
      return t('stash.when.now');
    case 'today':
      return t('stash.when.today', { time: w.time });
    case 'yesterday':
      return t('stash.when.yesterday');
    case 'days':
      return plural(w.days, 'stash.when.days_ago');
  }
}
