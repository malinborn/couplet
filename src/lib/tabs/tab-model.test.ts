import { describe, it, expect } from 'vitest';
import {
  emptyTabList,
  insertAfterActive,
  insertAt,
  replaceTab,
  removeTab,
  setActive,
  updateTab,
  tabByIndex,
  neighbour,
  findByPath,
  activeTab,
  reorderTabs,
  type TabListState,
  type TabMeta,
} from './tab-model';

const tab = (id: string, path: string | null = `/${id}.md`): TabMeta => ({
  id,
  path,
  dirty: false,
  openedAt: 0,
  viewedAt: 0,
  unviewed: false,
});

function list(ids: string[], activeId: string | null): TabListState {
  return { tabs: ids.map((id) => tab(id)), activeId };
}

const ids = (s: TabListState) => s.tabs.map((t) => t.id);

describe('tab list', () => {
  it('InsertsANewTabRightAfterTheActiveOne', () => {
    const next = insertAfterActive(list(['a', 'b', 'c'], 'b'), tab('n'));
    expect(ids(next)).toEqual(['a', 'b', 'n', 'c']);
    expect(next.activeId).toBe('b');
  });

  it('InsertsAtTheEndWhenNothingIsActive', () => {
    expect(ids(insertAfterActive(emptyTabList(), tab('n')))).toEqual(['n']);
  });

  it('InsertsAtAnIndex_ClampedToTheEnd_WithoutActivating', () => {
    expect(ids(insertAt(list(['a', 'b'], 'a'), 1, tab('n')))).toEqual(['a', 'n', 'b']);
    expect(ids(insertAt(list(['a', 'b'], 'a'), 9, tab('n')))).toEqual(['a', 'b', 'n']);
    expect(insertAt(list(['a', 'b'], 'a'), 0, tab('n')).activeId).toBe('a');
  });

  it('ReplacesATabInPlaceAndMovesActiveWithIt', () => {
    const next = replaceTab(list(['a', 'b', 'c'], 'b'), 'b', tab('n'));
    expect(ids(next)).toEqual(['a', 'n', 'c']);
    expect(next.activeId).toBe('n');
  });

  it('ClosingTheActiveTabActivatesItsRightNeighbour', () => {
    const { state, nextActiveId } = removeTab(list(['a', 'b', 'c'], 'b'), 'b');
    expect(ids(state)).toEqual(['a', 'c']);
    expect(nextActiveId).toBe('c');
    expect(state.activeId).toBe('c');
  });

  it('ClosingTheLastTabInOrderActivatesItsLeftNeighbour', () => {
    expect(removeTab(list(['a', 'b', 'c'], 'c'), 'c').nextActiveId).toBe('b');
  });

  it('ClosingTheOnlyTabLeavesNothingActive', () => {
    const { state, nextActiveId } = removeTab(list(['a'], 'a'), 'a');
    expect(state.tabs).toEqual([]);
    expect(nextActiveId).toBeNull();
  });

  it('ClosingABackgroundTabKeepsTheActiveOne', () => {
    const { state, nextActiveId } = removeTab(list(['a', 'b', 'c'], 'c'), 'a');
    expect(ids(state)).toEqual(['b', 'c']);
    expect(nextActiveId).toBe('c');
  });

  it('SetActiveIgnoresAnUnknownId', () => {
    const s = list(['a', 'b'], 'a');
    expect(setActive(s, 'zzz')).toBe(s);
    expect(setActive(s, 'b').activeId).toBe('b');
  });

  it('UpdatesOneTabAndLeavesTheOthersAlone', () => {
    const next = updateTab(list(['a', 'b'], 'a'), 'b', { dirty: true, path: null });
    expect(next.tabs[1]).toEqual({ id: 'b', path: null, dirty: true, openedAt: 0, viewedAt: 0, unviewed: false });
    expect(next.tabs[0]).toEqual(tab('a'));
  });

  it('CommandDigitSelectsTheNthTabLiterally', () => {
    const s = list(['a', 'b', 'c'], 'a');
    expect(tabByIndex(s, 1)?.id).toBe('a');
    expect(tabByIndex(s, 3)?.id).toBe('c');
    expect(tabByIndex(s, 9)).toBeUndefined();
    expect(tabByIndex(s, 0)).toBeUndefined();
  });

  it('ControlTabWrapsInBothDirections', () => {
    expect(neighbour(list(['a', 'b', 'c'], 'c'), 1)?.id).toBe('a');
    expect(neighbour(list(['a', 'b', 'c'], 'a'), -1)?.id).toBe('c');
    expect(neighbour(list(['a', 'b', 'c'], 'a'), 1)?.id).toBe('b');
  });

  it('ControlTabDoesNothingWithOneTab', () => {
    expect(neighbour(list(['a'], 'a'), 1)).toBeUndefined();
  });

  it('FindsByPathAndActive', () => {
    const s = list(['a', 'b'], 'b');
    expect(findByPath(s, '/a.md')?.id).toBe('a');
    expect(findByPath(s, '/zzz.md')).toBeUndefined();
    expect(activeTab(s)?.id).toBe('b');
  });
});

describe('reorderTabs', () => {
  it('AppliesAPermutation_KeepingActive', () => {
    const next = reorderTabs(list(['a', 'b', 'c'], 'b'), ['c', 'a', 'b']);
    expect(next.tabs.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(next.activeId).toBe('b');
  });

  it('RefusesAnythingButAPermutation', () => {
    const s = list(['a', 'b', 'c'], 'a');
    expect(reorderTabs(s, ['a', 'b'])).toBe(s);
    expect(reorderTabs(s, ['a', 'b', 'x'])).toBe(s);
    expect(reorderTabs(s, ['a', 'a', 'b'])).toBe(s);
  });

  it('ReturnsTheSameStateForTheSameOrder', () => {
    const s = list(['a', 'b'], 'a');
    expect(reorderTabs(s, ['a', 'b'])).toBe(s);
  });
});
