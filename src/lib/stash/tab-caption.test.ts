import { describe, expect, it } from 'vitest';
import { repoLabel, tabCaption } from './tab-caption';

// A note's `repo` is a directory name (roadmap A3).
const note = { kind: 'note' as const, title: 'Stored title', repo: 'couplet' };

describe('tabCaption', () => {
  it('a blank untitled tab is a new note that will vanish', () => {
    expect(tabCaption({ path: null, title: null, blank: true, mark: null })).toEqual({
      name: 'New note',
      stash: { kind: 'blank' },
    });
  });

  it('an untitled tab with text shows its title while it becomes a note', () => {
    expect(tabCaption({ path: null, title: 'Plan', blank: false, mark: null })).toEqual({
      name: 'Plan',
      stash: null,
    });
  });

  it('a note shows its live title with the glyph, the stored one while the text is unknown', () => {
    const path = '/d/couplet/2026-09-27-0215-a3f9.md';
    expect(tabCaption({ path, title: 'Live', blank: false, mark: note })).toEqual({
      name: 'Live',
      stash: { kind: 'note', repo: note.repo },
    });
    expect(tabCaption({ path, title: undefined, blank: false, mark: note }).name).toBe('Stored title');
    expect(tabCaption({ path, title: null, blank: true, mark: note }).name).toBe('Untitled');
  });

  it('a file keeps its name; one in the stash gets the small glyph', () => {
    expect(tabCaption({ path: '/p/a.md', title: 'x', blank: false, mark: null })).toEqual({
      name: 'a.md',
      stash: null,
    });
    expect(
      tabCaption({
        path: '/p/a.md',
        title: 'x',
        blank: false,
        mark: { kind: 'file', title: 'a.md', repo: null },
      })
    ).toEqual({ name: 'a.md', stash: { kind: 'in-stash' } });
  });
});

describe('repoLabel', () => {
  it('is the last path component', () => {
    expect(repoLabel('couplet')).toBe('couplet');
    expect(repoLabel('/Users/u/src/couplet')).toBe('couplet');
    expect(repoLabel('/Users/u/src/couplet/')).toBe('couplet');
    expect(repoLabel(null)).toBe('');
  });
});
