import { describe, expect, it } from 'vitest';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { isHumanEdit } from './human-edit';
import { aiEditTransaction, buildAiEdit } from '../ai-commands';
import { setAiHighlights } from './ai-highlight';

function base(doc = 'hello world'): EditorState {
  return EditorState.create({ doc, extensions: [history()] });
}

/** The shape of a ViewUpdate that the predicate reads. */
function updateOf(...trs: Transaction[]) {
  return { docChanged: trs.some((tr) => tr.docChanged), transactions: trs };
}

function tx(state: EditorState, spec: TransactionSpec): Transaction {
  return state.update(spec);
}

/** Runs a history command and returns the transaction it dispatched. */
function run(state: EditorState, command: typeof undo): Transaction {
  let out: Transaction | null = null;
  command({ state, dispatch: (tr) => (out = tr) });
  if (out === null) throw new Error('command did nothing');
  return out;
}

describe('isHumanEdit', () => {
  it('PlainTyping_IsHuman', () => {
    const s = base();
    expect(isHumanEdit(updateOf(tx(s, { changes: { from: 5, insert: '!' }, userEvent: 'input.type' })))).toBe(true);
  });

  it('Paste_IsHuman', () => {
    const s = base();
    expect(isHumanEdit(updateOf(tx(s, { changes: { from: 0, insert: 'pasted ' }, userEvent: 'input.paste' })))).toBe(true);
  });

  it('UndoAndRedo_AreHuman', () => {
    let s = base();
    s = tx(s, { changes: { from: 5, insert: '!' }, userEvent: 'input.type' }).state;
    const undone = run(s, undo);
    expect(isHumanEdit(updateOf(undone))).toBe(true);
    expect(isHumanEdit(updateOf(run(undone.state, redo)))).toBe(true);
  });

  it('UndoOfAnAgentEdit_IsHuman', () => {
    let s = base();
    const edit = buildAiEdit(s, 'hello there');
    if (edit === null) throw new Error('edit did not build');
    s = tx(s, aiEditTransaction(edit, false)).state;
    expect(isHumanEdit(updateOf(run(s, undo)))).toBe(true);
  });

  it('AnAgentEdit_IsNot', () => {
    const s = base();
    const edit = buildAiEdit(s, 'hello there');
    if (edit === null) throw new Error('edit did not build');
    expect(isHumanEdit(updateOf(tx(s, aiEditTransaction(edit, true))))).toBe(false);
  });

  it('ACommentAnswerInsert_IsNot', () => {
    const s = base();
    expect(
      isHumanEdit(
        updateOf(tx(s, { changes: { from: 11, insert: '\nanswer\n' }, effects: setAiHighlights.of([{ from: 12, to: 18 }]) }))
      )
    ).toBe(false);
  });

  it('AWatcherReload_IsNot', () => {
    const s = base();
    expect(
      isHumanEdit(updateOf(tx(s, { changes: { from: 0, to: 5, insert: 'bye' }, annotations: Transaction.addToHistory.of(false) })))
    ).toBe(false);
  });

  it('NoDocumentChange_IsNot', () => {
    const s = base();
    expect(isHumanEdit(updateOf(tx(s, { selection: { anchor: 3 } })))).toBe(false);
  });

  it('AHumanEditBatchedWithAnAgentOne_IsNot', () => {
    const s = base();
    const typed = tx(s, { changes: { from: 0, insert: 'a' }, userEvent: 'input.type' });
    const agent = tx(typed.state, { changes: { from: 1, insert: 'b' }, effects: setAiHighlights.of([{ from: 1, to: 2 }]) });
    expect(isHumanEdit(updateOf(typed, agent))).toBe(false);
  });
});
