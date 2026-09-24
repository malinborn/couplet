import { describe, it, expect } from 'vitest';
import {
  CLOSED,
  captureTyping,
  clearSelection,
  close,
  keysCaptured,
  drawerKeyAction,
  enterTarget,
  escape,
  hintVisible,
  kbTarget,
  moveKb,
  open,
  pin,
  setQuery,
  setShift,
  toggleMany,
  type KeyLike,
} from './drawer-state';

const key = (over: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('open / close / pin', () => {
  it('OpensEmpty_InTheGivenMode', () => {
    const s = open(CLOSED, 'hover');
    expect(s).toMatchObject({ open: true, mode: 'hover', query: '', kb: null });
    expect(s.selected.size).toBe(0);
  });

  it('APinnedRequestPinsAnOpenHoverDrawer', () => {
    expect(open(open(CLOSED, 'hover'), 'pinned').mode).toBe('pinned');
    expect(pin(open(CLOSED, 'hover')).mode).toBe('pinned');
    const pinned = open(CLOSED, 'pinned');
    expect(open(pinned, 'hover')).toBe(pinned);
  });

  it('ClosingForgetsQueryAndSelection', () => {
    const s = toggleMany(setQuery(open(CLOSED, 'pinned'), 'ab'), ['x']);
    expect(close(s)).toEqual(CLOSED);
    expect(close(CLOSED)).toBe(CLOSED);
  });
});

describe('who gets the keyboard (tabs-questions Q5)', () => {
  it('AHoverOpenRightAfterEditorTypingLeavesKeysToTheEditor', () => {
    const s = open(CLOSED, 'hover', false);
    expect(keysCaptured(s)).toBe(false);
    expect(keysCaptured(captureTyping(s))).toBe(true);
    expect(keysCaptured(pin(s))).toBe(true);
  });

  it('APinnedOpenOrAHoverOpenAfterOtherInputCapturesKeys', () => {
    expect(keysCaptured(open(CLOSED, 'pinned', false))).toBe(true);
    expect(keysCaptured(open(CLOSED, 'hover'))).toBe(true);
    expect(keysCaptured(CLOSED)).toBe(false);
  });
});

describe('query', () => {
  it('TypingPinsAHoverDrawer_AndResetsTheKeyboardCursor', () => {
    const s = setQuery(moveKb(open(CLOSED, 'hover'), 1, ['a', 'b'], 'a'), 'x');
    expect(s).toMatchObject({ mode: 'pinned', query: 'x', kb: null });
  });

  it('IsIgnoredWhileClosed', () => {
    expect(setQuery(CLOSED, 'x')).toBe(CLOSED);
  });
});

describe('escape', () => {
  it('ClearsTheQuery_ThenTheSelection_ThenCloses', () => {
    const s = toggleMany(setQuery(open(CLOSED, 'pinned'), 'ab'), ['x']);
    const first = escape(s);
    expect(first).toMatchObject({ open: true, query: '' });
    expect(first.selected.size).toBe(1);
    const second = escape(first);
    expect(second.open).toBe(true);
    expect(second.selected.size).toBe(0);
    expect(escape(second)).toEqual(CLOSED);
  });
});

describe('keyboard cursor', () => {
  const visible = ['a', 'b', 'c', 'd'];

  it('StartsFromTheActiveTab', () => {
    expect(moveKb(open(CLOSED, 'pinned'), 1, visible, 'b').kb).toBe('c');
    expect(moveKb(open(CLOSED, 'pinned'), -1, visible, 'b').kb).toBe('a');
    expect(moveKb(open(CLOSED, 'pinned'), 1, visible, null).kb).toBe('b');
  });

  it('StopsAtTheEnds', () => {
    let s = open(CLOSED, 'pinned');
    for (let i = 0; i < 6; i++) s = moveKb(s, 1, visible, 'a');
    expect(s.kb).toBe('d');
  });

  it('WithAQueryTheTopResultIsTheTarget', () => {
    const s = setQuery(open(CLOSED, 'pinned'), 'x');
    expect(kbTarget(s, ['c', 'a'])).toBe('c');
    expect(enterTarget(s, ['c', 'a'])).toBe('c');
    expect(moveKb(s, 1, ['c', 'a'], 'a').kb).toBe('a');
  });

  it('WithoutAQueryOrArrowsThereIsNoTarget', () => {
    expect(enterTarget(open(CLOSED, 'pinned'), visible)).toBeNull();
  });

  it('ACursorOnATabThatIsNoLongerVisibleIsIgnored', () => {
    const s = moveKb(open(CLOSED, 'pinned'), 1, visible, 'b');
    expect(kbTarget(s, ['a', 'b'])).toBeNull();
  });
});

describe('selection and shift', () => {
  it('ToggleManyFlipsEachId', () => {
    const s = toggleMany(toggleMany(open(CLOSED, 'pinned'), ['a', 'b']), ['b', 'c']);
    expect([...s.selected].sort()).toEqual(['a', 'c']);
    expect(clearSelection(s).selected.size).toBe(0);
  });

  it('TheBottomHintShowsOnlyWhileShiftIsHeldInAnOpenDrawer', () => {
    expect(hintVisible(setShift(open(CLOSED, 'pinned'), true))).toBe(true);
    expect(hintVisible(open(CLOSED, 'pinned'))).toBe(false);
    expect(hintVisible(setShift(CLOSED, true))).toBe(false);
  });
});

describe('drawerKeyAction', () => {
  it('Escape', () => {
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape' }), '', true)).toEqual({ kind: 'escape' });
  });

  it('SortsOnTheCommandKeyByPhysicalKey', () => {
    expect(drawerKeyAction(key({ key: 'l', code: 'KeyL', metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'opened' });
    expect(drawerKeyAction(key({ key: 'д', code: 'KeyL', metaKey: true }), '', true)).toEqual({ kind: 'sort', sort: 'opened' });
    expect(drawerKeyAction(key({ key: 'r', code: 'KeyR', metaKey: true }), 'q', true)).toEqual({ kind: 'sort', sort: 'viewed' });
    expect(drawerKeyAction(key({ key: 'u', code: 'KeyU', ctrlKey: true }), '', false)).toEqual({ kind: 'sort', sort: 'ai' });
  });

  it('LeavesOtherModifiedKeysAlone', () => {
    expect(drawerKeyAction(key({ key: 'u', code: 'KeyU', ctrlKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'j', code: 'KeyJ', metaKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: '≈', code: 'KeyX', altKey: true }), '', true)).toEqual({ kind: 'none' });
  });

  it('TypesPrintableCharacters_InAnyLayout', () => {
    expect(drawerKeyAction(key({ key: 'в', code: 'KeyD' }), '', true)).toEqual({ kind: 'type', char: 'в' });
    expect(drawerKeyAction(key({ key: 'A', code: 'KeyA', shiftKey: true }), '', true)).toEqual({ kind: 'type', char: 'A' });
  });

  it('ALeadingSpaceIsNotASearch', () => {
    expect(drawerKeyAction(key({ key: ' ', code: 'Space' }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: ' ', code: 'Space' }), 'a', true)).toEqual({ kind: 'type', char: ' ' });
  });

  it('BackspaceEditsTheQueryOnly', () => {
    expect(drawerKeyAction(key({ key: 'Backspace', code: 'Backspace' }), 'ab', true)).toEqual({ kind: 'backspace' });
    expect(drawerKeyAction(key({ key: 'Backspace', code: 'Backspace' }), '', true)).toEqual({ kind: 'none' });
  });

  it('ArrowsAndEnter', () => {
    expect(drawerKeyAction(key({ key: 'ArrowDown', code: 'ArrowDown' }), '', true)).toEqual({ kind: 'move', delta: 1 });
    expect(drawerKeyAction(key({ key: 'ArrowUp', code: 'ArrowUp' }), '', true)).toEqual({ kind: 'move', delta: -1 });
    expect(drawerKeyAction(key({ key: 'Enter', code: 'Enter' }), '', true)).toEqual({ kind: 'enter' });
    expect(drawerKeyAction(key({ key: 'Tab', code: 'Tab' }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), '', true)).toEqual({ kind: 'none' });
  });
});
