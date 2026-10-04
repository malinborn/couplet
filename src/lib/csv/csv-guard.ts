import { EditorState, Transaction } from '@codemirror/state';
import { tableToRows } from './csv-table';

/**
 * A CSV document's buffer is exactly one GFM table, because that is all a CSV
 * file can hold. Any edit that would leave something else — text above or
 * below, a second table, a pasted paragraph — is dropped.
 *
 * Undo/redo pass untouched: they replay states this filter already accepted.
 * So does a buffer replaced from disk (`addToHistory: false`, the mark
 * `human-edit.ts` uses for a reload): the file is the truth, and when it no
 * longer holds a table the document kind becomes 'code' (spec §4).
 *
 * A tab swap installs a whole new state with `view.setState`, which runs no
 * transaction and so never reaches this filter — as intended.
 */
export const csvEditGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
  if (tr.annotation(Transaction.addToHistory) === false) return tr;
  return tableToRows(tr.newDoc.toString()).ok ? tr : [];
});
