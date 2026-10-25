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

  it('a stash card over the text links (file links, plan 03); the drawers still win', () => {
    expect(resolveDrop('stash', { ...none, text: true }, false)).toBe('text');
    expect(resolveDrop('stash', { ...none, text: true, tabsDrawer: true }, false)).toBe('tabs-drawer');
    expect(resolveDrop('stash', { ...none, text: true, stashDrawer: true }, false)).toBe('none');
  });

  it('a tab card over the page moves it — with ⌥ it links instead, and never opens the carousel', () => {
    expect(resolveDrop('tabs', { ...none, text: true }, false)).toBe('page');
    expect(resolveDrop('tabs', { ...none, text: true }, false, true)).toBe('text');
    expect(resolveDrop('tabs', none, false, true)).toBe('none');
    expect(resolveDrop('tabs', { ...none, text: true, stashZone: true, tabsDrawer: true }, false, true)).toBe('stash-zone');
  });
});
