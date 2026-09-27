import { afterEach, describe, expect, it } from 'vitest';
import { indexText, type SearchIndex } from '../tabs/drawer-filter';
import { installCatalog } from '../i18n';
import type { StashEntry } from './types';
import {
  changedAt,
  dropFirstLine,
  entryTitle,
  formatWhen,
  repoRelativePath,
  stashView,
  whenOf,
  type StashSort,
} from './stash-view';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();
const MIN = 60_000;

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: NOW - 100 * MIN,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

function indexes(entries: StashEntry[]): Map<string, SearchIndex> {
  return new Map(entries.map((e) => [e.id, indexText(e.preview)]));
}

function ids(
  entries: StashEntry[],
  over: { sort?: StashSort; query?: string; repoChip?: string | null; openHere?: string[] } = {}
): string[] {
  return stashView({
    entries,
    indexes: indexes(entries),
    openHere: new Set(over.openHere ?? []),
    repoChip: over.repoChip ?? null,
    query: over.query ?? '',
    sort: over.sort ?? 'changed',
    untitled: 'Untitled',
  }).rows.map((r) => r.entry.id);
}

afterEach(() => installCatalog('en'));

describe('changedAt', () => {
  it('is the later of the last edit and the last put-away', () => {
    expect(changedAt(entry('a', { modifiedAt: 5, stashedAt: 9 }))).toBe(9);
    expect(changedAt(entry('a', { modifiedAt: 5, stashedAt: null }))).toBe(5);
    expect(changedAt(entry('a', { modifiedAt: 9, stashedAt: 5 }))).toBe(9);
  });
});

describe('stashView', () => {
  const a = entry('a', { modifiedAt: NOW - 500 * MIN, stashedAt: NOW - 10 * MIN, openedAt: NOW - 400 * MIN });
  const b = entry('b', { modifiedAt: NOW - 20 * MIN, openedAt: NOW - 5 * MIN, kind: 'file', repo: 'infra' });
  const c = entry('c', { modifiedAt: NOW - 300 * MIN, repo: 'infra', tags: ['ops'] });

  it('sorts by change by default, most recent first', () => {
    expect(ids([c, b, a])).toEqual(['a', 'b', 'c']);
  });

  it('sorts by opening, never-opened last, ties by change', () => {
    expect(ids([c, b, a], { sort: 'opened' })).toEqual(['b', 'a', 'c']);
  });

  it('sorts notes first, then files, each by change', () => {
    expect(ids([c, b, a], { sort: 'kind' })).toEqual(['a', 'c', 'b']);
  });

  // Rust breaks ties by rowid, newest row first; ids are `s<unix ms>-<salt>`,
  // so the later id is the newer entry whatever order the list arrived in.
  it('breaks a full tie by id, newest first, like Rust breaks it by rowid', () => {
    const older = entry('s1790000000000-ffff', { modifiedAt: NOW });
    const newer = entry('s1790000000001-0000', { modifiedAt: NOW });
    for (const sort of ['changed', 'opened', 'kind'] as const) {
      expect(ids([older, newer], { sort })).toEqual([newer.id, older.id]);
      expect(ids([newer, older], { sort })).toEqual([newer.id, older.id]);
    }
  });

  it('the repo chip keeps only that repo', () => {
    expect(ids([a, b, c], { repoChip: 'infra' })).toEqual(['b', 'c']);
  });

  it('hides what is open as a tab here, and counts it', () => {
    const view = stashView({
      entries: [a, b, c],
      indexes: indexes([a, b, c]),
      openHere: new Set(['/n/b.md']),
      repoChip: null,
      query: '',
      sort: 'changed',
      untitled: 'Untitled',
    });
    expect(view.rows.map((r) => r.entry.id)).toEqual(['a', 'c']);
    expect(view.openHere).toBe(1);
    expect(view.total).toBe(3);
  });

  it('an entry open here that the filter drops is not counted as open here', () => {
    const view = stashView({
      entries: [a, b, c],
      indexes: indexes([a, b, c]),
      openHere: new Set(['/n/b.md']),
      repoChip: null,
      query: '#ops',
      sort: 'changed',
      untitled: 'Untitled',
    });
    expect(view.rows.map((r) => r.entry.id)).toEqual(['c']);
    expect(view.openHere).toBe(0);
  });

  it('leaves trashed entries out, and out of the total', () => {
    const gone = entry('gone', { deletedAt: NOW - MIN, modifiedAt: NOW });
    const view = stashView({
      entries: [gone, a],
      indexes: indexes([gone, a]),
      openHere: new Set(),
      repoChip: null,
      query: '',
      sort: 'changed',
      untitled: 'Untitled',
    });
    expect(view.rows.map((r) => r.entry.id)).toEqual(['a']);
    expect(view.total).toBe(1);
  });

  it('with text, ranks before it sorts', () => {
    const x = entry('x', { title: 'deploy plan', modifiedAt: NOW - 900 * MIN });
    const y = entry('y', { title: 'the deploy', modifiedAt: NOW - 1 * MIN });
    const z = entry('z', { title: 'notes', preview: 'first\nhow we deploy', modifiedAt: NOW });
    expect(ids([z, y, x], { query: 'deploy' })).toEqual(['x', 'y', 'z']);
  });

  it('matches an untitled note by its localized title', () => {
    const u = entry('u', { title: null });
    expect(ids([u, a], { query: 'untit' })).toEqual(['u']);
  });

  it('gives the query text to highlight, lower-cased, without tags', () => {
    const view = stashView({
      entries: [c],
      indexes: indexes([c]),
      openHere: new Set(),
      repoChip: null,
      query: '#ops C',
      sort: 'changed',
      untitled: 'Untitled',
    });
    expect(view.text).toBe('c');
  });

  it('filters by tag prefix', () => {
    expect(ids([a, b, c], { query: '#op' })).toEqual(['c']);
  });
});

describe('entry helpers', () => {
  it('an untitled note gets the localized title', () => {
    expect(entryTitle(entry('a', { title: null }), 'Без названия')).toBe('Без названия');
    expect(entryTitle(entry('a', { title: 'План' }), 'Без названия')).toBe('План');
  });

  it('drops the first non-empty line (the title) of a note preview', () => {
    expect(dropFirstLine('\n# Title\n- one\n- two')).toBe('- one\n- two');
    expect(dropFirstLine('   ')).toBe('');
  });

  it('shows a file path from its repo down', () => {
    expect(repoRelativePath('/Users/x/dev/infra/oncall/rota.md', 'infra')).toBe('oncall/rota.md');
    expect(repoRelativePath('/tmp/a.md', 'infra')).toBe('/tmp/a.md');
    expect(repoRelativePath('/tmp/a.md', null)).toBe('/tmp/a.md');
  });
});

describe('whenOf / formatWhen', () => {
  it('just now, today at a time, yesterday, days ago', () => {
    expect(whenOf(NOW - 30_000, NOW)).toEqual({ kind: 'now' });
    expect(whenOf(new Date(2026, 8, 26, 1, 55).getTime(), NOW)).toEqual({ kind: 'today', time: '01:55' });
    expect(whenOf(new Date(2026, 8, 25, 23, 0).getTime(), NOW)).toEqual({ kind: 'yesterday' });
    expect(whenOf(new Date(2026, 8, 23, 12, 0).getTime(), NOW)).toEqual({ kind: 'days', days: 3 });
  });

  // «сегодня» starts at local midnight — the same instant Rust's `stashedToday`
  // counts from (`clock::local_day_start_ms`), so the bar and the cards agree.
  it('today starts at local midnight, not 24 hours ago', () => {
    const midnight = new Date(2026, 8, 26).getTime();
    expect(whenOf(midnight, NOW)).toEqual({ kind: 'today', time: '00:00' });
    expect(whenOf(midnight - 1, NOW)).toEqual({ kind: 'yesterday' });
    expect(whenOf(new Date(2026, 8, 25).getTime() - 1, NOW)).toEqual({ kind: 'days', days: 2 });
  });

  it('just now lasts a minute, and a clock ahead of ours reads as just now', () => {
    expect(whenOf(NOW - 59_999, NOW)).toEqual({ kind: 'now' });
    expect(whenOf(NOW - 60_000, NOW)).toEqual({ kind: 'today', time: '10:29' });
    expect(whenOf(NOW + 5 * MIN, NOW)).toEqual({ kind: 'now' });
  });

  it('reads in Russian', () => {
    installCatalog('ru');
    expect(formatWhen({ kind: 'now' })).toBe('только что');
    expect(formatWhen({ kind: 'today', time: '01:55' })).toBe('сегодня 01:55');
    expect(formatWhen({ kind: 'yesterday' })).toBe('вчера');
    expect(formatWhen({ kind: 'days', days: 3 })).toBe('3 дня назад');
    expect(formatWhen({ kind: 'days', days: 5 })).toBe('5 дней назад');
    expect(formatWhen({ kind: 'days', days: 21 })).toBe('21 день назад');
  });

  it('reads in English', () => {
    installCatalog('en');
    expect(formatWhen({ kind: 'now' })).toBe('just now');
    expect(formatWhen({ kind: 'today', time: '01:55' })).toBe('today 01:55');
    expect(formatWhen({ kind: 'days', days: 2 })).toBe('2 days ago');
  });
});
