import { describe, it, expect, vi } from 'vitest';
import { EditorSelection, EditorState, type StateEffect } from '@codemirror/state';
import { codeFolding, foldEffect, foldedRanges } from '@codemirror/language';
import { aiHighlightField, setAiHighlights, type AiHighlightRange } from './ai-highlight';
import { aiCommentField, addAiComment, type CommentActions } from './ai-comment';
import { aiAskField, addAiAsk, type AskSpec } from './ai-ask';
import { aiMarkJump, aiMarkPositions, nextAiMark, searchFrom } from './ai-mark-nav';
import type { CommentThread } from '../comment-format';

// Line starts: 0, 6, 12, 18, 24. Every line is five letters and a newline.
const DOC = 'aaaaa\nbbbbb\nccccc\nddddd\neeeee';

function makeState(doc = DOC, head = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(head),
    extensions: [aiHighlightField, aiCommentField, aiAskField, codeFolding()],
  });
}

function withEffects(state: EditorState, effects: StateEffect<unknown>[]): EditorState {
  return state.update({ effects }).state;
}

function highlight(ranges: AiHighlightRange[]): StateEffect<unknown> {
  return setAiHighlights.of(ranges);
}

function actions(): CommentActions {
  return {
    save: vi.fn(),
    flush: vi.fn(),
    sendNow: vi.fn(),
    resolve: vi.fn(),
    handoff: vi.fn(),
    insertIntoText: vi.fn(),
  };
}

function comment(id: string, pos: number, to: number, orphaned = false): StateEffect<unknown> {
  const thread: CommentThread = { id, status: 'open', line: 1, quote: 'q', replies: [] };
  return addAiComment.of({ thread, pos, to, orphaned, actions: actions() });
}

function ask(id: number, pos: number): StateEffect<unknown> {
  const spec: AskSpec = {
    id,
    question: 'Continue?',
    options: ['Yes', 'No'],
    multi: false,
    freeText: false,
    onAnswer: vi.fn(),
  };
  return addAiAsk.of({ spec, pos });
}

function at(state: EditorState, head: number): EditorState {
  return state.update({ selection: EditorSelection.cursor(head) }).state;
}

describe('aiMarkPositions', () => {
  it('is empty when nothing is marked', () => {
    expect(aiMarkPositions(makeState())).toEqual([]);
  });

  it('is empty when the AI fields are not installed at all', () => {
    expect(aiMarkPositions(EditorState.create({ doc: DOC }))).toEqual([]);
  });

  it('takes the start of each highlighted span', () => {
    const state = withEffects(makeState(), [highlight([{ from: 14, to: 16 }, { from: 2, to: 4 }])]);
    expect(aiMarkPositions(state)).toEqual([2, 14]);
  });

  it('merges overlapping highlighted spans into one mark', () => {
    const state = withEffects(makeState(), [highlight([{ from: 2, to: 8 }, { from: 5, to: 10 }])]);
    expect(aiMarkPositions(state)).toEqual([2]);
  });

  it('merges adjacent highlighted spans into one mark', () => {
    const state = withEffects(makeState(), [highlight([{ from: 2, to: 5 }, { from: 5, to: 9 }])]);
    expect(aiMarkPositions(state)).toEqual([2]);
  });

  it('keeps spans separated by a gap apart', () => {
    const state = withEffects(makeState(), [highlight([{ from: 2, to: 5 }, { from: 6, to: 9 }])]);
    expect(aiMarkPositions(state)).toEqual([2, 6]);
  });

  it('takes the start of a comment anchor, not its card', () => {
    // The card sits at the end of line 2 (11); the anchor starts at 7.
    const state = withEffects(makeState(), [comment('c-1', 7, 10)]);
    expect(aiMarkPositions(state)).toEqual([7]);
  });

  it('takes the card position for a thread with no anchor', () => {
    const state = withEffects(makeState(), [comment('c-1', 13, 13, true)]);
    expect(aiMarkPositions(state)).toEqual([17]);
  });

  it('falls back to the card once the anchor text is deleted', () => {
    let state = withEffects(makeState(), [comment('c-1', 7, 10)]);
    state = state.update({ changes: { from: 7, to: 10 } }).state;
    // Line 2 is now "bb", ending at 8.
    expect(aiMarkPositions(state)).toEqual([8]);
  });

  it('takes the widget position of a question', () => {
    const state = withEffects(makeState(), [ask(1, 20)]);
    expect(aiMarkPositions(state)).toEqual([23]);
  });

  it('merges all three sources in document order', () => {
    const state = withEffects(makeState(), [
      ask(1, 25),
      highlight([{ from: 14, to: 16 }]),
      comment('c-1', 1, 3),
      comment('c-2', 19, 19, true),
    ]);
    expect(aiMarkPositions(state)).toEqual([1, 14, 23, 29]);
  });

  it('counts several marks at one position once', () => {
    const state = withEffects(makeState(), [
      highlight([{ from: 7, to: 9 }]),
      comment('c-1', 7, 10),
      comment('c-2', 7, 8),
      ask(1, 0),
      comment('c-3', 0, 0, true),
    ]);
    // The ask and the orphaned card both sit at the end of line 1.
    expect(aiMarkPositions(state)).toEqual([5, 7]);
  });
});

describe('nextAiMark', () => {
  const marked = (): EditorState =>
    withEffects(makeState(), [highlight([{ from: 2, to: 4 }, { from: 14, to: 16 }, { from: 26, to: 28 }])]);

  it('returns null when there are no marks, in both directions', () => {
    expect(nextAiMark(makeState(), 1)).toBeNull();
    expect(nextAiMark(makeState(), -1)).toBeNull();
  });

  it('goes to the first mark strictly after the caret', () => {
    expect(nextAiMark(at(marked(), 8), 1)).toBe(14);
  });

  it('goes to the last mark strictly before the caret', () => {
    expect(nextAiMark(at(marked(), 20), -1)).toBe(14);
  });

  it('moves past a mark the caret is sitting on, forwards', () => {
    expect(nextAiMark(at(marked(), 14), 1)).toBe(26);
  });

  it('moves past a mark the caret is sitting on, backwards', () => {
    expect(nextAiMark(at(marked(), 14), -1)).toBe(2);
  });

  it('wraps from after the last mark to the first', () => {
    expect(nextAiMark(at(marked(), 27), 1)).toBe(2);
    expect(nextAiMark(at(marked(), 26), 1)).toBe(2);
  });

  it('wraps from before the first mark to the last', () => {
    expect(nextAiMark(at(marked(), 1), -1)).toBe(26);
    expect(nextAiMark(at(marked(), 2), -1)).toBe(26);
  });

  it('with a single mark under the caret, lands on it again', () => {
    const state = at(withEffects(makeState(), [ask(1, 0)]), 5);
    expect(nextAiMark(state, 1)).toBe(5);
    expect(nextAiMark(state, -1)).toBe(5);
  });

  it('measures from the selection head, not its anchor', () => {
    const state = marked().update({ selection: EditorSelection.range(20, 3) }).state;
    expect(nextAiMark(state, 1)).toBe(14);
  });
});

describe('aiMarkJump', () => {
  it('returns null when there are no marks', () => {
    expect(aiMarkJump(makeState(), 1)).toBeNull();
  });

  it('collapses the selection onto the mark', () => {
    const state = withEffects(makeState(), [highlight([{ from: 14, to: 16 }])]);
    const selected = state.update({ selection: EditorSelection.range(0, 3) }).state;
    const spec = aiMarkJump(selected, 1);
    expect(spec).not.toBeNull();
    const next = selected.update(spec!).state;
    expect(next.selection.main.empty).toBe(true);
    expect(next.selection.main.head).toBe(14);
  });

  it('unfolds a folded region that hides the target', () => {
    let state = withEffects(makeState(), [highlight([{ from: 14, to: 16 }])]);
    state = withEffects(state, [foldEffect.of({ from: 5, to: 23 })]);
    const count = (s: EditorState): number => {
      let n = 0;
      foldedRanges(s).between(0, s.doc.length, () => {
        n++;
      });
      return n;
    };
    expect(count(state)).toBe(1);
    const spec = aiMarkJump(state, 1)!;
    const next = state.update(spec).state;
    expect(count(next)).toBe(0);
    expect(next.selection.main.head).toBe(14);
    // Without the selection, so CM6's own "caret landed in a fold" cleanup
    // cannot be what opened it.
    const effectsOnly = state.update({ effects: spec.effects }).state;
    expect(count(effectsOnly)).toBe(0);
  });

  it('leaves a fold that does not contain the target alone', () => {
    let state = withEffects(makeState(), [highlight([{ from: 26, to: 28 }])]);
    state = withEffects(state, [foldEffect.of({ from: 5, to: 17 })]);
    const next = state.update(aiMarkJump(state, 1)!).state;
    let n = 0;
    foldedRanges(next).between(0, next.doc.length, () => {
      n++;
    });
    expect(n).toBe(1);
  });
});

describe('searchFrom', () => {
  it('is the caret head with no previous jump', () => {
    expect(searchFrom(makeState(DOC, 7), undefined)).toBe(7);
  });

  it('resumes from the mark when the caret was nudged off it and has not moved', () => {
    // live-render pushed the caret from 14 back to 13; the next search must
    // start past 14, not find it again.
    const state = withEffects(makeState(DOC, 13), [
      highlight([
        { from: 14, to: 16 },
        { from: 26, to: 28 },
      ]),
    ]);
    const from = searchFrom(state, { doc: state.doc, target: 14, landed: 13 });
    expect(from).toBe(14);
    expect(nextAiMark(state, 1, from)).toBe(26);
  });

  it('forgets the jump once the caret moved', () => {
    const state = makeState(DOC, 20);
    expect(searchFrom(state, { doc: state.doc, target: 14, landed: 13 })).toBe(20);
  });

  it('forgets the jump once the document changed', () => {
    const before = makeState(DOC, 13);
    const after = before.update({ changes: { from: 28, insert: 'x' } }).state;
    expect(after.selection.main.head).toBe(13);
    expect(searchFrom(after, { doc: before.doc, target: 14, landed: 13 })).toBe(13);
  });
});
