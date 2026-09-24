import { describe, it, expect } from 'vitest';
import { tabName, tabNames } from './tab-name';

describe('tabName', () => {
  it('IsTheFileName', () => {
    expect(tabName('/Users/me/notes/README.md')).toBe('README.md');
  });
  it('FallsBackToThePathWhenThereIsNoName', () => {
    expect(tabName('/')).toBe('/');
  });
  it('IsTheUntitledLabelForAnUntitledTab', () => {
    expect(tabName(null)).toBe('Untitled');
  });
});

describe('tabNames', () => {
  it('JoinsUpToThreeNames', () => {
    expect(tabNames(['/a/x.md'])).toBe('x.md');
    expect(tabNames(['/a/x.md', '/b/y.md', '/c/z.md'])).toBe('x.md, y.md, z.md');
  });
  it('CountsTheRestAfterThree', () => {
    expect(tabNames(['/1.md', '/2.md', '/3.md', '/4.md', '/5.md'])).toBe('1.md, 2.md, 3.md +2');
  });
});
