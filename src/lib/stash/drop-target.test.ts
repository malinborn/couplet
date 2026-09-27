import { describe, expect, it } from 'vitest';
import { resolveDrop, type DropHits } from './drop-target';

const none: DropHits = { stashDrawer: false, stashZone: false, list: false, tabsDrawer: false };

describe('resolveDrop', () => {
  it('a tab card: the stash drawer, the stash zone, the list, else the page', () => {
    expect(resolveDrop('tabs', { ...none, stashDrawer: true }, false)).toBe('stash-drawer');
    expect(resolveDrop('tabs', { ...none, stashZone: true, tabsDrawer: true }, false)).toBe('stash-zone');
    expect(resolveDrop('tabs', { ...none, list: true, tabsDrawer: true }, false)).toBe('list');
    expect(resolveDrop('tabs', { ...none, tabsDrawer: true }, false)).toBe('none');
    expect(resolveDrop('tabs', none, false)).toBe('page');
  });

  it('a filtered tab list takes no drop (no manual order to drop into)', () => {
    expect(resolveDrop('tabs', { ...none, list: true, tabsDrawer: true }, true)).toBe('none');
    expect(resolveDrop('tabs', { ...none, stashZone: true, tabsDrawer: true }, true)).toBe('stash-zone');
  });

  it('a stash card: anywhere on the tabs drawer opens it, elsewhere cancels', () => {
    expect(resolveDrop('stash', { ...none, list: true, tabsDrawer: true }, false)).toBe('tabs-drawer');
    expect(resolveDrop('stash', { ...none, tabsDrawer: true }, false)).toBe('tabs-drawer');
    expect(resolveDrop('stash', { ...none, stashDrawer: true }, false)).toBe('none');
    expect(resolveDrop('stash', none, false)).toBe('none');
  });
});
