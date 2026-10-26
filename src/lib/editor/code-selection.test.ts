import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from './markdown-language';
import { codeSelection } from './code-selection';

function stateOf(doc: string, ...ranges: [number, number][]): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b))),
    extensions: [markdownExtension(), EditorState.allowMultipleSelections.of(true)],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

const all = (state: EditorState) => codeSelection(state, 0, state.doc.length);

describe('codeSelection — the selection over code, painted from inside', () => {
  const INLINE = 'path (локально) / `D_HR_PLATFORM_URL` here';
  const tick = INLINE.indexOf('`');
  const close = INLINE.lastIndexOf('`');

  it('marks the part of a selection that runs into inline code (the reported case)', () => {
    const state = stateOf(INLINE, [7, tick + 8]);
    expect(all(state).marks).toEqual([{ from: tick, to: tick + 8 }]);
  });

  it('clips to the code node when the selection covers it and more', () => {
    const state = stateOf(INLINE, [0, INLINE.length]);
    expect(all(state).marks).toEqual([{ from: tick, to: close + 1 }]);
  });

  it('marks nothing outside code, and nothing for an empty selection', () => {
    expect(all(stateOf(INLINE, [0, 5])).marks).toEqual([]);
    expect(all(stateOf(INLINE, [tick + 3, tick + 3])).marks).toEqual([]);
  });

  it('marks every selection range over code', () => {
    const doc = '`a` and `b`';
    const state = stateOf(doc, [0, 3], [8, 11]);
    expect(all(state).marks).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
    ]);
  });

  it('marks a fenced block and flags the lines selected through their line break', () => {
    const doc = 'before\n```js\nconst a = 1;\n\nconst b = 2;\n```\nafter';
    const state = stateOf(doc, [0, doc.length]);
    const fenceFrom = doc.indexOf('```');
    const fenceTo = doc.lastIndexOf('```') + 3;
    const result = all(state);
    expect(result.marks).toEqual([{ from: fenceFrom, to: fenceTo }]);
    // Every line of the block, fences included (the CSS skips those).
    const blockLines = [2, 3, 4, 5, 6].map((n) => state.doc.line(n).from);
    expect(result.fullLines).toEqual(blockLines);
  });

  it('flags a line only when the selection covers its start and its break', () => {
    const doc = '```\nabc\n\nd\n```';
    const abc = doc.indexOf('abc');
    const empty = doc.indexOf('\n\n') + 1;
    // Ends at the empty line's start: its break is not selected.
    expect(all(stateOf(doc, [abc, empty])).fullLines).toEqual([abc]);
    // Starts mid-line: that line is partial, the empty one is whole.
    expect(all(stateOf(doc, [abc + 1, empty + 1])).fullLines).toEqual([empty]);
    // Ends at the line's end, before the break.
    expect(all(stateOf(doc, [abc, abc + 3])).fullLines).toEqual([]);
  });

  it('flags a quoted fenced line by its raw start, quote prefix included', () => {
    const doc = '> ```\n> a\n>\n> b\n> ```';
    const empty = doc.indexOf('>\n> b');
    const result = all(stateOf(doc, [doc.indexOf('> a'), doc.indexOf('> b') + 3]));
    expect(result.fullLines).toContain(empty);
  });

  it('stays within the given visible range', () => {
    const state = stateOf(INLINE, [0, INLINE.length]);
    expect(codeSelection(state, 0, tick + 4).marks).toEqual([{ from: tick, to: tick + 4 }]);
  });
});
