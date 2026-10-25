import { describe, expect, it } from 'vitest';
import { linkItemsForTabs } from './link-items';
import type { TabMeta } from './tab-model';
import type { StashMark } from '../stash/marks';

const tab = (id: string, path: string | null): TabMeta => ({
  id,
  path,
  dirty: false,
  openedAt: 0,
  viewedAt: 0,
  unviewed: false,
});

describe('linkItemsForTabs', () => {
  it('one item per tab with a file, in drag order; a note under its title; untitled skipped', () => {
    const byId = new Map<string, TabMeta>([
      ['a', tab('a', '/r/plan.md')],
      ['b', tab('b', null)],
      ['c', tab('c', '/n/2026-10-24-ab12.md')],
    ]);
    const marks = (path: string | null): StashMark | null =>
      path === '/n/2026-10-24-ab12.md' ? { kind: 'note', title: 'Ideas', repo: null } : null;
    expect(linkItemsForTabs(['c', 'b', 'a', 'gone'], byId, marks)).toEqual([
      { path: '/n/2026-10-24-ab12.md', title: 'Ideas' },
      { path: '/r/plan.md', title: null },
    ]);
  });

  it('a file reference in the stash keeps its file name', () => {
    const byId = new Map<string, TabMeta>([['a', tab('a', '/r/plan.md')]]);
    const marks = (): StashMark => ({ kind: 'file', title: 'Plan', repo: 'r' });
    expect(linkItemsForTabs(['a'], byId, marks)).toEqual([{ path: '/r/plan.md', title: null }]);
  });
});
