import { describe, expect, it } from 'vitest';
import { indexText } from '../tabs/drawer-filter';
import {
  TAG_MAX,
  matchStash,
  matchStashText,
  normalizeTag,
  parseStashQuery,
  type StashCandidate,
} from './stash-query';

describe('normalizeTag', () => {
  it('trims, drops #, lower-cases and joins words with -', () => {
    expect(normalizeTag('  #Deploy Plan ')).toBe('deploy-plan');
    expect(normalizeTag('##Инфра')).toBe('инфра');
  });

  it('refuses an empty tag and cuts a long one', () => {
    expect(normalizeTag('#')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('x'.repeat(100))).toHaveLength(TAG_MAX);
  });

  // Rust `entries.rs::normalize_tag` refuses a tag over TAG_MAX_CHARS (64)
  // chars; the UI must never cut shorter than what Rust stores, nor send longer.
  it('keeps the Rust limit, counted in characters, not UTF-16 units', () => {
    expect(TAG_MAX).toBe(64);
    expect(normalizeTag('t'.repeat(64))).toBe('t'.repeat(64));
    const cut = normalizeTag('я'.repeat(70) + '😀');
    expect(cut).toBe('я'.repeat(64));
    const emoji = normalizeTag('😀'.repeat(70)) ?? '';
    expect(Array.from(emoji)).toHaveLength(64);
    expect(emoji).toBe('😀'.repeat(64));
  });

  it('strips # after the leading spaces, as Rust does (trim, #s, trim)', () => {
    expect(normalizeTag(' # ci ')).toBe('ci');
  });

  it('treats every space Rust refuses as a word break (U+0085 included)', () => {
    expect(normalizeTag('\u0085a\u0085b\u00a0c\u0085')).toBe('a-b-c');
  });
});

describe('parseStashQuery', () => {
  it('splits #tags from text', () => {
    expect(parseStashQuery('#Infra  sast  #ci')).toEqual({ tags: ['infra', 'ci'], text: 'sast' });
  });

  it('keeps a quoted phrase as text', () => {
    expect(parseStashQuery('"HDMI переговорка" #infra')).toEqual({ tags: ['infra'], text: 'hdmi переговорка' });
    expect(parseStashQuery('"unclosed phrase')).toEqual({ tags: [], text: 'unclosed phrase' });
  });

  it('a lone # is no tag yet', () => {
    expect(parseStashQuery('#')).toEqual({ tags: [], text: '' });
  });
});

describe('matchStash', () => {
  const note: StashCandidate = {
    title: 'Вопросы к AppSec по SAST',
    repo: 'shelf-design',
    tags: ['infra'],
    index: indexText('# Вопросы к AppSec по SAST\n- semgrep или CodeQL — кто поддерживает правила?'),
  };

  it('no text: passes when every tag matches the start of a tag or the repo', () => {
    expect(matchStash(note, parseStashQuery(''))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('#inf'))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('#shelf'))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('#ideas'))).toBeNull();
  });

  it('ranks a title prefix, a title substring, then a text line', () => {
    expect(matchStash(note, parseStashQuery('вопр'))).toEqual({ rank: 0 });
    expect(matchStash(note, parseStashQuery('sast'))).toEqual({ rank: 1 });
    expect(matchStash(note, parseStashQuery('codeql'))).toEqual({
      rank: 2,
      line: 'semgrep или CodeQL — кто поддерживает правила?',
    });
    expect(matchStash(note, parseStashQuery('kubernetes'))).toBeNull();
  });

  it('matches without an index by title only', () => {
    expect(matchStash({ ...note, index: null }, parseStashQuery('codeql'))).toBeNull();
  });

  it('a tag filter and text must both pass', () => {
    expect(matchStash(note, parseStashQuery('#infra sast'))).toEqual({ rank: 1 });
    expect(matchStash(note, parseStashQuery('#ideas sast'))).toBeNull();
  });
});

describe('matchStashText', () => {
  it('is the text part alone (stage 05 swaps it for stash_search)', () => {
    const c: StashCandidate = { title: 'Plan', repo: null, tags: [], index: null };
    expect(matchStashText(c, 'pl')).toEqual({ rank: 0 });
    expect(matchStashText(c, 'an')).toEqual({ rank: 1 });
    expect(matchStashText(c, 'zz')).toBeNull();
  });
});
