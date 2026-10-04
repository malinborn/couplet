import { EditorState, Prec, Transaction, type Extension, type StateCommand } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { redo, redoSelection, undo, undoSelection } from '@codemirror/commands';
import { tableToRows } from './csv-table';

function isOneTable(tr: Transaction): boolean {
  return tableToRows(tr.newDoc.toString()).ok;
}

/**
 * A CSV document's buffer is exactly one GFM table, because that is all a CSV
 * file can hold. Any edit that would leave something else — text above or
 * below, a second table, a pasted paragraph — is dropped.
 *
 * A buffer replaced from disk (`addToHistory: false`, the mark
 * `human-edit.ts` uses for a reload) passes untouched: the file is the truth,
 * and when it no longer holds a table the document kind becomes 'code'
 * (spec §4).
 *
 * Undo and redo are checked like any other edit — but not here: CM6's history
 * dispatches them with `filter: false`, so no transaction filter ever sees
 * them. `csvHistoryGuard` below checks them at the command instead.
 *
 * A tab swap installs a whole new state with `view.setState`, which runs no
 * transaction and so never reaches this filter — as intended.
 */
const oneTableFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(Transaction.addToHistory) === false) return tr;
  return isOneTable(tr) ? tr : [];
});

/**
 * `command` (an undo/redo), dispatched only when what it produces is still one
 * table. It is not a replay of a state the filter already accepted: CM6 maps
 * stored history through an `addToHistory: false` reload, so the inverse of an
 * edit made before it can land at the edge of the replaced span, glued onto
 * the new table — and autosave would write that markdown into the .csv.
 *
 * An undo of an accepted edit with no reload in between is a table and
 * passes. One that crosses a disk reload and would not leave a table is
 * dropped, and the key is still consumed so the plain history command behind
 * it cannot run: Cmd+Z then does nothing there. That is the accepted cost;
 * history is not reset.
 */
function guarded(command: StateCommand): StateCommand {
  return ({ state, dispatch }) => {
    const produced: Transaction[] = [];
    if (!command({ state, dispatch: (tr) => produced.push(tr) })) return false;
    const tr = produced[0];
    if (tr && (!tr.docChanged || isOneTable(tr))) dispatch(tr);
    return true;
  };
}

export const csvUndo = guarded(undo);
export const csvRedo = guarded(redo);

/**
 * Every way into the history, ahead of `historyKeymap` and `history()`'s own
 * `beforeinput` handler: the keys, and `historyUndo` / `historyRedo` input
 * events — what the native Edit menu's Undo/Redo arrive as. The selection
 * variants are included because they pop document changes too when the top
 * history event has no selection-only steps.
 */
const csvHistoryGuard: Extension = [
  Prec.highest(
    keymap.of([
      { key: 'Mod-z', run: csvUndo, preventDefault: true },
      { key: 'Mod-y', mac: 'Mod-Shift-z', run: csvRedo, preventDefault: true },
      { linux: 'Ctrl-Shift-z', run: csvRedo, preventDefault: true },
      { key: 'Mod-u', run: guarded(undoSelection), preventDefault: true },
      { key: 'Alt-u', mac: 'Mod-Shift-u', run: guarded(redoSelection), preventDefault: true },
    ])
  ),
  Prec.highest(
    EditorView.domEventHandlers({
      beforeinput(e, view) {
        const command = e.inputType === 'historyUndo' ? csvUndo
          : e.inputType === 'historyRedo' ? csvRedo
          : null;
        if (!command) return false;
        e.preventDefault();
        command(view);
        return true;
      },
    })
  ),
];

/** The one-table guard a CSV tab installs: the edit filter plus the history guard. */
export const csvEditGuard: Extension = [oneTableFilter, csvHistoryGuard];
