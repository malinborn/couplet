// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';
import { loadDocumentContent } from './document-load';

describe('the undo leak this file fixes', () => {
  it('a full-document replace with addToHistory(false) does not clear a deletion-based undo entry', () => {
    // A HistEvent stores the INVERT of the user's edit, not the edit itself.
    // A full-doc replace maps every existing entry's stored changes through
    // itself: the invert of a user INSERTION is a deletion, which maps to
    // empty over a full-doc replace and gets dropped (undoDepth back to 0 —
    // that shape does not leak). The invert of a user DELETION is an
    // INSERTION at a position, and that survives the mapping — undo still
    // has something to reapply, and it splices the deleted text back into
    // whatever now occupies that position in the new document.
    const view = new EditorView({
      state: EditorState.create({ doc: 'A1', extensions: [history()] }),
    });

    // A normal, recorded edit in document A1: the user deletes '1'.
    view.dispatch({ changes: { from: 1, to: 2 } });
    expect(view.state.doc.toString()).toBe('A');
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    // Today's `replaceContent`: full-doc swap, `addToHistory(false)` on the
    // swap itself — but the history extension stays mounted, and nothing
    // clears what it already recorded for document A.
    const docLen = view.state.doc.length;
    view.dispatch({
      changes: { from: 0, to: docLen, insert: 'B' },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(view.state.doc.toString()).toBe('B');
    expect(undoDepth(view.state)).toBeGreaterThan(0); // the leak: the deletion's invert survived

    // Cmd+Z reaches back into document A's recorded edit instead of doing
    // nothing, because the history stack was never reset — it splices the
    // old text ('1') into the new document ('B').
    undo(view);
    expect(view.state.doc.toString()).not.toBe('B');
    view.destroy();
  });
});

describe('loadDocumentContent', () => {
  function makeView(doc: string, historyCompartment: Compartment): EditorView {
    return new EditorView({
      state: EditorState.create({ doc, extensions: [historyCompartment.of(history())] }),
    });
  }

  it('resets undo depth to zero after loading a new document', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);
    view.dispatch({ changes: { from: 1, to: 1, insert: '1' } }); // doc A1, undo depth 1

    loadDocumentContent(view, historyCompartment, 'B');

    expect(view.state.doc.toString()).toBe('B');
    expect(undoDepth(view.state)).toBe(0);
    view.destroy();
  });

  it('undo after loading a new document is a no-op — it never reaches the previous document', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);
    view.dispatch({ changes: { from: 1, to: 1, insert: '1' } });

    loadDocumentContent(view, historyCompartment, 'B');
    const ranUndo = undo(view);

    expect(ranUndo).toBe(false);
    expect(view.state.doc.toString()).toBe('B');
    view.destroy();
  });

  it('resets undo depth to zero after loading a new document, even for a deletion-based entry', () => {
    // The asymmetry from the describe block above: an insertion's invert
    // (a deletion) already maps away on a plain full-doc replace, but a
    // deletion's invert (an insertion) survives it. loadDocumentContent must
    // guarantee undoDepth === 0 for both — that's the whole point of
    // dropping and rebuilding the history compartment instead of relying on
    // the mapping.
    const historyCompartment = new Compartment();
    const view = makeView('A1', historyCompartment);
    view.dispatch({ changes: { from: 1, to: 2 } }); // doc A, undo depth 1 (invert inserts)

    loadDocumentContent(view, historyCompartment, 'B');
    const ranUndo = undo(view);

    expect(undoDepth(view.state)).toBe(0);
    expect(ranUndo).toBe(false);
    expect(view.state.doc.toString()).toBe('B');
    view.destroy();
  });

  it('places the cursor at the end of the new content, matching the old replaceContent', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);

    loadDocumentContent(view, historyCompartment, 'hello');

    expect(view.state.selection.main.head).toBe(5);
    view.destroy();
  });

  it('an empty document leaves the selection alone rather than forcing anchor 0', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);

    loadDocumentContent(view, historyCompartment, '');

    expect(view.state.doc.toString()).toBe('');
    view.destroy();
  });
});
