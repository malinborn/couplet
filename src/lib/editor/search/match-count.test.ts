import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import {
  MATCH_CAP,
  NO_MATCHES,
  collectMatches,
  formatCounter,
  mapMatches,
  matchIndexAt,
  sameMatchSpec,
} from './match-count';

const LABELS = { none: 'no matches', invalid: 'invalid pattern' };

function state(doc: string): EditorState {
  return EditorState.create({ doc });
}

function q(search: string, opts: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}): SearchQuery {
  return new SearchQuery({ search, ...opts });
}

describe('collectMatches', () => {
  it('lists every match in document order, case-insensitively by default', () => {
    const m = collectMatches(state('Поиск и поиск, ПОИСК'), q('поиск'));
    expect(m.from).toEqual([0, 8, 15]);
    expect(m.to).toEqual([5, 13, 20]);
    expect(m.capped).toBe(false);
  });

  it('honours case sensitivity', () => {
    expect(collectMatches(state('Поиск и поиск'), q('поиск', { caseSensitive: true })).from).toEqual([8]);
  });

  it('honours whole-word matching', () => {
    expect(collectMatches(state('cat concat cat-like'), q('cat', { wholeWord: true })).from).toEqual([0, 11]);
  });

  it('runs regular expressions', () => {
    const m = collectMatches(state('a1 b22 c333'), q('\\d+', { regexp: true }));
    expect(m.from).toEqual([1, 4, 8]);
    expect(m.to).toEqual([2, 6, 11]);
  });

  it('has no matches for an empty query or a regexp that does not compile', () => {
    expect(collectMatches(state('abc'), q(''))).toBe(NO_MATCHES);
    expect(collectMatches(state('abc'), q('(', { regexp: true }))).toBe(NO_MATCHES);
  });

  it('stops at the cap and says so', () => {
    const m = collectMatches(state('x'.repeat(50)), q('x'), 10);
    expect(m.from).toHaveLength(10);
    expect(m.capped).toBe(true);
  });

  it('is not capped when the count lands exactly on the cap', () => {
    const m = collectMatches(state('x'.repeat(10)), q('x'), 10);
    expect(m.from).toHaveLength(10);
    expect(m.capped).toBe(false);
  });

  it('caps at 9999 by default', () => {
    expect(MATCH_CAP).toBe(9999);
    const m = collectMatches(state('x'.repeat(MATCH_CAP + 5)), q('x'));
    expect(m.from).toHaveLength(MATCH_CAP);
    expect(m.capped).toBe(true);
  });
});

describe('matchIndexAt', () => {
  const matches = collectMatches(state('ab ab ab ab'), q('ab'));

  it('finds the match that is exactly the range', () => {
    expect(matchIndexAt(matches, 0, 2)).toBe(0);
    expect(matchIndexAt(matches, 6, 8)).toBe(2);
    expect(matchIndexAt(matches, 9, 11)).toBe(3);
  });

  it('is -1 for a caret, an overlap or a wider selection', () => {
    expect(matchIndexAt(matches, 3, 3)).toBe(-1);
    expect(matchIndexAt(matches, 3, 4)).toBe(-1);
    expect(matchIndexAt(matches, 3, 8)).toBe(-1);
    expect(matchIndexAt(NO_MATCHES, 0, 2)).toBe(-1);
  });
});

describe('formatCounter', () => {
  const doc = state('ab ab ab');
  const matches = collectMatches(doc, q('ab'));

  it('shows nothing for an empty query', () => {
    expect(formatCounter(q(''), NO_MATCHES, { from: 0, to: 0 }, LABELS)).toMatchObject({ text: '', state: 'empty' });
  });

  it('says the pattern is broken for an invalid regexp', () => {
    expect(formatCounter(q('[', { regexp: true }), NO_MATCHES, { from: 0, to: 0 }, LABELS)).toMatchObject({
      text: 'invalid pattern',
      state: 'invalid',
    });
  });

  it('says there are no matches', () => {
    expect(formatCounter(q('zz'), NO_MATCHES, { from: 0, to: 0 }, LABELS)).toMatchObject({
      text: 'no matches',
      state: 'none',
      total: '0',
    });
  });

  it('shows position and total when the selection is a match', () => {
    expect(formatCounter(q('ab'), matches, { from: 3, to: 5 }, LABELS)).toEqual({
      text: '2 / 3',
      state: 'on',
      index: 2,
      total: '3',
    });
  });

  it('shows a dash when the selection is not on a match', () => {
    expect(formatCounter(q('ab'), matches, { from: 2, to: 2 }, LABELS)).toMatchObject({
      text: '– / 3',
      state: 'off',
      index: null,
    });
  });

  it('marks a capped total with a plus', () => {
    const capped = collectMatches(state('x'.repeat(20)), q('x'), 10);
    expect(formatCounter(q('x'), capped, { from: 0, to: 1 }, LABELS).text).toBe('1 / 10+');
    expect(formatCounter(q('x'), capped, { from: 15, to: 16 }, LABELS).text).toBe('– / 10+');
  });
});

describe('mapMatches — a local rescan agrees with a full one', () => {
  const DOC = 'поиск один\nещё поиск и поиски\n\nконец: поиск';

  /** Apply `change` and compare the mapped list with a scan of the result. */
  function check(doc: string, query: SearchQuery, change: { from: number; to?: number; insert?: string }): void {
    const before = state(doc);
    const tr = before.update({ changes: change });
    const mapped = mapMatches(collectMatches(before, query), query, tr.changes, tr.state);
    expect(mapped, JSON.stringify(change)).not.toBeNull();
    const full = collectMatches(tr.state, query);
    expect({ from: mapped?.from, to: mapped?.to }, JSON.stringify(change)).toEqual({ from: full.from, to: full.to });
  }

  it.each([
    ['insert before a match', { from: 0, insert: 'ну ' }],
    ['insert after the last match', { from: DOC.length, insert: ' и ещё' }],
    ['insert inside a match', { from: 2, insert: 'xx' }],
    ['delete inside a match', { from: 1, to: 3 }],
    ['delete across a match', { from: 8, to: 20 }],
    ['delete across lines', { from: 5, to: 30 }],
    ['create a match by typing', { from: 21, insert: ' поиск' }],
    ['create a match across a deletion', { from: 3, to: 4, insert: 'и' }],
    ['replace a whole line', { from: 11, to: 29, insert: 'пусто' }],
    ['delete everything', { from: 0, to: DOC.length }],
  ])('string query: %s', (_name, change) => {
    check(DOC, q('поиск'), change);
  });

  it('a whole-word match unmade by a letter typed right after it', () => {
    check('cat cat', q('cat', { wholeWord: true }), { from: 3, insert: 's' });
    check('cats cat', q('cat', { wholeWord: true }), { from: 3, to: 4 });
  });

  it('a query with a line break finds a match the edit makes across lines', () => {
    check('ab\ncd\nab\nxd', q('b\\ncd'), { from: 10, to: 11, insert: 'c' });
  });

  it('a line-local regexp', () => {
    check('a1 b22\nc333', q('\\d+', { regexp: true }), { from: 4, insert: '9' });
    check('a1 b22\nc333', q('^\\w', { regexp: true }), { from: 6, to: 7 });
  });

  it('gives up (null) where a local rescan cannot be exact', () => {
    const s = state('a\nb');
    const tr = s.update({ changes: { from: 0, insert: 'x' } });
    const multiline = q('a\\nb', { regexp: true });
    expect(mapMatches(collectMatches(s, multiline), multiline, tr.changes, tr.state)).toBeNull();
    const capped = collectMatches(state('xxxx'), q('x'), 2);
    expect(mapMatches(capped, q('x'), tr.changes, tr.state)).toBeNull();
  });

  it('random edits never drift from a full scan', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ['поиск', ' ', '\n', 'по', 'иск', 'x'];
    let doc = DOC;
    for (let i = 0; i < 300; i++) {
      const from = rnd(doc.length + 1);
      const to = Math.min(doc.length, from + rnd(6));
      const insert = rnd(2) ? pieces[rnd(pieces.length)] : '';
      check(doc, q('поиск'), { from, to, insert });
      doc = doc.slice(0, from) + insert + doc.slice(to);
    }
  });
});

describe('sameMatchSpec', () => {
  it('ignores the replacement, compares everything that changes the matches', () => {
    expect(sameMatchSpec(q('a', { replace: 'x' }), q('a', { replace: 'y' }))).toBe(true);
    expect(sameMatchSpec(q('a'), q('b'))).toBe(false);
    expect(sameMatchSpec(q('a'), q('a', { caseSensitive: true }))).toBe(false);
    expect(sameMatchSpec(q('a'), q('a', { wholeWord: true }))).toBe(false);
    expect(sameMatchSpec(q('a'), q('a', { regexp: true }))).toBe(false);
  });
});
