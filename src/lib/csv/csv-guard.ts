import {
  EditorState,
  Prec,
  Transaction,
  type ChangeDesc,
  type Extension,
  type StateCommand,
  type Text,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { redo, redoSelection, undo, undoSelection } from '@codemirror/commands';
import { parseCellsWithPositions } from '../editor/preview/tables';
import { isBlankLine, isTableBodyLine, tableToRows } from './csv-table';

/**
 * Verdicts already reached, per document. A `Text` is immutable, so a verdict
 * never goes stale, and the map is weak, so dropped documents take theirs
 * with them. Every checked edit records its new document here, which is what
 * lets the next edit start from a known table and look only at what it
 * touched.
 */
const verdicts = new WeakMap<Text, boolean>();

function lastNonBlankLine(doc: Text): number {
  let n = doc.lines;
  while (n > 0 && isBlankLine(doc.line(n).text)) n--;
  return n;
}

/**
 * Whether `doc` — `start` with `changes` applied — is still exactly one
 * table, given that `start` is one (`tableToRows(start).ok`). The same verdict
 * as `tableToRows(doc)`, for the cost of the lines the edit touched; `null`
 * when the edit is one this shortcut does not cover and the caller must run
 * the full check.
 *
 * Why it is exact. `tableToRows` accepts iff, once trailing blank lines are
 * dropped (`last` is the last line kept), there are ≥ 2 lines, lines 1–2 form
 * a head of some width, and every line 3..last passes `isTableBodyLine` at
 * that width. If no change touches lines 1–2, they are byte-identical to
 * `start`'s, so the head and its width still hold. An untouched line is a
 * copy of a line of `start`; one copied from before `start`'s trailing blank
 * run passed the same rule at the same width there and passes again. So only
 * two kinds of line can fail: touched lines, and untouched copies of
 * `start`'s trailing blanks that now sit above a non-blank line. The latter
 * all lie at or after `tail`, the image of the end of `start`'s last non-blank
 * line. Checking every touched line up to `last`, plus every line from `tail`
 * to `last` (only touched lines and those old blanks live there, so this stays
 * small), checks every line that can fail.
 */
export function stillOneTable(start: Text, changes: ChangeDesc, doc: Text): boolean | null {
  const touched: [number, number][] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    // A change that ends exactly at a line start counts that line as touched
    // too — conservative, and it keeps "untouched" meaning "copied whole".
    touched.push([doc.lineAt(fromB).number, doc.lineAt(toB).number]);
  });
  if (touched.length === 0) return null;
  // The header or the delimiter row touched: the width may have changed, and
  // with it the verdict for every row. Ranges come in document order.
  if (touched[0][0] <= 2) return null;

  const width = parseCellsWithPositions(doc.line(1).text, 0).length;
  const last = lastNonBlankLine(doc);
  for (const [from, to] of touched) {
    for (let n = from; n <= Math.min(to, last); n++) {
      if (!isTableBodyLine(doc.line(n).text, width)) return false;
    }
  }
  const startLast = lastNonBlankLine(start);
  if (startLast < 2) return null; // not a table after all: the precondition is broken
  const tail = doc.lineAt(changes.mapPos(start.line(startLast).to, -1)).number;
  for (let n = Math.max(3, tail); n <= last; n++) {
    if (!isTableBodyLine(doc.line(n).text, width)) return false;
  }
  return true;
}

/**
 * The guard's verdict for one transaction — always `tableToRows(tr.newDoc).ok`
 * — computed incrementally when the start document is a known table (every
 * accepted edit leaves one), in full otherwise — the first edit after a load
 * or a reload from disk, an edit that touches the head.
 */
export function oneTableAfter(tr: Transaction): boolean {
  const known = verdicts.get(tr.newDoc);
  if (known !== undefined) return known;
  const fast =
    verdicts.get(tr.startState.doc) === true
      ? stillOneTable(tr.startState.doc, tr.changes, tr.newDoc)
      : null;
  const ok = fast ?? tableToRows(tr.newDoc.toString()).ok;
  verdicts.set(tr.newDoc, ok);
  return ok;
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
 *
 * The verdict is `oneTableAfter`: the lines the edit touched when the start
 * document is a known table, the whole buffer otherwise. Either way it is
 * exactly `tableToRows(newDoc).ok` (`csv-guard-incremental.test.ts`).
 */
const oneTableFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(Transaction.addToHistory) === false) return tr;
  return oneTableAfter(tr) ? tr : [];
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
    if (tr && (!tr.docChanged || oneTableAfter(tr))) dispatch(tr);
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
