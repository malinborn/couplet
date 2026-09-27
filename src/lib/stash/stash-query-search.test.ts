import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TRIGRAM_MIN,
  drawerTerms,
  highlightTerms,
  isLongTerm,
  parseSearchQuery,
  searchText,
  segmentsFromRanges,
  termsText,
  type SearchTerm,
} from './stash-query';

const FIXTURE = fileURLToPath(new URL('../../../src-tauri/tests/fixtures/stash-queries.json', import.meta.url));

interface Case {
  input: string;
  tags: string[];
  terms: SearchTerm[];
}

const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Case[];

const t = (text: string): SearchTerm => ({ text, phrase: false });

describe('parseSearchQuery', () => {
  it('reads the fixture Rust reads', () => {
    // Pinned exactly, like `parses_every_shared_fixture_case` in query.rs: a
    // case lost from the file must fail in both suites.
    expect(cases.length).toBe(37);
  });

  it.each(cases)('parses like Rust %j', (c) => {
    expect(parseSearchQuery(c.input)).toEqual({ tags: c.tags, terms: c.terms });
  });

  it('splits at every C0 control and DEL, as Rust does', () => {
    const codes = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];
    for (const code of codes) {
      const c = String.fromCharCode(code);
      expect(parseSearchQuery(`ab${c}cd`).terms, `U+${code.toString(16)}`).toEqual([t('ab'), t('cd')]);
    }
  });

  it('turns a word into a tag exactly when Rust would store it as one', () => {
    for (const raw of ['#Infra', '##Infra', '#INFRA']) {
      expect(parseSearchQuery(raw).tags).toEqual(['infra']);
    }
    // White_Space that is no separator (U+2003) still trims at the edges...
    expect(parseSearchQuery('# Infra ')).toEqual({ tags: ['infra'], terms: [] });
    // ...and keeps the word a term when it is inside.
    expect(parseSearchQuery('#a b')).toEqual({ tags: [], terms: [t('#a b')] });
    // 64 code points is the cap, and an emoji is one of them.
    const atCap = '#' + '😀'.repeat(64);
    expect(parseSearchQuery(atCap).tags).toEqual(['😀'.repeat(64)]);
    const long = '#' + 'я'.repeat(65);
    expect(parseSearchQuery(long)).toEqual({ tags: [], terms: [t(long)] });
  });

  it('splits only on the shared separators, never on U+0085 or U+FEFF', () => {
    expect(parseSearchQuery('a b　c\td\ne\rf')).toEqual({
      tags: [],
      terms: ['a', 'b', 'c', 'd', 'e', 'f'].map(t),
    });
    expect(parseSearchQuery('a\u0085b a﻿b').terms).toEqual([t('a\u0085b'), t('a﻿b')]);
  });
});

describe('isLongTerm', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(TRIGRAM_MIN).toBe(3);
    expect(isLongTerm(t('тай'))).toBe(true);
    expect(isLongTerm(t('ай'))).toBe(false);
    // 3 code points, 6 UTF-16 units: long, as in Rust.
    expect(isLongTerm(t('😀😀😀'))).toBe(true);
    // 1 code point, 2 UTF-16 units: short.
    expect(isLongTerm(t('😀'))).toBe(false);
  });
});

describe('searchText', () => {
  it('keeps only the text terms, phrases quoted', () => {
    expect(searchText('#infra тайник "на третьем" ок')).toBe('тайник "на третьем" ок');
    expect(searchText('#infra #deploy')).toBe('');
    expect(searchText('')).toBe('');
  });

  it.each(cases)('re-parses to the same terms and no tags %j', (c) => {
    expect(parseSearchQuery(searchText(c.input))).toEqual({ tags: [], terms: c.terms });
  });
});

describe('drawerTerms', () => {
  // Stage 04's rule reads every bare `#` word as a tag — or, like the lone `#`
  // being typed on the way to `#ops`, as nothing — so none of them is text.
  it('drops every bare # word, keeps phrases and plain words', () => {
    expect(drawerTerms('# тайник')).toEqual([t('тайник')]);
    expect(drawerTerms('##')).toEqual([]);
    expect(drawerTerms(`#${'x'.repeat(80)} ок`)).toEqual([t('ок')]);
    expect(drawerTerms('"#infra" ок')).toEqual([{ text: '#infra', phrase: true }, t('ок')]);
  });

  it('serializes back to a query Rust parses to the same terms', () => {
    const terms = drawerTerms('#infra тайник "на третьем" #');
    expect(termsText(terms)).toBe('тайник "на третьем"');
    expect(parseSearchQuery(termsText(terms)).terms).toEqual(terms);
  });
});

describe('highlightTerms', () => {
  it('marks every occurrence ignoring case (Cyrillic)', () => {
    expect(highlightTerms('Тайник и тайники', [t('тайник')])).toEqual([
      { text: 'Тайник', hit: true },
      { text: ' и ', hit: false },
      { text: 'тайник', hit: true },
      { text: 'и', hit: false },
    ]);
  });

  it('merges overlapping terms', () => {
    expect(highlightTerms('документация', [t('документ'), t('мент')])).toEqual([
      { text: 'документ', hit: true },
      { text: 'ация', hit: false },
    ]);
  });

  it('does not fold ё to е (plan D13)', () => {
    expect(highlightTerms('Ёлка', [t('елка')])).toEqual([{ text: 'Ёлка', hit: false }]);
    expect(highlightTerms('Ёлка', [t('ёлка')])).toEqual([{ text: 'Ёлка', hit: true }]);
  });

  it('folds every sigma to one, as Rust `query::fold` does', () => {
    // `toLowerCase` turns a word-final Σ into ς; Rust folds char by char and
    // maps ς to σ, so Rust matched «ΟΔΟΣ» for either spelling.
    const whole = (text: string) => [{ text, hit: true }];
    expect(highlightTerms('ΟΔΟΣ', [t('οδοσ')])).toEqual(whole('ΟΔΟΣ'));
    expect(highlightTerms('ΟΔΟΣ', [t('οδος')])).toEqual(whole('ΟΔΟΣ'));
    expect(highlightTerms('οδος', [t('ΟΔΟΣ')])).toEqual(whole('οδος'));
    expect(highlightTerms('ΟΔΟΣ ΚΑΙ', [t('οσ κ')])).toEqual([
      { text: 'ΟΔ', hit: false },
      { text: 'ΟΣ Κ', hit: true },
      { text: 'ΑΙ', hit: false },
    ]);
  });

  it('leaves the text unmarked without terms', () => {
    expect(highlightTerms('заметка', [])).toEqual([{ text: 'заметка', hit: false }]);
  });

  it('highlights nothing rather than cutting wrong when lower-casing changes the length', () => {
    expect(highlightTerms('İstanbul', [t('stan')])).toEqual([{ text: 'İstanbul', hit: false }]);
  });
});

describe('segmentsFromRanges', () => {
  it('cuts at UTF-16 offsets (emoji before the hit)', () => {
    // '😀' is two UTF-16 units, so «тайник» spans [3, 9).
    expect(segmentsFromRanges('😀 тайник', [[3, 9]])).toEqual([
      { text: '😀 ', hit: false },
      { text: 'тайник', hit: true },
    ]);
  });

  it('sorts, merges and clamps ranges', () => {
    expect(
      segmentsFromRanges('abcdef', [
        [4, 99],
        [0, 2],
        [1, 3],
        [5, 5],
      ])
    ).toEqual([
      { text: 'abc', hit: true },
      { text: 'd', hit: false },
      { text: 'ef', hit: true },
    ]);
  });

  it('leaves the text unmarked without ranges', () => {
    expect(segmentsFromRanges('текст', [])).toEqual([{ text: 'текст', hit: false }]);
  });

  it('gives one unmarked segment for empty text', () => {
    expect(segmentsFromRanges('', [[0, 3]])).toEqual([{ text: '', hit: false }]);
  });
});
