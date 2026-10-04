import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { readOnlyCompartment, readOnlyDocument } from './read-only';

const DOC = 'id,note\n1,"two\nlines"\n';

function stateWith(readOnly: boolean): EditorState {
  return EditorState.create({
    doc: DOC,
    extensions: [history(), readOnlyCompartment.of(readOnly ? readOnlyDocument : [])],
  });
}

describe('readOnlyDocument — a too-large CSV tab', () => {
  it('reports readOnly, which CM6 input, paste, drop and history honour', () => {
    expect(stateWith(true).readOnly).toBe(true);
    expect(stateWith(false).readOnly).toBe(false);
  });

  it.each<[string, TransactionSpec]>([
    ['typing', { changes: { from: 0, insert: 'x' }, userEvent: 'input.type' }],
    ['a command that ignores readOnly (⌘B and friends)', { changes: { from: 0, to: 2, insert: '**id**' } }],
    ['a delete', { changes: { from: 0, to: 3 }, userEvent: 'delete.backward' }],
  ])('drops %s', (_name, spec) => {
    const state = stateWith(true);
    expect(state.update(spec).state.doc.toString()).toBe(DOC);
  });

  it('lets a buffer replaced from disk through (addToHistory: false, like updateContent)', () => {
    const state = stateWith(true);
    const next = state.update({
      changes: { from: 0, to: state.doc.length, insert: 'a,b\n' },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    expect(next.doc.toString()).toBe('a,b\n');
  });

  it('lets the caret and selection move, so the text can be read and copied', () => {
    const next = stateWith(true).update({ selection: EditorSelection.range(0, 5) }).state;
    expect(next.selection.main.to).toBe(5);
  });

  it('undo does nothing, even with history to undo', () => {
    // An edit made while editable, then the tab turns read-only.
    let state = stateWith(false).update({ changes: { from: 0, insert: 'x' } }).state;
    state = state.update({ effects: readOnlyCompartment.reconfigure(readOnlyDocument) }).state;
    const dispatch = (tr: Transaction) => {
      state = tr.state;
    };
    expect(undo({ state, dispatch })).toBe(false);
    expect(state.doc.toString()).toBe('x' + DOC);
  });

  it('is per state: reconfiguring the compartment back to [] makes the tab editable again', () => {
    const editable = stateWith(true).update({ effects: readOnlyCompartment.reconfigure([]) }).state;
    expect(editable.readOnly).toBe(false);
    expect(editable.update({ changes: { from: 0, insert: 'x' } }).state.doc.toString()).toBe('x' + DOC);
    // Another tab's state is untouched by this one's compartment.
    expect(stateWith(true).readOnly).toBe(true);
  });
});
