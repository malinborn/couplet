import { describe, expect, it } from 'vitest';
import { deleteBackward } from './query-edit';

describe('deleteBackward', () => {
  it('char: one character off the end', () => {
    expect(deleteBackward('привет', 'char')).toBe('приве');
    expect(deleteBackward('a', 'char')).toBe('');
    expect(deleteBackward('', 'char')).toBe('');
  });

  it('char: an emoji goes whole, never half a surrogate pair', () => {
    expect(deleteBackward('ok 😀', 'char')).toBe('ok ');
  });

  it('word: back to the previous whitespace', () => {
    expect(deleteBackward('привет мир', 'word')).toBe('привет ');
    expect(deleteBackward('привет', 'word')).toBe('');
    expect(deleteBackward('a b c', 'word')).toBe('a b ');
  });

  it('word: trailing whitespace first, then the word', () => {
    expect(deleteBackward('привет мир  ', 'word')).toBe('привет ');
    expect(deleteBackward('привет ', 'word')).toBe('');
    expect(deleteBackward('привет\tмир\t', 'word')).toBe('привет\t');
  });

  it('word: a query of only spaces clears', () => {
    expect(deleteBackward('   ', 'word')).toBe('');
    expect(deleteBackward('', 'word')).toBe('');
  });

  it('word: punctuation and emoji are part of the word — only whitespace separates', () => {
    expect(deleteBackward('#infra vpn-conf', 'word')).toBe('#infra ');
    expect(deleteBackward('план 😀🚀', 'word')).toBe('план ');
    expect(deleteBackward('"фраза', 'word')).toBe('');
  });

  it('all: the whole query', () => {
    expect(deleteBackward('привет мир', 'all')).toBe('');
    expect(deleteBackward('   ', 'all')).toBe('');
    expect(deleteBackward('', 'all')).toBe('');
  });
});
