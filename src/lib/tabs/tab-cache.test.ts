import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import { addAiAsk, aiAskField, activeAskIds } from '../editor/ai-ask';
import { addAiComment, aiCommentField, type CommentActions } from '../editor/ai-comment';
import { jsonOfferField, setJsonOffer } from '../editor/json-paste';
import { aiHighlightField, aiHighlightRanges, setAiHighlights } from '../editor/ai-highlight';
import { decideEnter, leaveEffects } from './tab-cache';

const actions: CommentActions = {
  save: vi.fn(),
  flush: vi.fn(),
  sendNow: vi.fn(),
  resolve: vi.fn(),
  handoff: vi.fn(),
  insertIntoText: vi.fn(),
};

function busyState(): EditorState {
  const base = EditorState.create({
    doc: 'hello world',
    extensions: [history(), aiAskField, aiCommentField, jsonOfferField, aiHighlightField],
  });
  return base
    .update({ changes: { from: 11, insert: '!' } })
    .state.update({
      effects: [
        addAiAsk.of({
          spec: { id: 7, question: 'Q?', options: ['a', 'b'], multi: false, freeText: false, onAnswer: vi.fn() },
          pos: 0,
        }),
        addAiComment.of({
          thread: { id: 'c-1', status: 'open', line: 1, quote: 'hello', replies: [] },
          pos: 0,
          to: 5,
          orphaned: false,
          actions,
        }),
        setJsonOffer.of({ from: 0, to: 5 }),
        setAiHighlights.of([{ from: 0, to: 5 }]),
      ],
    }).state;
}

describe('leaveEffects', () => {
  it('StripsAsksCommentCardsAndTheJsonOffer', () => {
    const before = busyState();
    expect(activeAskIds(before)).toEqual([7]);
    expect(before.field(aiCommentField).size).toBeGreaterThan(0);
    expect(before.field(jsonOfferField)).not.toBeNull();

    const after = before.update({ effects: leaveEffects() }).state;
    expect(activeAskIds(after)).toEqual([]);
    expect(after.field(aiCommentField).size).toBe(0);
    expect(after.field(jsonOfferField)).toBeNull();
  });

  it('KeepsTheTextTheCaretTheUndoHistoryAndAiHighlights', () => {
    const before = busyState();
    const after = before.update({ effects: leaveEffects() }).state;
    expect(after.doc.toString()).toBe('hello world!');
    expect(after.selection.main.head).toBe(before.selection.main.head);
    expect(undoDepth(after)).toBe(1);
    // An agent's edit the user has not looked at yet must still be marked on return.
    expect(aiHighlightRanges(after)).toHaveLength(1);
  });
});

describe('decideEnter', () => {
  it('ReusesTheCacheWhenTheDiskIsUnchanged', () => {
    expect(decideEnter({ baseline: 'a', disk: 'a' })).toBe('use-cache');
    expect(decideEnter({ baseline: null, disk: null })).toBe('use-cache');
  });

  it('ReloadsWhenTheFileChangedOrAppearedOrVanished', () => {
    expect(decideEnter({ baseline: 'a', disk: 'b' })).toBe('load-fresh');
    expect(decideEnter({ baseline: null, disk: 'new' })).toBe('load-fresh');
    expect(decideEnter({ baseline: 'a', disk: null })).toBe('load-fresh');
  });
});
