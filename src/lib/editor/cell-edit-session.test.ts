import { describe, it, expect } from 'vitest';
import { minimalEdit } from './cell-edit-session';

/**
 * `minimalEdit` is what keeps Cmd+Z meaningful inside a cell edit overlay
 * (#60). Assigning `textarea.value` wipes the element's native undo stack, so a
 * format toggle would take the user's own typing down with it; narrowing the
 * rewrite to the changed span lets it go through `execCommand('insertText')`,
 * which the browser records as one undoable edit.
 *
 * The overlay itself is DOM and untestable here (no jsdom in this project's
 * vitest setup) — this is the half that can be pinned down.
 */
describe('minimalEdit', () => {
  it('reports nothing for an unchanged string', () => {
    expect(minimalEdit('abc', 'abc')).toBeNull();
  });

  it('narrows a wrap to the wrapped word', () => {
    expect(minimalEdit('one two three', 'one **two** three')).toEqual({
      from: 4,
      to: 7,
      insert: '**two**',
    });
  });

  it('narrows an unwrap the same way', () => {
    expect(minimalEdit('one **two** three', 'one two three')).toEqual({
      from: 4,
      to: 11,
      insert: 'two',
    });
  });

  it('does not let prefix and suffix overlap on repeating text', () => {
    // Both strings are runs of the same character, so a suffix scan that was
    // not bounded by what the prefix already consumed would walk past it and
    // produce a negative-length replacement.
    const edit = minimalEdit('**', '****');
    expect(edit).not.toBeNull();
    expect(edit!.to).toBeGreaterThanOrEqual(edit!.from);
    expect('**'.slice(0, edit!.from) + edit!.insert + '**'.slice(edit!.to)).toBe('****');
  });

  it('round-trips: applying the edit reproduces the new text', () => {
    const cases: [string, string][] = [
      ['hello', '**hello**'],
      ['**hello**', 'hello'],
      ['a | b', 'a | *b*'],
      ['', '``'],
      ['~~x~~', 'x'],
      ['раз два', 'раз **два**'],
    ];
    for (const [before, after] of cases) {
      const edit = minimalEdit(before, after);
      expect(edit).not.toBeNull();
      expect(before.slice(0, edit!.from) + edit!.insert + before.slice(edit!.to)).toBe(after);
    }
  });

  it('handles a pure deletion', () => {
    const edit = minimalEdit('a**b**c', 'a**b**');
    expect(edit).toEqual({ from: 6, to: 7, insert: '' });
  });
});
