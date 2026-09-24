import { describe, it, expect } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import {
  resolveShowTarget,
  changedLineRanges,
  docRangesForLineRanges,
  buildAiEdit,
  applyAiEditToState,
} from './ai-commands';
import { aiHighlightField, aiHighlightRanges } from './editor/ai-highlight';
import { computeReplacement, computeChangedLineRanges } from './editor/content-diff';

function makeState(doc: string): EditorState {
  return EditorState.create({ doc });
}

describe('resolveShowTarget', () => {
  it('resolves a 1-based line to the start of that line', () => {
    const state = makeState('line1\nline2\nline3\n');
    expect(resolveShowTarget(state, { line: 2, find: null })).toBe(state.doc.line(2).from);
  });

  it('clamps a line number below 1 up to the first line', () => {
    const state = makeState('line1\nline2\n');
    expect(resolveShowTarget(state, { line: 0, find: null })).toBe(state.doc.line(1).from);
    expect(resolveShowTarget(state, { line: -5, find: null })).toBe(state.doc.line(1).from);
  });

  it('clamps a line number past the end down to the last line', () => {
    const state = makeState('line1\nline2\nline3\n');
    expect(resolveShowTarget(state, { line: 999, find: null })).toBe(state.doc.line(4).from);
  });

  it('finds the first occurrence of text', () => {
    const state = makeState('hello world, hello moon\n');
    expect(resolveShowTarget(state, { line: null, find: 'hello' })).toBe(0);
    expect(resolveShowTarget(state, { line: null, find: 'moon' })).toBe(19);
  });

  it('returns null when the search text is not found', () => {
    const state = makeState('hello world\n');
    expect(resolveShowTarget(state, { line: null, find: 'nowhere' })).toBeNull();
  });

  it('returns 0 when neither line nor find is given', () => {
    const state = makeState('hello world\n');
    expect(resolveShowTarget(state, { line: null, find: null })).toBe(0);
  });

  it('prefers line over find when both are given', () => {
    const state = makeState('line1\nline2\nline3\n');
    expect(resolveShowTarget(state, { line: 3, find: 'line1' })).toBe(state.doc.line(3).from);
  });
});

describe('changedLineRanges', () => {
  it('reports the single inserted line', () => {
    const oldText = 'aaa\nbbb\nccc\n';
    const newText = 'aaa\nXXX\nccc\n';
    const repl = computeReplacement(oldText, newText)!;
    const state = makeState(newText);
    expect(changedLineRanges(state, repl)).toEqual([2, 2]);
  });

  it('reports a multi-line inclusive range for a multi-line insert', () => {
    const oldText = 'aaa\nccc\n';
    const newText = 'aaa\nbbb\nBBB\nccc\n';
    const repl = computeReplacement(oldText, newText)!;
    const state = makeState(newText);
    expect(changedLineRanges(state, repl)).toEqual([2, 3]);
  });

  it('reports the line at the deletion point for a pure deletion', () => {
    const oldText = 'aaa\nbbb\nccc\n';
    const newText = 'aaa\nccc\n';
    const repl = computeReplacement(oldText, newText)!;
    const state = makeState(newText);
    expect(changedLineRanges(state, repl)).toEqual([2, 2]);
  });

  it('handles an insert at the very start of the document', () => {
    const oldText = 'ccc\n';
    const newText = 'aaa\nbbb\nccc\n';
    const repl = computeReplacement(oldText, newText)!;
    const state = makeState(newText);
    expect(changedLineRanges(state, repl)).toEqual([1, 2]);
  });

  it('handles an append at the very end of the document', () => {
    const oldText = 'aaa\n';
    const newText = 'aaa\nbbb\n';
    const repl = computeReplacement(oldText, newText)!;
    const state = makeState(newText);
    expect(changedLineRanges(state, repl)).toEqual([2, 2]);
  });
});

describe('docRangesForLineRanges', () => {
  it('maps a single-line range to that line span', () => {
    const doc = makeState('aaa\nbbbb\nccccc\n').doc;
    expect(docRangesForLineRanges(doc, [[2, 2]])).toEqual([{ from: 4, to: 8 }]);
  });

  it('maps a multi-line range from the first line start to the last line end', () => {
    const doc = makeState('aaa\nbbbb\nccccc\n').doc;
    expect(docRangesForLineRanges(doc, [[1, 3]])).toEqual([{ from: 0, to: 14 }]);
  });

  it('maps several ranges independently, leaving the gap between them out', () => {
    const doc = makeState('aaa\nbbb\nccc\nddd\n').doc;
    expect(
      docRangesForLineRanges(doc, [
        [1, 1],
        [4, 4],
      ])
    ).toEqual([
      { from: 0, to: 3 },
      { from: 12, to: 15 },
    ]);
  });

  it('yields a zero-width range for a blank line, which the highlight field then drops', () => {
    const doc = makeState('aaa\n\nccc\n').doc;
    expect(docRangesForLineRanges(doc, [[2, 2]])).toEqual([{ from: 4, to: 4 }]);
  });

  it('clamps out-of-range line numbers instead of throwing', () => {
    const doc = makeState('aaa\nbbb\n').doc;
    expect(docRangesForLineRanges(doc, [[0, 99]])).toEqual([{ from: 0, to: 8 }]);
  });

  it('composes with computeChangedLineRanges over the post-change document', () => {
    const oldText = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta';
    const newText = 'alpha\nBETA!\ngamma\ndelta\nepsilon\nZETA!';
    const doc = makeState(newText).doc;
    const ranges = docRangesForLineRanges(doc, computeChangedLineRanges(oldText, newText));
    // Only the two edited lines, with the four untouched lines between them left
    // alone — the whole point of issue #27.
    expect(ranges).toEqual([
      { from: 6, to: 11 },
      { from: 32, to: 37 },
    ]);
    for (const r of ranges) {
      expect(doc.sliceString(r.from, r.to)).not.toContain('\n');
    }
  });
});

describe('buildAiEdit', () => {
  it('NothingToDoForIdenticalContent', () => {
    expect(buildAiEdit(makeState('a\nb'), 'a\nb')).toBeNull();
  });

  it('DescribesTheChangeItsLinesAndItsHighlight', () => {
    const edit = buildAiEdit(makeState('a\nb\nc'), 'a\nB\nc');
    expect(edit).not.toBeNull();
    expect(edit!.changedLines).toEqual([[2, 2]]);
    expect(edit!.from).toBe(2);
    expect(edit!.highlights).toEqual([{ from: 2, to: 3 }]);
  });

  it('APureDeletionReportsTheLineItLandsOn_AndHighlightsNothing', () => {
    const edit = buildAiEdit(makeState('a\nb\nc'), 'a\nc');
    expect(edit!.changedLines).toEqual([[2, 2]]);
    expect(edit!.highlights).toEqual([]);
  });

  it('CrlfAndLoneCrContentIsMeasuredAsTheDocumentWillHoldIt', () => {
    // CM6 splits lines on \r\n and \r as well: a highlight measured on the raw
    // text drifts by one per line and ends past the end of the document.
    const crlf = buildAiEdit(makeState('a\nb\nc'), 'A\r\nb\r\nc\r\nd\r\ne');
    expect(crlf!.changes.apply(Text.of(['a', 'b', 'c'])).toString()).toBe('A\nb\nc\nd\ne');
    // Three of five lines changed: over BLOCK_REWRITE_THRESHOLD, one block,
    // ending exactly at the end of the 9-character document.
    expect(crlf!.highlights).toEqual([{ from: 0, to: 9 }]);
    expect(crlf!.changedLines).toEqual([[1, 5]]);

    const cr = buildAiEdit(makeState('a\nb\nc'), 'a\rB\rc');
    expect(cr!.highlights).toEqual([{ from: 2, to: 3 }]);
    expect(cr!.changedLines).toEqual([[2, 2]]);
  });

  it('CrlfContentEqualToTheDocumentIsNoEdit', () => {
    expect(buildAiEdit(makeState('a\nb'), 'a\r\nb')).toBeNull();
  });
});

describe('applyAiEditToState', () => {
  const state = () => EditorState.create({ doc: 'a\nb\nc', extensions: [history(), aiHighlightField] });

  it('AppliesTheEditWithItsHighlight_AndItIsUndoable', () => {
    const out = applyAiEditToState(state(), 'a\nB\nc', false);
    expect(out!.state.doc.toString()).toBe('a\nB\nc');
    expect(aiHighlightRanges(out!.state)).toEqual([{ from: 2, to: 3 }]);
    const undone: { state: EditorState | null } = { state: null };
    undo({ state: out!.state, dispatch: (tr) => { undone.state = tr.state; } });
    expect(undone.state?.doc.toString()).toBe('a\nb\nc');
  });

  it('WithShowTheCaretGoesToTheChange', () => {
    expect(applyAiEditToState(state(), 'a\nB\nc', true)!.state.selection.main.head).toBe(2);
    expect(applyAiEditToState(state(), 'a\nB\nc', false)!.state.selection.main.head).toBe(0);
  });

  it('NullWhenNothingChanges', () => {
    expect(applyAiEditToState(state(), 'a\nb\nc', true)).toBeNull();
  });

  it('CrlfContentAppliesWithoutARangeError', () => {
    const out = applyAiEditToState(state(), 'A\r\nb\r\nc\r\nd\r\ne', false);
    expect(out!.state.doc.toString()).toBe('A\nb\nc\nd\ne');
    expect(aiHighlightRanges(out!.state)).toEqual([{ from: 0, to: 9 }]);
  });

  it('IsItsOwnUndoStep_EvenRightAfterTheHumanTyped', () => {
    // Within newGroupDelay (500 ms) and adjacent: history would fold the
    // agent's edit into the human's keystroke, and one Cmd+Z would take both.
    const typed = state().update({ changes: { from: 5, insert: 'x' }, userEvent: 'input.type' }).state;
    const out = applyAiEditToState(typed, 'a\nb\ncxy', false);
    expect(undoDepth(out!.state)).toBe(2);
    const undone: { state: EditorState | null } = { state: null };
    undo({ state: out!.state, dispatch: (tr) => { undone.state = tr.state; } });
    expect(undone.state?.doc.toString()).toBe('a\nb\ncx');
  });
});
