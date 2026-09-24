// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';
import { createDocumentState } from './state-factory';
import { aiAskField } from './ai-ask';

describe('createDocumentState', () => {
  it('StartsEveryDocumentWithAnEmptyHistory', () => {
    // The property plan 01 had to force with a compartment reset: undo can
    // never reach into whatever the window showed before.
    const edited = createDocumentState('a', null, []).update({ changes: { from: 1, insert: 'b' } }).state;
    expect(undoDepth(edited)).toBe(1);
    expect(undoDepth(createDocumentState('fresh', null, []))).toBe(0);
  });

  it('PutsTheCaretAtTheEndWhenNoCursorIsGiven', () => {
    expect(createDocumentState('hello', null, []).selection.main.head).toBe(5);
  });

  it('ClampsAGivenCursorIntoTheDocument', () => {
    expect(createDocumentState('hello', 999, []).selection.main.head).toBe(5);
    expect(createDocumentState('hello', -3, []).selection.main.head).toBe(0);
    expect(createDocumentState('hello', 2, []).selection.main.head).toBe(2);
  });

  it('CarriesTheFullEditorConfigurationPlusExtras', () => {
    const marker = StateField.define<number>({ create: () => 42, update: (v) => v });
    const state = createDocumentState('x', null, [marker]);
    expect(state.field(marker)).toBe(42);
    expect(state.field(aiAskField, false)).toBeDefined();
  });
});

describe('the undo leak a whole-state swap closes', () => {
  it('a full-document replace with addToHistory(false) does not clear a deletion-based undo entry', () => {
    // A HistEvent stores the INVERT of the user's edit. The invert of a
    // deletion is an insertion at a position, which survives being mapped
    // through a full-document replace — so a load that rewrites the document
    // inside the old state lets Cmd+Z splice the old text into the new one.
    const view = new EditorView({
      state: EditorState.create({ doc: 'A1', extensions: [history()] }),
    });
    view.dispatch({ changes: { from: 1, to: 2 } });

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'B' },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    undo(view);
    expect(view.state.doc.toString()).not.toBe('B');
    view.destroy();
  });

  it('SwappingInAFreshStateLeavesNothingToUndo_EvenAfterADeletion', () => {
    const view = new EditorView({ state: createDocumentState('A1', null, []) });
    view.dispatch({ changes: { from: 1, to: 2 } });
    expect(undoDepth(view.state)).toBe(1);

    view.setState(createDocumentState('B', null, []));

    expect(undoDepth(view.state)).toBe(0);
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('B');
    view.destroy();
  });

  it('SwappingInAFreshStateLeavesNothingToUndo_AfterAnInsertion', () => {
    const view = new EditorView({ state: createDocumentState('A', null, []) });
    view.dispatch({ changes: { from: 1, insert: '1' } });

    view.setState(createDocumentState('B', null, []));

    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('B');
    view.destroy();
  });
});
