import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { replaceContentSpec } from './replace-content';

describe('replaceContentSpec', () => {
  it('RawCaretAtStringLength_IsWhatUsedToThrow', () => {
    // The original bug, pinned so the test below means something: an anchor
    // at the raw string's length lies past the end of the document CM6 builds.
    const state = EditorState.create({ doc: '' });
    const raw = 'a\r\nb\r\n';
    expect(() =>
      state.update({ changes: { from: 0, insert: raw }, selection: { anchor: raw.length } })
    ).toThrow(RangeError);
  });

  it('CrlfInput_DoesNotThrow_AndYieldsTheNormalizedDoc', () => {
    const state = EditorState.create({ doc: 'old content' });
    const next = state.update(replaceContentSpec(state, 'a\r\nb\r\n')).state;
    expect(next.doc.toString()).toBe('a\nb\n');
    expect(next.selection.main.anchor).toBe(next.doc.length);
  });

  it('LoneCrInput_DoesNotThrow', () => {
    const state = EditorState.create({ doc: '' });
    const next = state.update(replaceContentSpec(state, 'x\ry\rz')).state;
    expect(next.doc.toString()).toBe('x\ny\nz');
    expect(next.selection.main.anchor).toBe(5);
  });

  it('LfInput_CaretAtEnd', () => {
    const state = EditorState.create({ doc: 'something' });
    const next = state.update(replaceContentSpec(state, 'a\nb')).state;
    expect(next.doc.toString()).toBe('a\nb');
    expect(next.selection.main.anchor).toBe(3);
  });

  it('EmptyInput_ClearsTheDocument', () => {
    const state = EditorState.create({ doc: 'something' });
    const next = state.update(replaceContentSpec(state, '')).state;
    expect(next.doc.length).toBe(0);
  });
});
