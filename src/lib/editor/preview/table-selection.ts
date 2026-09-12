import { EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Line } from '@codemirror/state';

function findContainingTable(
  state: EditorState,
  line: Line
): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (
        node.name === 'Table' &&
        node.from <= line.from &&
        node.to >= line.to
      ) {
        result = { from: node.from, to: node.to };
        return false;
      }
      return undefined;
    },
  });
  return result;
}

/**
 * If the main selection lands inside a non-header table line (delimiter or
 * data row), snap it to either the header (moving up) or the line after the
 * table (moving down). Hidden lines are visually zero-height and would lose
 * the caret without this redirect.
 */
/**
 * The other end of the `select.cell` exemption.
 *
 * A caret parked in a body cell sits on that row's hidden line on purpose, and
 * that is only honest while the caret the user sees is the DOM one inside the
 * cell. The moment CM6 takes focus back, the same position is an invisible
 * caret on a zero-height line — so repeat it as an ordinary, untagged selection
 * and let the snap-out put it somewhere visible.
 *
 * It rides `focusChanged` on the same update listener rather than a `focus` DOM
 * handler: measured in a browser, a `focus` handler registered through
 * `EditorView.domEventHandlers` did not run for a programmatic `view.focus()`,
 * which is exactly the case this has to cover — the cell edit overlay calls it
 * from its own `destroy()`.
 *
 * Nothing happens for a selection outside a table, which is every other time
 * the editor is focused.
 */
function refocusRedirect(update: ViewUpdate): number | null {
  if (!update.focusChanged || !update.view.hasFocus) return null;
  const state = update.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const table = findContainingTable(state, line);
  if (!table) return null;
  if (line.from === state.doc.lineAt(table.from).from) return null;
  return head;
}

export const tableSelectionSnapOut = EditorView.updateListener.of(
  (update: ViewUpdate) => {
    const refocus = refocusRedirect(update);
    if (refocus !== null) {
      queueMicrotask(() => update.view.dispatch({ selection: { anchor: refocus } }));
      return;
    }
    if (!update.selectionSet) return;
    // Guard against re-entry: our own dispatch carries this userEvent tag.
    // `select.cell` is the other exemption — a click in a body cell parks the
    // caret on that row's hidden line on purpose (#53), and snapping it to the
    // header line would put it back at the table's first character, which is
    // the bug being fixed. The DOM caret the user sees is in the cell either
    // way; this is only the document half of it.
    if (
      update.transactions.some(
        (tr) => tr.isUserEvent('select.snapout') || tr.isUserEvent('select.cell')
      )
    ) {
      return;
    }

    const state = update.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);

    const tableNode = findContainingTable(state, line);
    if (!tableNode) return;

    const headerLine = state.doc.lineAt(tableNode.from);
    if (line.from === headerLine.from) return;

    const prevHead = update.startState.selection.main.head;
    const movedDown = head > prevHead;

    let targetPos: number;
    if (movedDown) {
      const lastLineNo = state.doc.lineAt(tableNode.to).number;
      if (lastLineNo < state.doc.lines) {
        targetPos = state.doc.line(lastLineNo + 1).from;
      } else {
        // End of document — nowhere to go past the table; stay put rather
        // than bounce back to the header
        return;
      }
    } else {
      targetPos = headerLine.from;
    }

    if (targetPos === head) return;

    queueMicrotask(() => {
      update.view.dispatch({
        selection: { anchor: targetPos },
        userEvent: 'select.snapout',
      });
    });
  }
);
