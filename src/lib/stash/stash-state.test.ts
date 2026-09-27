import { describe, expect, it } from 'vitest';
import { DRAWER_SORT_KEYS } from '../tabs/drawer-keys';
import type { KeyLike } from '../tabs/drawer-state';
import type { StashEntry } from './types';
import {
  STASH_CLOSED,
  STASH_SORT_KEYS,
  arrowFocus,
  backspaceStash,
  closeStash,
  escapeStash,
  focusDrawer,
  moveStashKb,
  openStash,
  pulses,
  setRepoChip,
  setStashQuery,
  setStashSort,
  stashKbTarget,
  stashKeyAction,
} from './stash-state';

function key(k: string, over: Partial<KeyLike> = {}): KeyLike {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  return { key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over };
}

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: 10,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

describe('open / close / focus', () => {
  it('opening takes the keys and starts filtered by the window repo', () => {
    expect(openStash(STASH_CLOSED, 'shelf-design')).toEqual({
      ...STASH_CLOSED,
      open: true,
      focus: 'stash',
      repoChip: 'shelf-design',
    });
  });

  it('opening an open stash only takes the keys back', () => {
    const s = { ...openStash(STASH_CLOSED, 'r'), focus: 'tabs' as const, query: 'x', repoChip: null };
    expect(openStash(s, 'r')).toEqual({ ...s, focus: 'stash' });
  });

  it('closing drops the query and the ring, keeps the sort', () => {
    const s = setStashSort(setStashQuery(openStash(STASH_CLOSED, null), 'abc'), 'kind');
    expect(closeStash(s)).toEqual({ ...STASH_CLOSED, sort: 'kind', repoChip: null });
  });

  it('the stash cannot have the keys while closed', () => {
    expect(focusDrawer(STASH_CLOSED, 'stash')).toBe(STASH_CLOSED);
    const open = openStash(STASH_CLOSED, null);
    expect(focusDrawer(open, 'tabs').focus).toBe('tabs');
    expect(focusDrawer(focusDrawer(open, 'tabs'), 'stash').focus).toBe('stash');
  });
});

describe('Esc and Backspace', () => {
  it('Esc clears the query, then closes', () => {
    const s = setStashQuery(openStash(STASH_CLOSED, null), 'ab');
    const cleared = escapeStash(s);
    expect(cleared.query).toBe('');
    expect(cleared.open).toBe(true);
    expect(escapeStash(cleared).open).toBe(false);
  });

  it('Backspace edits the query, then drops the repo chip, then does nothing', () => {
    let s = setStashQuery(openStash(STASH_CLOSED, 'infra'), 'ab');
    s = backspaceStash(s);
    expect(s.query).toBe('a');
    s = backspaceStash(backspaceStash(s));
    expect(s.query).toBe('');
    expect(s.repoChip).toBeNull();
    expect(backspaceStash(s)).toBe(s);
  });

  it('the chip can be put back', () => {
    expect(setRepoChip(openStash(STASH_CLOSED, null), 'infra').repoChip).toBe('infra');
  });
});

describe('keyboard ring', () => {
  const visible = ['a', 'b', 'c'];

  it('the top result is the target while searching', () => {
    expect(stashKbTarget(openStash(STASH_CLOSED, null), visible)).toBeNull();
    expect(stashKbTarget(setStashQuery(openStash(STASH_CLOSED, null), 'x'), visible)).toBe('a');
  });

  it('arrows start at an end and stay inside', () => {
    const s = openStash(STASH_CLOSED, null);
    expect(moveStashKb(s, 1, visible).kb).toBe('a');
    expect(moveStashKb(s, -1, visible).kb).toBe('c');
    expect(moveStashKb(moveStashKb(s, 1, visible), -1, visible).kb).toBe('a');
    expect(moveStashKb(s, 1, [])).toBe(s);
  });
});

describe('stashKeyAction', () => {
  it('maps the stash keys', () => {
    expect(stashKeyAction(key('Escape'), '', true)).toEqual({ kind: 'escape' });
    expect(stashKeyAction(key('l', { metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'changed' });
    expect(stashKeyAction(key('r', { metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'opened' });
    expect(stashKeyAction(key('u', { metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'kind' });
    expect(stashKeyAction(key('#', { code: 'Digit3', shiftKey: true }), '', true)).toEqual({ kind: 'type', char: '#' });
    expect(stashKeyAction(key('Backspace'), '', true)).toEqual({ kind: 'backspace' });
    expect(stashKeyAction(key('ArrowDown'), '', true)).toEqual({ kind: 'move', delta: 1 });
    expect(stashKeyAction(key('ArrowUp'), '', true)).toEqual({ kind: 'move', delta: -1 });
    expect(stashKeyAction(key('Enter'), '', true)).toEqual({ kind: 'enter' });
  });

  it('leaves what it does not use', () => {
    expect(stashKeyAction(key(' ', { code: 'Space' }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key(' ', { code: 'Space' }), 'a', true)).toEqual({ kind: 'type', char: ' ' });
    expect(stashKeyAction(key('g', { metaKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key('Escape', { shiftKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key('a', { isComposing: true }), '', true)).toEqual({ kind: 'none' });
    expect(stashKeyAction(key('Tab'), '', true)).toEqual({ kind: 'none' });
  });

  it('the command key is Ctrl off a Mac', () => {
    expect(stashKeyAction(key('l', { ctrlKey: true }), '', false)).toEqual({ kind: 'sort', sort: 'changed' });
    expect(stashKeyAction(key('l', { ctrlKey: true }), '', true)).toEqual({ kind: 'none' });
  });

  it('shares ⌘L/⌘R/⌘U with the tabs drawer', () => {
    expect(STASH_SORT_KEYS.map((k) => k.accelerator)).toEqual(['CmdOrCtrl+L', 'CmdOrCtrl+R', 'CmdOrCtrl+U']);
    // The same physical keys the tabs drawer sorts with, so drawer-keys.test.ts's
    // «no menu item claims them» guard covers the stash too.
    expect(STASH_SORT_KEYS.map((k) => [k.code, k.accelerator])).toEqual(
      DRAWER_SORT_KEYS.map((k) => [k.code, k.accelerator])
    );
  });
});

describe('arrowFocus', () => {
  it('bare ← and → only', () => {
    expect(arrowFocus(key('ArrowLeft'))).toBe('left');
    expect(arrowFocus(key('ArrowRight'))).toBe('right');
    expect(arrowFocus(key('ArrowRight', { shiftKey: true }))).toBeNull();
    expect(arrowFocus(key('ArrowRight', { metaKey: true }))).toBeNull();
    expect(arrowFocus(key('ArrowRight', { isComposing: true }))).toBeNull();
    expect(arrowFocus(key('ArrowDown'))).toBeNull();
  });
});

describe('pulses', () => {
  it('a card on screen whose put-away time grew pulses; new tags pop', () => {
    const before = [entry('a', { stashedAt: 10 }), entry('b', { stashedAt: 10, tags: ['x'] }), entry('c')];
    const after = [
      entry('a', { stashedAt: 20 }),
      entry('b', { stashedAt: 10, tags: ['x', 'review'] }),
      entry('c', { stashedAt: 30 }),
      entry('d'),
    ];
    const diff = pulses(before, after, new Set(['a', 'b']));
    expect(diff.pulse).toEqual(['a']);
    expect([...diff.newTags]).toEqual([['b', ['review']]]);
  });

  it('a first load pulses nothing', () => {
    expect(pulses([], [entry('a')], new Set()).pulse).toEqual([]);
  });

  it('ids from stash-changed narrow the diff to the entries Rust named', () => {
    const before = [entry('a', { stashedAt: 10 }), entry('b', { stashedAt: 10, tags: [] })];
    const after = [entry('a', { stashedAt: 20 }), entry('b', { stashedAt: 20, tags: ['new'] })];
    const diff = pulses(before, after, new Set(['a', 'b']), ['b']);
    expect(diff.pulse).toEqual(['b']);
    expect([...diff.newTags]).toEqual([['b', ['new']]]);
  });

  it('a named id still needs a card on screen and a later put-away time', () => {
    const before = [entry('a', { stashedAt: 10 }), entry('b', { stashedAt: 10 })];
    const after = [entry('a', { stashedAt: 10 }), entry('b', { stashedAt: 20 })];
    expect(pulses(before, after, new Set(['a']), ['a', 'b']).pulse).toEqual([]);
  });

  it('an empty id list means nothing changed', () => {
    const diff = pulses([entry('a', { stashedAt: 10 })], [entry('a', { stashedAt: 20, tags: ['t'] })], new Set(['a']), []);
    expect(diff.pulse).toEqual([]);
    expect(diff.newTags.size).toBe(0);
  });
});
