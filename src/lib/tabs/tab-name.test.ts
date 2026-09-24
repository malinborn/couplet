import { describe, it, expect } from 'vitest';
import { tabName } from './tab-name';

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
