import { describe, it, expect } from 'vitest';
import { sortedOrder } from './drawer-sort';
import type { TabMeta } from './tab-model';

const tab = (id: string, openedAt: number, viewedAt: number, unviewed = false): TabMeta => ({
  id,
  path: `/${id}.md`,
  dirty: false,
  openedAt,
  viewedAt,
  unviewed,
});

describe('sortedOrder', () => {
  const tabs = [tab('a', 1, 50), tab('b', 3, 10, true), tab('c', 2, 90), tab('d', 4, 0, true), tab('e', 5, 0)];

  it('OpenedPutsTheNewestFirst', () => {
    expect(sortedOrder(tabs, 'opened', 'a')).toEqual(['e', 'd', 'b', 'c', 'a']);
  });

  it('ViewedPutsTheActiveTabFirst_ThenTheMostRecentlyViewed', () => {
    expect(sortedOrder(tabs, 'viewed', 'a')).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('AiPutsUnviewedFirst_NewestFirst_TheRestKeepTheirOrder', () => {
    expect(sortedOrder(tabs, 'ai', 'a')).toEqual(['d', 'b', 'a', 'c', 'e']);
  });

  it('TiesKeepTheCurrentOrder', () => {
    const same = [tab('x', 7, 0), tab('y', 7, 0), tab('z', 7, 0)];
    expect(sortedOrder(same, 'opened', null)).toEqual(['x', 'y', 'z']);
    expect(sortedOrder(same, 'viewed', null)).toEqual(['x', 'y', 'z']);
    expect(sortedOrder(same, 'ai', null)).toEqual(['x', 'y', 'z']);
  });

  it('IsAPermutation', () => {
    for (const kind of ['opened', 'viewed', 'ai'] as const) {
      expect([...sortedOrder(tabs, kind, 'c')].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    }
    expect(sortedOrder([], 'opened', null)).toEqual([]);
  });
});
