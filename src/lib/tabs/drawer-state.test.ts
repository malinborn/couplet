import { describe, it, expect } from 'vitest';
import {
  CLOSED,
  clearSelection,
  close,
  drawerKeyAction,
  enterTarget,
  escape,
  hintVisible,
  kbTarget,
  moveKb,
  neighbourAfterRemoval,
  open,
  pin,
  setKb,
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

describe('hover and pinned (tabs-questions Q5: strictly the spec)', () => {
  it('AHoverOpenDiffersFromAPinnedOneOnlyInItsMode', () => {
    // Nothing in the state says "the keys are still the editor's".
    expect({ ...open(CLOSED, 'hover'), mode: 'pinned' }).toEqual(open(CLOSED, 'pinned'));
  });

  it('PinningAPinnedDrawerChangesNothing', () => {
    const pinned = open(CLOSED, 'pinned');
    expect(pin(pinned)).toBe(pinned);
    expect(pin(CLOSED)).toBe(CLOSED);
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

  it('AnEmptyQueryLeavesAHoverDrawerClosingOnLeave', () => {
    expect(setQuery(open(CLOSED, 'hover'), '').mode).toBe('hover');
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
  });

  it('WithoutACursorOrAVisibleActiveTab_StartsAtTheEnd_TheArrowPointsFrom', () => {
    expect(moveKb(open(CLOSED, 'pinned'), 1, visible, null).kb).toBe('a');
    expect(moveKb(open(CLOSED, 'pinned'), -1, visible, null).kb).toBe('d');
    expect(moveKb(open(CLOSED, 'pinned'), 1, visible, 'gone').kb).toBe('a');
    expect(moveKb(open(CLOSED, 'pinned'), -1, visible, 'gone').kb).toBe('d');
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

  it('SetKbMovesTheRing_OnlyWhileOpen', () => {
    expect(setKb(open(CLOSED, 'pinned'), 'b').kb).toBe('b');
    expect(setKb(CLOSED, 'b')).toBe(CLOSED);
    const s = setKb(open(CLOSED, 'pinned'), 'b');
    expect(setKb(s, 'b')).toBe(s);
  });

  it('ARemovedCardHandsTheKeyboardToTheNextSurvivor_ElseTheOneAbove', () => {
    expect(neighbourAfterRemoval(visible, ['a', 'c', 'd'], 'b')).toBe('c');
    expect(neighbourAfterRemoval(visible, ['a', 'd'], 'b')).toBe('d');
    expect(neighbourAfterRemoval(visible, ['a', 'b'], 'd')).toBe('b');
    expect(neighbourAfterRemoval(visible, [], 'b')).toBeNull();
    expect(neighbourAfterRemoval(visible, visible, 'gone')).toBeNull();
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
  it('CmdGOpensTheCarousel_CmdMIsNotTheDrawers', () => {
    expect(drawerKeyAction(key({ key: 'g', code: 'KeyG', metaKey: true }), '', true)).toEqual({ kind: 'carousel' });
    expect(drawerKeyAction(key({ key: 'g', code: 'KeyG', ctrlKey: true }), '', false)).toEqual({ kind: 'carousel' });
    // Matched on the code: ⌘П in a Cyrillic layout is still ⌘G.
    expect(drawerKeyAction(key({ key: 'п', code: 'KeyG', metaKey: true }), '', true)).toEqual({ kind: 'carousel' });
    // ⇧⌘G stays CodeMirror's findPrevious.
    expect(drawerKeyAction(key({ key: 'G', code: 'KeyG', metaKey: true, shiftKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'g', code: 'KeyG' }), '', true)).toEqual({ kind: 'type', char: 'g' });
    // ⌘M is macOS Minimize, a native item: never the drawer's.
    expect(drawerKeyAction(key({ key: 'm', code: 'KeyM', metaKey: true }), '', true)).toEqual({ kind: 'none' });
  });

  it('DeleteAndBackspaceCloseASelection_BackspaceOnlyWithAnEmptyQuery', () => {
    const del = key({ key: 'Delete', code: 'Delete' });
    const bs = key({ key: 'Backspace', code: 'Backspace' });
    expect(drawerKeyAction(del, '', true, true)).toEqual({ kind: 'close-selected' });
    expect(drawerKeyAction(del, 'rea', true, true)).toEqual({ kind: 'close-selected' });
    expect(drawerKeyAction(bs, '', true, true)).toEqual({ kind: 'close-selected' });
    expect(drawerKeyAction(bs, 'rea', true, true), 'the query still loses a character').toEqual({ kind: 'backspace' });
    // Any modifiers: ⇧ is often still held from selecting; ⌘⌫ means nothing here.
    expect(drawerKeyAction(key({ key: 'Delete', code: 'Delete', shiftKey: true }), '', true, true)).toEqual({ kind: 'close-selected' });
    expect(drawerKeyAction(key({ key: 'Backspace', code: 'Backspace', metaKey: true }), '', true, true)).toEqual({
      kind: 'close-selected',
    });
  });

  it('WithoutASelectionDeleteAndBackspaceAreWhatTheyWere', () => {
    const del = key({ key: 'Delete', code: 'Delete' });
    const bs = key({ key: 'Backspace', code: 'Backspace' });
    expect(drawerKeyAction(del, '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(bs, '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(bs, 'rea', true)).toEqual({ kind: 'backspace' });
    expect(drawerKeyAction(del, '', true, false)).toEqual({ kind: 'none' });
  });

  it('Escape', () => {
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape' }), '', true)).toEqual({ kind: 'escape' });
  });

  it('EscapeOnlyWithoutModifiers', () => {
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape', metaKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape', ctrlKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape', altKey: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape', shiftKey: true }), '', true)).toEqual({ kind: 'none' });
  });

  it('IgnoresKeysDuringImeComposition', () => {
    expect(drawerKeyAction(key({ key: 'a', code: 'KeyA', isComposing: true }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Process', code: 'KeyA', keyCode: 229 }), '', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Enter', code: 'Enter', isComposing: true }), 'a', true)).toEqual({ kind: 'none' });
    expect(drawerKeyAction(key({ key: 'Escape', code: 'Escape', keyCode: 229 }), 'a', true)).toEqual({ kind: 'none' });
  });

  it('OptionLettersAreText_OnAMac', () => {
    expect(drawerKeyAction(key({ key: 'ą', code: 'KeyA', altKey: true }), '', true)).toEqual({ kind: 'type', char: 'ą' });
    expect(drawerKeyAction(key({ key: '≈', code: 'KeyX', altKey: true }), '', true)).toEqual({ kind: 'type', char: '≈' });
    expect(drawerKeyAction(key({ key: 'ą', code: 'KeyA', altKey: true, metaKey: true }), '', true)).toEqual({ kind: 'none' });
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
    expect(drawerKeyAction(key({ key: 'Dead', code: 'KeyE', altKey: true }), '', true)).toEqual({ kind: 'none' });
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
