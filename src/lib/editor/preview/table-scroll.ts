import { EditorView } from '@codemirror/view';
import type { EditorState, SelectionRange } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { CELL_TEXT_CLASS } from './tables';

/**
 * Scrolling to a position inside a rendered table: to the cell, not the line.
 *
 * A table is one widget on its header line; every other row is a real line
 * drawn at `height: 0` right below the widget. So CM6's default scroll target
 * for a position in a body row — `coordsAt(pos)` — is a zero-height rect at
 * the table's **bottom edge**, whatever the row (measured: a match in row 2 of
 * a 12-row table resolved to y 509 while its cell was at y 171). ⌘G scrolled
 * that edge into view: stepping down left the match near the bottom or below
 * it in a tall table, stepping up (⇧⌘G, `y: nearest` aligns the target's top)
 * put the table's bottom at the top of the window and the cell above it, off
 * screen. Every scroll into a body row had it — Find, an agent's `show`, a
 * caret moved there — the oldest being ⌘F's (`preview/CLAUDE.md`, "Known gap").
 *
 * This handler runs in CM6's measure phase, after the viewport was widened to
 * include the target, so the table's DOM exists; it finds the cell whose
 * source range (`data-source-from`/`-to`, kept current by `updateDOM`) holds
 * the whole target and scrolls the editor's scroller so that cell is on
 * screen, below the table's sticky header. Anything else — a range outside
 * every rendered cell, or spanning two — returns `false` and CM6 scrolls as
 * usual. Never dispatches (a scroll handler must not).
 */

type ScrollStrategy = 'nearest' | 'start' | 'end' | 'center';

/**
 * The `Table` node holding `[from, to]`, from the tree as it is — no parse.
 * Enough: the widget is drawn from that same tree, so a table the tree does
 * not have yet has no widget and no hidden rows, and CM6's own scroll is right.
 */
function tableAt(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.name === 'Table') return node.to >= to ? { from: node.from, to: node.to } : null;
  }
  return null;
}

/**
 * The rendered cell (`.cm-md-table-cell`) whose source range holds `[from, to]`,
 * if any. Called on every scroll into view — every keystroke and arrow — so it
 * leaves at once outside a table, and inside one looks only at that table's
 * widget (on its header line), never at the whole document's cells.
 */
function cellFor(view: EditorView, from: number, to: number): HTMLElement | null {
  const table = tableAt(view.state, from, to);
  if (!table) return null;
  const { node } = view.domAtPos(view.state.doc.lineAt(table.from).from);
  const widget = (node instanceof Element ? node : node.parentElement)
    ?.closest('.cm-line')
    ?.querySelector('.cm-md-table');
  if (!widget) return null;
  for (const el of widget.querySelectorAll<HTMLElement>(
    `.${CELL_TEXT_CLASS}[data-source-from][data-source-to]`
  )) {
    const srcFrom = Number(el.dataset.sourceFrom);
    const srcTo = Number(el.dataset.sourceTo);
    if (from >= srcFrom && to <= srcTo) return el.closest<HTMLElement>('.cm-md-table-cell');
  }
  return null;
}

/**
 * How far to move the scroller (positive = down) to show `[top, bottom]` in
 * `[viewTop, viewBottom]` by `y`. Pure.
 */
export function cellScrollDelta(
  cell: { top: number; bottom: number },
  view: { top: number; bottom: number },
  y: ScrollStrategy
): number {
  switch (y) {
    case 'start':
      return cell.top - view.top;
    case 'end':
      // A cell taller than the room keeps its top in view.
      return Math.min(cell.bottom - view.bottom, cell.top - view.top);
    case 'center':
      return (cell.top + cell.bottom) / 2 - (view.top + view.bottom) / 2;
    case 'nearest':
      if (cell.top < view.top) return cell.top - view.top;
      if (cell.bottom > view.bottom) return Math.min(cell.bottom - view.bottom, cell.top - view.top);
      return 0;
  }
}

/** Scroll `range` into view when it lies in one rendered table cell; `false` otherwise. */
export function scrollTableCellIntoView(
  view: EditorView,
  range: SelectionRange,
  options: { y: ScrollStrategy; yMargin: number }
): boolean {
  const cellEl = cellFor(view, range.from, range.to);
  if (!cellEl) return false;
  const box = view.scrollDOM.getBoundingClientRect();
  const cell = cellEl.getBoundingClientRect();
  // The header row is sticky (editor.css): a body cell must land below it.
  // Its height is room to keep either way — stuck, it covers the top of the
  // window; in place, it sits right above the first body row.
  const header = cellEl.closest('.cm-md-table')?.querySelector('.cm-md-table-row-header');
  const headerHeight =
    header && !header.contains(cellEl) ? header.getBoundingClientRect().height : 0;
  const delta = cellScrollDelta(
    cell,
    { top: box.top + headerHeight + options.yMargin, bottom: box.bottom - options.yMargin },
    options.y
  );
  if (delta !== 0) view.scrollDOM.scrollTop += delta;
  return true;
}

/** `EditorView.scrollHandler` for tables — installed once in `setup.ts`. */
export const tableCellScroll = EditorView.scrollHandler.of(scrollTableCellIntoView);
