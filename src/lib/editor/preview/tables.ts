import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { DecoSink } from './utils';
import { markdownTable } from 'markdown-table';
import {
  stepColumn,
  nextNavigableRow,
  clampColumn,
  planTableExit,
  newRowMarkdown,
  rowInsertAfter,
  type NavRow,
} from './table-navigation';
import { matchCellBinding } from './table-keys';
import { createHotkeySheetButton, clearHotkeySheets } from './table-hotkey-sheet';
import { toggleTableMode, getTableMode } from './table-state';
import {
  encodeForCommit,
  decodeForEdit,
  encodedOffset,
  decodedOffset,
} from './table-encoding';
import { docPosForCaretIn, placeCaretFromPoint, visibleOffsetIn } from './cell-caret';
import {
  applyTextareaEdit,
  endCellEditSession,
  setCellEditSession,
} from '../cell-edit-session';
import { isAnchor, navigateToHeading } from '../heading-slugs';
import { makeWidgetTextSelectable } from '../widget-text-selection';
import { parseInlineMarkdown } from './inline-tokens';
import { visibleRangeForSource, sourceRangeForVisible } from '../live-render/cell-anchor';
import {
  commentAnchorsIn,
  COMMENT_ANCHOR_ATTR,
  COMMENT_ANCHOR_CLASS,
  type CommentAnchorSpan,
} from '../ai-comment';
import { t } from '../../i18n';

/** Class of the per-cell nested editing host that carries the cell's text. */
export const CELL_TEXT_CLASS = 'cm-md-table-celltext';

export interface CellInfo {
  text: string;
  from: number;
  to: number;
}

export interface RowData {
  from: number;
  to: number;
  text: string;
  cells: CellInfo[];
  isDelimiter: boolean;
  isHeader: boolean;
  rowIndex: number;
}

export interface TableContext {
  rows: RowData[];
  colWidths: number[];
  colCount: number;
  /** Absolute position of the entire table node in the document. */
  nodeFrom: number;
  nodeTo: number;
}

export function parseCellsWithPositions(text: string, lineFrom: number): CellInfo[] {
  const cells: CellInfo[] = [];
  let i = 0;
  while (i < text.length && text[i] !== '|') i++;
  if (i < text.length) i++;
  let cellStart = i;
  while (i < text.length) {
    if (text[i] === '|' && (i === 0 || text[i - 1] !== '\\')) {
      const raw = text.slice(cellStart, i);
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const leadSpaces = raw.length - raw.trimStart().length;
        const from = lineFrom + cellStart + leadSpaces;
        const to = from + trimmed.length;
        cells.push({ text: trimmed, from, to });
      } else {
        // Empty cell — point to the space between pipes for insertion
        const midpoint = lineFrom + cellStart + Math.floor(raw.length / 2);
        cells.push({ text: '', from: midpoint, to: midpoint });
      }
      cellStart = i + 1;
    }
    i++;
  }
  return cells;
}

/** Convert table context to a 2D string array (header + data rows, no delimiter). */
export function tableToGrid(ctx: TableContext): string[][] {
  return ctx.rows
    .filter(r => !r.isDelimiter)
    .map(r => r.cells.map(c => c.text));
}

/** Replace the entire table node with a new markdown table from a 2D grid. */
function replaceTable(view: EditorView, ctx: TableContext, grid: string[][]): void {
  const newMd = markdownTable(grid, { align: null, padding: true });
  view.dispatch({
    changes: { from: ctx.nodeFrom, to: ctx.nodeTo, insert: newMd },
  });
}

function addRow(view: EditorView, ctx: TableContext): void {
  // Insert directly after the last row — use visible placeholders so Lezer
  // includes the row in the Table node (whitespace-only cells get excluded).
  // The row text comes from `table-navigation.ts` because Cmd+Shift+Enter (#68)
  // builds the same thing, and two spellings of "an empty row" would diverge on
  // the first change to the padding.
  const lastRow = ctx.rows[ctx.rows.length - 1];
  view.dispatch({
    changes: {
      from: lastRow.to,
      to: lastRow.to,
      insert: '\n' + newRowMarkdown(ctx.colWidths),
    },
  });
}

function deleteRow(view: EditorView, ctx: TableContext, dataRowIndex: number): void {
  const grid = tableToGrid(ctx);
  // dataRowIndex 0 = header, 1+ = data rows
  if (grid.length <= 2) return; // keep at least header + 1 row
  grid.splice(dataRowIndex + 1, 1); // +1 because grid[0] is header
  replaceTable(view, ctx, grid);
}

function addColumn(view: EditorView, ctx: TableContext): void {
  const grid = tableToGrid(ctx);
  grid[0].push(t('editor.tables.new_column'));
  for (let i = 1; i < grid.length; i++) {
    grid[i].push('-');
  }
  replaceTable(view, ctx, grid);
}

function deleteColumn(view: EditorView, ctx: TableContext, colIndex: number): void {
  if (ctx.colCount <= 1) return;
  const grid = tableToGrid(ctx);
  for (const row of grid) {
    row.splice(colIndex, 1);
  }
  replaceTable(view, ctx, grid);
}

// --- Drag and drop helpers ---

interface DragState {
  active: boolean;
  type: 'row' | 'col';
  sourceIndex: number;
  targetIndex: number;
  indicator: HTMLElement | null;
}

const drag: DragState = {
  active: false,
  type: 'row',
  sourceIndex: -1,
  targetIndex: -1,
  indicator: null,
};

function createDropIndicator(vertical: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cm-md-table-drop-indicator';
  if (vertical) el.classList.add('cm-md-table-drop-indicator-col');
  document.body.appendChild(el);
  return el;
}

function removeDropIndicator(): void {
  drag.indicator?.remove();
  drag.indicator = null;
}

function getRowWraps(tableEl: HTMLElement | null): HTMLElement[] {
  if (!tableEl) return [];
  const table = tableEl.closest('.cm-md-table') as HTMLElement | null;
  if (!table) return [];
  return Array.from(
    table.querySelectorAll('.cm-md-table-row-data')
  ) as HTMLElement[];
}

function getHeaderCells(anyTableEl: HTMLElement | null): HTMLElement[] {
  if (!anyTableEl) return [];
  const table = anyTableEl.closest('.cm-md-table') as HTMLElement | null;
  if (!table) return [];
  const header = table.querySelector('.cm-md-table-row-header');
  if (!header) return [];
  // Skip the leading ctrl-cell (first child)
  return Array.from(
    header.querySelectorAll('.cm-md-table-cell:not(.cm-md-table-row-ctrl)')
  ) as HTMLElement[];
}

function startRowDrag(
  e: MouseEvent,
  view: EditorView,
  ctx: TableContext,
  dataRowIndex: number,
  wrapEl: HTMLElement
): void {
  e.preventDefault();
  e.stopPropagation();

  drag.active = true;
  drag.type = 'row';
  drag.sourceIndex = dataRowIndex;
  drag.targetIndex = dataRowIndex;

  wrapEl.classList.add('cm-md-table-dragging');

  const onMove = (ev: MouseEvent): void => {
    if (!drag.active) return;

    const wraps = getRowWraps(wrapEl);
    if (wraps.length === 0) return;

    let insertBefore = wraps.length; // default: after last
    let bestY = Infinity;

    for (let i = 0; i < wraps.length; i++) {
      const rect = wraps[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const distToTop = Math.abs(ev.clientY - rect.top);
      if (ev.clientY < midY && distToTop < bestY) {
        insertBefore = i;
        bestY = distToTop;
      }
    }

    // targetIndex is the data row index we want to insert before
    drag.targetIndex = insertBefore;

    // Position indicator
    if (!drag.indicator) {
      drag.indicator = createDropIndicator(false);
    }

    const containerRect = wraps[0].closest('.cm-content')?.getBoundingClientRect();
    if (containerRect) {
      if (insertBefore < wraps.length) {
        const targetRect = wraps[insertBefore].getBoundingClientRect();
        drag.indicator.style.top = `${targetRect.top}px`;
        drag.indicator.style.left = `${containerRect.left}px`;
        drag.indicator.style.width = `${containerRect.width}px`;
      } else {
        const lastRect = wraps[wraps.length - 1].getBoundingClientRect();
        drag.indicator.style.top = `${lastRect.bottom}px`;
        drag.indicator.style.left = `${containerRect.left}px`;
        drag.indicator.style.width = `${containerRect.width}px`;
      }
    }
  };

  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onEscape);

    wrapEl.classList.remove('cm-md-table-dragging');
    removeDropIndicator();

    if (!drag.active) return;
    drag.active = false;

    const src = drag.sourceIndex; // 0-based data row index
    const tgt = drag.targetIndex; // insert-before index among data rows

    // No-op if same position or adjacent (moving to its own slot)
    if (tgt === src || tgt === src + 1) return;

    const grid = tableToGrid(ctx);
    // grid[0] = header, grid[1..] = data rows
    const dataRows = grid.slice(1);
    if (src < 0 || src >= dataRows.length) return;

    const [moved] = dataRows.splice(src, 1);
    const insertAt = tgt > src ? tgt - 1 : tgt;
    dataRows.splice(insertAt, 0, moved);

    replaceTable(view, ctx, [grid[0], ...dataRows]);
  };

  const onEscape = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      drag.active = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onEscape);
      wrapEl.classList.remove('cm-md-table-dragging');
      removeDropIndicator();
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('keydown', onEscape);
}

function startColDrag(
  e: MouseEvent,
  view: EditorView,
  ctx: TableContext,
  colIndex: number,
  headerCellEl: HTMLElement
): void {
  e.preventDefault();
  e.stopPropagation();

  drag.active = true;
  drag.type = 'col';
  drag.sourceIndex = colIndex;
  drag.targetIndex = colIndex;

  headerCellEl.classList.add('cm-md-table-dragging');

  const onMove = (ev: MouseEvent): void => {
    if (!drag.active) return;

    const cells = getHeaderCells(headerCellEl.closest('.cm-md-table') as HTMLElement | null);
    if (cells.length === 0) return;

    let insertBefore = cells.length;
    let bestX = Infinity;

    for (let i = 0; i < cells.length; i++) {
      const rect = cells[i].getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const distToLeft = Math.abs(ev.clientX - rect.left);
      if (ev.clientX < midX && distToLeft < bestX) {
        insertBefore = i;
        bestX = distToLeft;
      }
    }

    drag.targetIndex = insertBefore;

    if (!drag.indicator) {
      drag.indicator = createDropIndicator(true);
    }

    // Header row contains both the leading ctrl-cell and data cells in the same
    // table-row element, so closest('.cm-md-table-row-header') from any data cell
    // resolves to the full row's bounding rect (correct height for col indicator).
    if (insertBefore < cells.length) {
      const targetRect = cells[insertBefore].getBoundingClientRect();
      const headerRect = cells[0].closest('.cm-md-table-row-header')?.getBoundingClientRect();
      drag.indicator.style.left = `${targetRect.left}px`;
      drag.indicator.style.top = headerRect ? `${headerRect.top}px` : `${targetRect.top}px`;
      drag.indicator.style.height = headerRect ? `${headerRect.height}px` : `${targetRect.height}px`;
    } else {
      const lastRect = cells[cells.length - 1].getBoundingClientRect();
      const headerRect = cells[0].closest('.cm-md-table-row-header')?.getBoundingClientRect();
      drag.indicator.style.left = `${lastRect.right}px`;
      drag.indicator.style.top = headerRect ? `${headerRect.top}px` : `${lastRect.top}px`;
      drag.indicator.style.height = headerRect ? `${headerRect.height}px` : `${lastRect.height}px`;
    }
  };

  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onEscape);

    headerCellEl.classList.remove('cm-md-table-dragging');
    removeDropIndicator();

    if (!drag.active) return;
    drag.active = false;

    const src = drag.sourceIndex;
    const tgt = drag.targetIndex;

    if (tgt === src || tgt === src + 1) return;

    const grid = tableToGrid(ctx);
    const newGrid = grid.map(row => {
      const cols = [...row];
      const [moved] = cols.splice(src, 1);
      const insertAt = tgt > src ? tgt - 1 : tgt;
      cols.splice(insertAt, 0, moved);
      return cols;
    });

    replaceTable(view, ctx, newGrid);
  };

  const onEscape = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      drag.active = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onEscape);
      headerCellEl.classList.remove('cm-md-table-dragging');
      removeDropIndicator();
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('keydown', onEscape);
}

// --- Widgets ---

class TableWidget extends WidgetType {
  constructor(
    private ctx: TableContext,
    private mode: 'wrap' | 'full',
    /**
     * Commented fragments inside this table, in document coordinates. Part of
     * the widget's identity (see `eq`): a comment appearing or going away
     * changes what the cells draw, and nothing else in the context moves (#62).
     */
    private anchors: CommentAnchorSpan[] = []
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-table-wrap';
    wrap.setAttribute('data-mode', this.mode);

    const table = document.createElement('span');
    table.className = 'cm-md-table';

    const colCtrl = createColCtrl(view, this.ctx, wrap);

    const headerRow = this.ctx.rows.find((r) => r.isHeader);
    if (headerRow) {
      table.appendChild(buildHeaderRow(headerRow, this.ctx, view, colCtrl, this.anchors));
    }

    const dataRows = this.ctx.rows.filter((r) => !r.isDelimiter && !r.isHeader);
    const dataCount = dataRows.length;
    dataRows.forEach((row, i) => {
      table.appendChild(buildDataRow(row, i, this.ctx, view, dataCount, this.anchors));
    });

    wrap.appendChild(table);
    // Снаружи `.cm-md-table` — её `overflow: hidden` срезал бы верхнюю часть
    // панели, которая выезжает над строкой заголовка.
    wrap.appendChild(colCtrl.el);

    // "+ add column" — absolutely positioned at right of the header row
    const addCol = mkBtn('+', 'cm-md-table-btn-add cm-md-table-btn-add-col', () =>
      addColumn(view, this.ctx)
    );
    wrap.appendChild(addCol);

    // "+ add row" — inline button at end of last data row plus floating "+" below
    const addRowInline = mkBtn('+', 'cm-md-table-btn-add cm-md-table-btn-add-row', () =>
      addRow(view, this.ctx)
    );
    wrap.appendChild(addRowInline);

    const bottomContainer = document.createElement('span');
    bottomContainer.className = 'cm-md-table-add-row-bottom';
    const addRowBottom = mkBtn('+', 'cm-md-table-btn-add', () => addRow(view, this.ctx));
    bottomContainer.appendChild(addRowBottom);
    wrap.appendChild(bottomContainer);

    return wrap;
  }

  eq(other: TableWidget): boolean {
    if (this.mode !== other.mode) return false;
    // Anchors are structural context here in exactly the sense the root
    // CLAUDE.md means: they decide what the DOM contains. Left out, CM6 would
    // keep the widget it already had and a comment made on cell text would
    // leave no mark until something else happened to rebuild the table.
    if (this.anchors.length !== other.anchors.length) return false;
    if (
      !this.anchors.every((a, i) => {
        const o = other.anchors[i];
        return a.id === o.id && a.from === o.from && a.to === o.to;
      })
    ) {
      return false;
    }
    if (this.ctx.nodeFrom !== other.ctx.nodeFrom) return false;
    if (this.ctx.nodeTo !== other.ctx.nodeTo) return false;
    if (this.ctx.rows.length !== other.ctx.rows.length) return false;
    if (this.ctx.colCount !== other.ctx.colCount) return false;
    if (!this.ctx.colWidths.every((w, i) => w === other.ctx.colWidths[i])) return false;
    return this.ctx.rows.every((r, i) => {
      const o = other.ctx.rows[i];
      return (
        r.cells.length === o.cells.length &&
        r.cells.every(
          (c, j) => c.text === o.cells[j].text && c.from === o.cells[j].from
        )
      );
    });
  }

  /**
   * The hotkey cheatsheet lives in `document.body`, so it does not go away with
   * the widget's own DOM. A structural edit rebuilds the table on every
   * keystroke's worth of change, and a panel left behind would hover over a
   * button that no longer exists.
   */
  destroy(): void {
    clearHotkeySheets();
  }

  /**
   * `true` — CM6 keeps its hands off everything inside a table.
   *
   * The sense of this method is the opposite of what the name suggests:
   * `eventBelongsToEditor` in `@codemirror/view` bails out of CM6's own
   * handling when `ignoreEvent` returns `true`.
   *
   * It used to return `true` only inside a cell's text, which is a nested
   * editing host (`makeWidgetTextSelectable`): without the exemption CM6's
   * `MouseSelection` snapped a drag started there out to the whole table range
   * and the browser was left with an empty selection (#31). Everywhere else the
   * answer was `false`, described as "how a click on a table still moves the
   * document selection" — and that turned out to be the whole of #53.
   *
   * A table has no document position under most of its pixels. The widget
   * covers the header line and every other row is a real line hidden at
   * `height: 0`, so `posAtCoords` inside the widget answers with the replaced
   * range's `from` or its `to` — the table's first character, or the end of the
   * header row, whichever half was clicked. Measured on `main`: a click on a
   * cell's padding put the caret at one of those two places and the next
   * keystroke wrote there, wrecking the row. There is no click on a table for
   * which that answer is the right one, so nothing here wants CM6's handling.
   *
   * What replaces it is {@link parkCaretOnMouseDown}, which puts the caret in
   * the cell that was clicked — see `cell-caret.ts`.
   */
  ignoreEvent(): boolean {
    return true;
  }
}

// Re-exported so `./tables` stays the import path callers already use; the
// implementation moved to `inline-tokens.ts` to break the cycle with
// `live-render/cell-anchor.ts`, which this file now imports in turn (#62).
export { parseInlineMarkdown, type InlineToken } from './inline-tokens';

/** Open a URL via the Tauri shell, falling back to `window.open` in non-Tauri builds. */
function openUrl(url: string): void {
  import('@tauri-apps/plugin-shell')
    .then(({ open }) => open(url))
    .catch(() => {
      window.open(url, '_blank');
    });
}

/**
 * Route a link click from inside a table cell.
 *
 * Anchor URLs (`#heading-slug`) jump within the document via `navigateToHeading`;
 * everything else is opened externally through the supplied `openExternal` callback
 * (Tauri shell in the live editor, injectable in tests).
 *
 * Pure — does not touch the click event itself. The DOM wiring layer is responsible
 * for `preventDefault` / `stopPropagation` so the native `<a>` activation doesn't
 * also fire. Without that, a re-click of the same anchor lets the browser's hash
 * navigation kick in, which Tauri can then open in the system browser instead of
 * scrolling the editor.
 */
export function routeLinkClick(
  url: string,
  view: EditorView,
  openExternal: (url: string) => void
): void {
  if (isAnchor(url)) {
    navigateToHeading(view, url.slice(1));
  } else {
    openExternal(url);
  }
}

/**
 * A commented fragment of one cell, in *rendered* characters.
 *
 * The document-level highlight (`ai-comment.ts`) cannot serve a table: the
 * source lines of every row but the header are drawn at zero height, so the
 * mark is painted onto nothing and the reader sees no sign that a comment is
 * attached to anything (#62). The widget repeats it on the visible text, which
 * means translating the thread's source offsets through the same token split
 * that produced the DOM.
 */
export interface CellHighlight {
  id: string;
  visFrom: number;
  visTo: number;
}

/**
 * Which parts of a cell's rendered text carry a comment highlight.
 *
 * Anchors are clipped to the cell first — a quote found by search can run past
 * a `|` — and then mapped from source to visible offsets. A cell whose text
 * does not reconstruct yields nothing rather than a highlight a few characters
 * off: a mark on the wrong word is worse than the card's quote alone.
 */
export function cellHighlights(
  cell: CellInfo,
  anchors: CommentAnchorSpan[]
): CellHighlight[] {
  if (!cell.text) return [];
  const out: CellHighlight[] = [];
  for (const anchor of anchors) {
    const srcFrom = Math.max(0, anchor.from - cell.from);
    const srcTo = Math.min(cell.text.length, anchor.to - cell.from);
    if (srcTo <= srcFrom) continue;
    const visible = visibleRangeForSource(cell.text, srcFrom, srcTo);
    if (!visible) continue;
    out.push({ id: anchor.id, visFrom: visible.from, visTo: visible.to });
  }
  return out.sort((a, b) => a.visFrom - b.visFrom);
}

/**
 * Append `value` to `parent`, wrapping the highlighted parts of it.
 *
 * `visStart` is where this run of text begins in the cell's rendered text, so
 * one counter walks the whole cell across `<strong>`, `<code>` and `<a>`
 * boundaries. Where two threads overlap the earlier one keeps the shared
 * characters — nesting two marks would double the wash and say nothing extra.
 */
function appendCellText(
  parent: HTMLElement,
  value: string,
  visStart: number,
  highlights: CellHighlight[]
): void {
  if (!value) return;
  const hits = highlights.filter(
    (h) => h.visFrom < visStart + value.length && h.visTo > visStart
  );
  if (hits.length === 0) {
    parent.appendChild(document.createTextNode(value));
    return;
  }

  let cursor = 0;
  for (const hit of hits) {
    const start = Math.max(hit.visFrom - visStart, cursor);
    const end = Math.min(hit.visTo - visStart, value.length);
    if (end <= start) continue;
    if (start > cursor) {
      parent.appendChild(document.createTextNode(value.slice(cursor, start)));
    }
    const span = document.createElement('span');
    // The same class the document decoration uses, so a comment on cell text
    // looks exactly like a comment on a paragraph — and the attention shimmer,
    // which finds its spans by the attribute, covers this one too.
    span.className = COMMENT_ANCHOR_CLASS;
    span.setAttribute(COMMENT_ANCHOR_ATTR, hit.id);
    span.textContent = value.slice(start, end);
    parent.appendChild(span);
    cursor = end;
  }
  if (cursor < value.length) {
    parent.appendChild(document.createTextNode(value.slice(cursor)));
  }
}

/** Render inline markdown (code, bold, italic, strikethrough, links) into a cell element. */
function renderCellContent(
  cellEl: HTMLElement,
  text: string,
  view: EditorView,
  highlights: CellHighlight[] = []
): void {
  if (!text) return;

  const tokens = parseInlineMarkdown(text);

  if (tokens.length === 0) {
    cellEl.textContent = text;
    return;
  }

  // Where the token being rendered starts in the cell's rendered text — the
  // coordinate `highlights` speaks in.
  let vis = 0;

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        appendCellText(cellEl, token.value, vis, highlights);
        vis += token.value.length;
        break;
      case 'code': {
        const code = document.createElement('code');
        code.className = 'cm-md-table-inline-code';
        appendCellText(code, token.value, vis, highlights);
        vis += token.value.length;
        cellEl.appendChild(code);
        break;
      }
      case 'boldItalic': {
        const strong = document.createElement('strong');
        const em = document.createElement('em');
        appendCellText(em, token.value, vis, highlights);
        vis += token.value.length;
        strong.appendChild(em);
        cellEl.appendChild(strong);
        break;
      }
      case 'bold': {
        const el = document.createElement('strong');
        appendCellText(el, token.value, vis, highlights);
        vis += token.value.length;
        cellEl.appendChild(el);
        break;
      }
      case 'italic': {
        const el = document.createElement('em');
        appendCellText(el, token.value, vis, highlights);
        vis += token.value.length;
        cellEl.appendChild(el);
        break;
      }
      case 'strike': {
        const el = document.createElement('s');
        appendCellText(el, token.value, vis, highlights);
        vis += token.value.length;
        cellEl.appendChild(el);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        a.className = 'cm-md-link';
        a.href = token.url;
        a.rel = 'noopener noreferrer';
        appendCellText(a, token.text, vis, highlights);
        vis += token.text.length;
        // mousedown drives the actual routing — same trigger setup.ts uses for
        // top-level Link nodes. The click handler is a backstop that kills the
        // native `<a>` activation on every code path (keyboard activation,
        // re-clicks after the widget has been re-rendered): without it, the
        // webview honours the `href` and re-opens `#anchor` URLs in the system
        // browser on the second click. No `target="_blank"` — it would route
        // every click through the OS handler too.
        const onMouseDown = (e: MouseEvent): void => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          routeLinkClick(token.url, view, openUrl);
        };
        const onClick = (e: MouseEvent): void => {
          e.preventDefault();
          e.stopPropagation();
        };
        a.addEventListener('mousedown', onMouseDown);
        a.addEventListener('click', onClick);
        cellEl.appendChild(a);
        break;
      }
    }
  }
}

function mkBtn(text: string, className: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.className = `cm-md-table-btn ${className}`;
  btn.textContent = text;
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/**
 * Комфортная ширина поля ввода ячейки (px).
 *
 * В колонке шириной в три символа набирать текст нечитаемо, поэтому на время
 * ввода поле расширяется хотя бы до этого значения — но никогда не сужает
 * ячейку и никогда не вылезает за правый край строки.
 */
const CELL_EDIT_MIN_WIDTH = 280;

/** Совпадает с `--table-side-gutter` в editor.css — полоса справа под кнопки. */
const TABLE_SIDE_GUTTER = 32;

/**
 * Ширина поля ввода ячейки на время редактирования.
 *
 * Правило: не уже самой ячейки, по возможности — не уже `min`, но никогда не
 * шире места, оставшегося до правого края строки. Считается один раз, при
 * открытии поля: если бы она пересчитывалась по ходу набора, получилась бы
 * петля «ширина ячейки → ширина поля → ширина ячейки» — то есть пересчёт
 * геометрии таблицы на каждый символ.
 */
export function cellEditWidth(
  cellWidth: number,
  available: number,
  min = CELL_EDIT_MIN_WIDTH
): number {
  return Math.max(cellWidth, Math.min(min, Math.max(cellWidth, available)));
}

/**
 * Поле правки ячейки — и как над ним работает тулбар форматирования (#60).
 *
 * Сначала тулбара тут не было (#55): в поле лежит исходник, `**жирный**` виден
 * буквально, и смысл «маркеры скрыты» тут не работает. Владелец это отвёл —
 * двойной клик это ещё и универсальный жест «выделить слово», провалиться в
 * правку легко, и человек не обязан знать, в каком он режиме.
 *
 * Два возражения из #55 остались настоящими, и сняты они так:
 *
 * 1. Второй реализации «жирного» нет. Поле не умеет форматировать само: оно
 *    публикует себя через `cell-edit-session.ts`, а тулбар гоняет его текст
 *    через `toggleInlineFormatInText` — тот же `formatSpec` по дереву разбора,
 *    что и для обычного выделения, просто на временном состоянии.
 * 2. 💬 сначала коммитит ячейку и только потом ставит якорь
 *    (`commitAndMap`). Пока поле открыто, текст ячейки в документе устаревший,
 *    и якорь указал бы на то, чего в файле нет; коммит — ровно то же, что
 *    произошло бы при клике мимо поля.
 *
 * Link в поле по-прежнему нет, но по другой причине (#57): инспектор
 * позиционируется по `coordsAtPos`, то есть по строке таблицы, а не по ячейке.
 */
/**
 * Where a cell sits in its table, in coordinates that survive a commit.
 *
 * `row` indexes `TableContext.rows` — including the delimiter, so it is also the
 * cell's line offset from the table's first line, which is what makes it
 * survive: a commit rewrites text inside one line and can move every position
 * after it, but it never adds or removes a line (`encodeForCommit` turns
 * newlines into `<br>`). So the pair (table's first line number, `row`) still
 * names the same row afterwards, and the table can simply be re-read.
 */
interface CellPlace {
  row: number;
  col: number;
}

/** What a navigation key asks for once the cell being left has been committed. */
type CellMove =
  /** Enter — the next row, same column; or out of the table if there is none. */
  | { kind: 'row' }
  /** Tab / Shift+Tab — the next or previous column, wrapping inside the row. */
  | { kind: 'col'; delta: 1 | -1 }
  /** Cmd+Shift+Enter — a fresh row right below this one. */
  | { kind: 'new-row' };

function navRowsOf(ctx: TableContext): NavRow[] {
  return ctx.rows.map((r) => ({
    isDelimiter: r.isDelimiter,
    cellCount: r.cells.length,
  }));
}

/**
 * Re-read the table that starts at `tableLine`, after the document has moved.
 *
 * Navigation is the one caller that needs a `TableContext` without being inside
 * a decoration pass, so it has to find the `Table` node itself. `ensureSyntaxTree`
 * rather than `syntaxTree`: the commit that just landed may not have been
 * reparsed yet, and a stale tree would answer with the pre-commit table — most
 * visibly after Cmd+Shift+Enter, where the row we are navigating into does not
 * exist in it at all.
 */
function tableContextAtLine(view: EditorView, tableLine: number): TableContext | null {
  const doc = view.state.doc;
  if (tableLine < 1 || tableLine > doc.lines) return null;
  const line = doc.line(tableLine);
  const tree =
    ensureSyntaxTree(view.state, Math.min(doc.length, line.to + 1), 200) ??
    syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(Math.min(line.from + 1, line.to), 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (!node) return null;
  return buildTableContext(doc, node.from, node.to);
}

/**
 * Open the edit overlay on one cell of a freshly re-read table.
 *
 * The cell is found by the source range frozen onto its nested editing host by
 * `makeWidgetTextSelectable`, which is exactly the cell's identity and is safe
 * to trust for the reason the attribute exists at all: `TableWidget.eq()`
 * compares every cell `from`, so a widget whose cells moved is rebuilt rather
 * than reused.
 *
 * CM6 writes the DOM synchronously inside `dispatch`, so the element is normally
 * there already; the one retried frame covers a rebuild deferred into a measure
 * phase rather than leaving the user in an editor that did not open.
 */
function openCellEditorAt(
  view: EditorView,
  ctx: TableContext,
  rowIndex: number,
  colIndex: number
): void {
  const cell = ctx.rows[rowIndex]?.cells[colIndex];
  if (!cell) return;

  const open = (): boolean => {
    const textEl = view.dom.querySelector<HTMLElement>(
      `.${CELL_TEXT_CLASS}[data-source-from="${cell.from}"][data-source-to="${cell.to}"]`
    );
    const cellEl = textEl?.closest<HTMLElement>('.cm-md-table-cell') ?? null;
    if (!cellEl) return false;
    showCellEditor(view, cellEl, cell, undefined, { row: rowIndex, col: colIndex });
    return true;
  };

  if (!open()) requestAnimationFrame(() => void open());
}

/**
 * Enter on the last row: out of the table, onto one empty line beneath it.
 *
 * The arithmetic — and in particular the refusal to add a *second* blank line
 * when one is already there — is `planTableExit`, which is unit-tested. This
 * half only turns it into a transaction and gives the editor its focus back;
 * the caret lands below the table, so `table-selection.ts` has nothing to snap
 * out and stays quiet.
 */
function exitTableBelow(view: EditorView, ctx: TableContext): void {
  const doc = view.state.doc;
  const lastRow = ctx.rows[ctx.rows.length - 1];
  if (!lastRow) return;
  const lastLine = doc.lineAt(lastRow.from);
  const next = lastLine.number < doc.lines ? doc.line(lastLine.number + 1) : null;
  const plan = planTableExit(
    lastLine.to,
    next ? { from: next.from, to: next.to, text: next.text } : null
  );
  view.dispatch({
    changes: plan.insert ? { from: plan.at, insert: plan.insert } : undefined,
    selection: { anchor: plan.caret },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Carry out a {@link CellMove}, on a table that has just been committed into.
 *
 * Everything here re-reads the document rather than trusting the context the
 * widget was built from: the commit that preceded this call moved every position
 * after the edited cell, and for `new-row` the table grew a line.
 */
function moveAfterCommit(
  view: EditorView,
  tableLine: number,
  place: CellPlace,
  move: CellMove
): void {
  const ctx = tableContextAtLine(view, tableLine);
  if (!ctx) return;
  const rows = navRowsOf(ctx);

  if (move.kind === 'col') {
    const cellCount = rows[place.row]?.cellCount ?? 0;
    openCellEditorAt(view, ctx, place.row, stepColumn(place.col, cellCount, move.delta));
    return;
  }

  if (move.kind === 'new-row') {
    const after = rowInsertAfter(rows, place.row);
    const anchor = ctx.rows[after];
    if (!anchor) return;
    view.dispatch({
      changes: { from: anchor.to, insert: '\n' + newRowMarkdown(ctx.colWidths) },
    });
    const grown = tableContextAtLine(view, tableLine);
    if (!grown) return;
    const target = after + 1;
    const cellCount = grown.rows[target]?.cells.length ?? 0;
    openCellEditorAt(view, grown, target, clampColumn(place.col, cellCount));
    return;
  }

  const next = nextNavigableRow(rows, place.row);
  if (next === null) {
    exitTableBelow(view, ctx);
    return;
  }
  openCellEditorAt(view, ctx, next, clampColumn(place.col, rows[next].cellCount));
}

function showCellEditor(
  view: EditorView,
  cellEl: HTMLElement,
  cell: CellInfo,
  /**
   * What to select in the field, in the cell's *source* offsets, when the
   * overlay is opened from a caret parked in the cell rather than from a double
   * click (#53). Omitted keeps the old select-everything behaviour.
   */
  selectSrc?: { from: number; to: number },
  /**
   * Where this cell sits in its table (#68). Omitted disables navigation and
   * leaves every key doing what it did before — which is what an overlay opened
   * by something that does not know the table's shape should do.
   */
  place?: CellPlace
): void {
  document.querySelector('.cm-md-table-editor')?.remove();

  const rect = cellEl.getBoundingClientRect();
  const cellStyle = getComputedStyle(cellEl);
  const lineEl = cellEl.closest('.cm-md-table-line');
  const rightLimit = lineEl
    ? lineEl.getBoundingClientRect().right - TABLE_SIDE_GUTTER
    : window.innerWidth - TABLE_SIDE_GUTTER;

  const editWidth = cellEditWidth(rect.width, rightLimit - rect.left);

  cellEl.classList.add('cm-md-table-cell-editing');

  const ta = document.createElement('textarea');
  ta.className = 'cm-md-table-editor';
  ta.value = decodeForEdit(cell.text);
  ta.rows = 1;
  ta.style.position = 'fixed';
  ta.style.left = `${rect.left}px`;
  ta.style.top = `${rect.top}px`;
  ta.style.width = `${editWidth}px`;
  // Метрики берём у ячейки, чтобы символы стояли ровно там же, где стояли до
  // двойного клика: у поля свой контекст (оно висит в `document.body`), и
  // относительные единицы в его CSS считались бы от размера шрифта body.
  ta.style.fontFamily = cellStyle.fontFamily;
  ta.style.fontSize = cellStyle.fontSize;
  ta.style.lineHeight = cellStyle.lineHeight;
  ta.style.padding = cellStyle.padding;
  ta.style.textAlign = cellStyle.textAlign;

  /**
   * Раскрыть ячейку под размер поля ввода.
   *
   * Единственная запись, которую делает ввод, — инлайновые `min-width` /
   * `min-height` на АКТИВНОЙ ячейке. Транзакции CM6 тут нет вовсе, а колонку
   * расширяет и строку растит сам браузер по `table-layout: auto` — ширины
   * соседних строк никто не считает и не выравнивает в JS.
   *
   * Расширение колонки может перевёрстывать соседние колонки и сдвинуть саму
   * ячейку, поэтому позиция поля берётся заново уже после раскладки.
   */
  const reflow = (): void => {
    ta.style.height = '0';
    const height = Math.max(ta.scrollHeight, rect.height);
    ta.style.height = `${height}px`;

    cellEl.style.boxSizing = 'border-box';
    cellEl.style.minWidth = `${editWidth}px`;
    // Именно `height`, а не `min-height`: на `display: table-cell` Chrome
    // min-height игнорирует (в CSS 2.1 его действие на ячейку не определено),
    // зато `height` трактует как минимум — строка от него растёт, но никогда
    // не становится ниже своего содержимого. Измерено: с `min-height` ячейка
    // оставалась 32px при поле в 67px.
    cellEl.style.height = `${height}px`;

    const live = cellEl.getBoundingClientRect();
    ta.style.left = `${live.left}px`;
    ta.style.top = `${live.top}px`;
  };
  ta.addEventListener('input', reflow);

  let committed = false;

  const destroy = (): void => {
    ta.removeEventListener('input', reflow);
    endCellEditSession(ta);
    ta.remove();
    cellEl.classList.remove('cm-md-table-cell-editing');
    cellEl.style.boxSizing = '';
    cellEl.style.minWidth = '';
    cellEl.style.height = '';
    view.focus();
  };

  const commit = (): void => {
    if (committed) return;
    committed = true;
    const newText = encodeForCommit(ta.value);
    if (newText !== cell.text) {
      view.dispatch({
        changes: { from: cell.from, to: cell.to, insert: newText },
      });
    }
    destroy();
  };

  /**
   * Commit what is in the field, then move (#68).
   *
   * The order is the point: the text being left is committed into the cell it
   * was typed in, never dropped, and the move is computed from the document the
   * commit produced. Both line numbers are read *before* the commit — the commit
   * can move positions inside the line but cannot add or remove lines, so they
   * still name the same rows afterwards.
   */
  const commitAndMove = (move: CellMove): void => {
    if (!place) {
      commit();
      return;
    }
    const doc = view.state.doc;
    if (cell.from > doc.length) {
      commit();
      return;
    }
    const tableLine = doc.lineAt(cell.from).number - place.row;
    commit();
    moveAfterCommit(view, tableLine, place, move);
  };

  /**
   * The cell's keyboard map (#68).
   *
   * None of it is a CM6 keymap, and that is not an oversight: while this overlay
   * is open the keyboard belongs to a `<textarea>` in `document.body`, so CM6
   * never sees these keys at all. Which is what makes the two collisions in the
   * brief impossible rather than merely handled — the two-Enter exit from a
   * fenced code block (#52) and Tab/Shift+Tab indenting a list (#24) are keymap
   * bindings on `contentDOM`, and an overlay outside it cannot shadow them. It
   * is also why the `Prec.highest` rule for keys carrying an `inputType` does
   * not apply here: there is no precedence to get wrong.
   *
   * `Cmd+Enter` deliberately still means exactly "commit", unchanged. The new
   * row moved to `Cmd+Shift+Enter` instead — same gesture family, one more
   * modifier, and the commit path the regression battery covers stays the path
   * it always was.
   */
  ta.addEventListener('keydown', (e) => {
    const binding = matchCellBinding(e);
    if (!binding) return;
    if (binding.action === 'break') {
      // Shift+Enter — a paragraph break inside the cell. Left to the textarea's
      // own newline; `encodeForCommit` turns it into `<br>`, which is the only
      // way a GFM cell can hold one. Declared as a binding anyway so the
      // cheatsheet can say so.
      return;
    }
    e.preventDefault();
    switch (binding.action) {
      case 'commit':
        commit();
        break;
      case 'cancel':
        committed = true;
        destroy();
        break;
      case 'row-next':
        commitAndMove({ kind: 'row' });
        break;
      case 'col-next':
        // Tab used to commit and stop. It commits and *moves* now; the wrap
        // keeps it inside the row, so it never competes with Enter.
        commitAndMove({ kind: 'col', delta: 1 });
        break;
      case 'col-prev':
        commitAndMove({ kind: 'col', delta: -1 });
        break;
      case 'new-row':
        commitAndMove({ kind: 'new-row' });
        break;
    }
  });
  ta.addEventListener('blur', () => setTimeout(commit, 50));

  document.body.appendChild(ta);
  ta.focus();
  if (selectSrc === undefined) {
    ta.select();
  } else {
    // The offsets are in the cell's source; the field holds the decoded form,
    // so `<br>` and `\|` have to be walked before they mean anything here.
    ta.setSelectionRange(
      decodedOffset(cell.text, selectSrc.from),
      decodedOffset(cell.text, selectSrc.to)
    );
  }
  reflow(); // initial size

  setCellEditSession({
    textarea: ta,
    replace: (text, from, to) => {
      applyTextareaEdit(ta, text, from, to);
      // Формат мог удлинить текст — поле и ячейка должны за этим успеть.
      // `applyTextareaEdit` не всегда проходит через `input` (fallback —
      // прямое присваивание), поэтому reflow зовём явно.
      reflow();
    },
    commitAndMap: (from, to) => {
      // Снимок до коммита: `commit()` разрушает поле, а `ta.value` после
      // `remove()` читать уже нечестно.
      const value = ta.value;
      const base = cell.from;
      commit();
      return {
        from: base + encodedOffset(value, from),
        to: base + encodedOffset(value, to),
      };
    },
  });
}

// --- Caret in a cell (#53) ---

/** Is a cell edit overlay open right now? It owns the keyboard while it is. */
function cellEditorOpen(): boolean {
  return document.querySelector('.cm-md-table-editor') !== null;
}

/**
 * Move the document selection to wherever the caret is sitting in this cell.
 *
 * The DOM caret is the one the user sees; this is the other half — everything
 * that asks the *state* where the user is (comments, AI edits, the session's
 * saved caret) should get an answer inside the clicked cell instead of a stale
 * one somewhere else in the file.
 *
 * A non-collapsed host selection is left alone: that is a text selection being
 * made in the cell, and `live-render/selection-toolbar.ts` deliberately reads
 * it from the DOM rather than from `state.selection`.
 */
function syncDocCaret(view: EditorView, textEl: HTMLElement, cell: CellInfo): void {
  const pos = docPosForCaretIn(textEl, cell.text, cell.from);
  if (pos === null) return;
  const main = view.state.selection.main;
  if (main.empty && main.head === pos) return;
  view.dispatch({
    selection: { anchor: pos },
    // `table-selection.ts` snaps a caret off the zero-height data lines, which
    // is exactly where a caret in a body cell belongs. The tag is how it knows
    // this one was put there on purpose.
    userEvent: 'select.cell',
    scrollIntoView: false,
  });
}

/**
 * Park the caret in the clicked cell.
 *
 * Two routes, because the cell's glyphs are a nested editing host and its
 * padding is not. On the glyphs the browser places the caret itself and must be
 * left to do it — `preventDefault` here would kill drag-selection, which is
 * what #31/#42 are built on. Off the glyphs nothing would place a caret at all,
 * and CM6 would resolve the point to the widget's edge, which is the bug.
 *
 * Either way the document selection follows on `mouseup`, not now: a drag
 * starting in a cell is a text selection, and collapsing the document caret
 * into the cell mid-drag would fight it.
 */
function parkCaretOnMouseDown(
  e: MouseEvent,
  view: EditorView,
  textEl: HTMLElement,
  cell: CellInfo
): void {
  if (e.button !== 0 || e.defaultPrevented) return;
  if (cellEditorOpen()) return;

  const target = e.target;
  const onGlyphs = target instanceof Node && textEl.contains(target);
  if (!onGlyphs) {
    e.preventDefault();
    placeCaretFromPoint(textEl, e.clientX, e.clientY);
  }

  const sync = (): void => {
    document.removeEventListener('mouseup', sync, true);
    if (cellEditorOpen()) return;
    syncDocCaret(view, textEl, cell);
  };
  document.addEventListener('mouseup', sync, true);
}

/**
 * The input types a parked caret hands on to the cell edit overlay.
 *
 * Everything else stays refused, as it was before. `formatBold` is the case
 * that makes the allow-list necessary rather than decorative: Chrome fires it
 * at the host for Cmd+B on a cell selection, and opening an overlay there would
 * pull the rug out from under the format toolbar (#55/#60), which formats the
 * rendered text in place.
 */
const CELL_INPUT_TO_OVERLAY = new Set([
  'insertText',
  'insertFromPaste',
  'insertParagraph',
  'insertLineBreak',
  'insertCompositionText',
  'deleteContentBackward',
  'deleteContentForward',
]);

/**
 * Typing with the caret parked in a cell: open the overlay there and replay the
 * keystroke into it.
 *
 * The overlay is the only thing in this file that owns a cell's text, so this
 * is not "a second way to edit a cell" — it is the same commit path reached by
 * a different gesture. Enter is a plain entry into edit mode, which is also the
 * keyboard gesture #58 was looking for.
 */
function handleCellInput(
  event: InputEvent,
  view: EditorView,
  cellEl: HTMLElement,
  textEl: HTMLElement,
  cell: CellInfo,
  place: CellPlace
): void {
  if (!CELL_INPUT_TO_OVERLAY.has(event.inputType)) return;
  if (cellEditorOpen()) return;

  showCellEditor(view, cellEl, cell, hostSelectionAsSource(textEl, cell), place);

  const ta = document.querySelector<HTMLTextAreaElement>('.cm-md-table-editor');
  if (!ta) return;
  // `execCommand`, not an assignment to `value`: it is what keeps the field's
  // native undo stack intact, for the same reason `applyTextareaEdit` uses it.
  if (event.inputType === 'deleteContentBackward') {
    document.execCommand('delete');
  } else if (event.inputType === 'deleteContentForward') {
    document.execCommand('forwardDelete');
  } else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
    // Enter means "let me edit this cell", nothing more. A newline would be an
    // odd thing to open a fresh edit with.
  } else {
    const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
    if (text) document.execCommand('insertText', false, text);
  }
}

/** The live host selection, mapped to the cell's source offsets. */
function hostSelectionAsSource(
  textEl: HTMLElement,
  cell: CellInfo
): { from: number; to: number } | undefined {
  const caret = docPosForCaretIn(textEl, cell.text, cell.from);
  if (caret !== null) {
    const at = caret - cell.from;
    return { from: at, to: at };
  }
  const range = hostSelectionRange(textEl, cell.text);
  return range ?? undefined;
}

function hostSelectionRange(
  textEl: HTMLElement,
  cellText: string
): { from: number; to: number } | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!sel.anchorNode || !textEl.contains(sel.anchorNode)) return null;
  if (!sel.focusNode || !textEl.contains(sel.focusNode)) return null;
  const a = visibleOffsetIn(textEl, sel.anchorNode, sel.anchorOffset);
  const b = visibleOffsetIn(textEl, sel.focusNode, sel.focusOffset);
  return sourceRangeForVisible(cellText, Math.min(a, b), Math.max(a, b));
}

// --- DOM builder helpers (used by TableWidget in Task 5) ---

function buildCell(
  cell: CellInfo,
  colIndex: number,
  isHeader: boolean,
  ctx: TableContext,
  view: EditorView,
  /** Index of this cell's row in `ctx.rows` — what keyboard navigation steps (#68). */
  rowIndex: number,
  colCtrl?: ColCtrl,
  anchors: CommentAnchorSpan[] = []
): HTMLElement {
  const cellEl = document.createElement('span');
  cellEl.className = 'cm-md-table-cell';
  if (isHeader) cellEl.classList.add('cm-md-table-cell-header');

  // The text gets its own element so the nested editing host covers exactly
  // the cell's content and none of the hover controls: a `contenteditable`
  // ancestor would swallow the mousedown that starts a column drag.
  const textEl = document.createElement('span');
  textEl.className = CELL_TEXT_CLASS;
  // The cell's source range travels on the element: a selection made inside it
  // is invisible to `state.selection` (the widget claims the events), so this
  // is the only way back from rendered characters to document positions — see
  // `live-render/cell-anchor.ts`. Safe to freeze into the DOM because the
  // widget's `eq()` compares every cell `from`, so any shift rebuilds it.
  makeWidgetTextSelectable(textEl, {
    source: { from: cell.from, to: cell.to },
    // A caret parked in a cell promises that typing edits that cell. The host
    // cannot keep that promise itself, so the keystroke opens the edit overlay
    // at the parked offset and is replayed into it (#53).
    onRefusedInput: (event) =>
      handleCellInput(event, view, cellEl, textEl, cell, { row: rowIndex, col: colIndex }),
  });
  renderCellContent(textEl, cell.text, view, cellHighlights(cell, anchors));
  cellEl.appendChild(textEl);

  cellEl.addEventListener('mousedown', (e) =>
    parkCaretOnMouseDown(e, view, textEl, cell)
  );

  cellEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCellEditor(view, cellEl, cell, undefined, { row: rowIndex, col: colIndex });
  });

  if (isHeader && colCtrl) {
    cellEl.classList.add('cm-md-table-cell-has-ctrl');
    // Панель кнопок одна на таблицу и живёт снаружи неё — сюда она только
    // переезжает по наведению. См. `createColCtrl`.
    cellEl.addEventListener('mouseenter', () => colCtrl.attach(cellEl, colIndex));
  }

  return cellEl;
}

/**
 * Панель кнопок колонки — одна на таблицу, лежит в `.cm-md-table-wrap`.
 *
 * Почему не по кнопке в каждой ячейке заголовка, как было: у `.cm-md-table`
 * стоит `overflow: hidden` (им скругляются её углы), и он срезает всё, что
 * выезжает выше верхней грани таблицы — именно это и резало кнопки пополам.
 * Перенести скругление на строки нельзя, `border-radius` на `display:
 * table-row` Chrome игнорирует. Значит, панель обязана быть снаружи бокса с
 * клипом; выравнивание по колонке при этом уже нечем задать в CSS, поэтому
 * `left` ставится из JS.
 *
 * Чтение геометрии происходит ровно один раз на наведение на колонку — не на
 * кадр и не на нажатие клавиши.
 */
interface ColCtrl {
  el: HTMLElement;
  attach(cellEl: HTMLElement, colIndex: number): void;
  scheduleHide(): void;
}

/** Живо ли выделение текста внутри `root` (ячейки — вложенные editing host'ы). */
function selectionInside(root: HTMLElement): boolean {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  return node !== null && root.contains(node);
}

function createColCtrl(view: EditorView, ctx: TableContext, wrap: HTMLElement): ColCtrl {
  const el = document.createElement('span');
  el.className = 'cm-md-table-col-ctrl';

  let target: { cellEl: HTMLElement; colIndex: number } | null = null;
  let hideTimer: number | undefined;

  const drag = mkBtn('⠿', 'cm-md-table-btn-drag cm-md-table-btn-drag-col', () => {});
  drag.addEventListener('mousedown', (e) => {
    if (target) startColDrag(e, view, ctx, target.colIndex, target.cellEl);
  });
  el.appendChild(drag);

  if (ctx.colCount > 1) {
    el.appendChild(
      mkBtn('−', 'cm-md-table-btn-del', () => {
        if (target) deleteColumn(view, ctx, target.colIndex);
      })
    );
  }

  const attach = (cellEl: HTMLElement, colIndex: number): void => {
    window.clearTimeout(hideTimer);
    target = { cellEl, colIndex };
    // Выделение текста в ячейке поднимает над заголовком свой тулбар (💬 и
    // прочее) — ровно в ту полосу, где стоит эта панель. Пока выделение живо,
    // панель уступает место: намерение пользователя сейчас в выделении.
    if (selectionInside(wrap)) {
      el.dataset.visible = 'false';
      return;
    }
    const cellRect = cellEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    el.style.left = `${cellRect.left - wrapRect.left + cellRect.width / 2}px`;
    el.dataset.visible = 'true';
  };

  const scheduleHide = (): void => {
    window.clearTimeout(hideTimer);
    // Задержка нужна, чтобы мышь успела перейти из ячейки в саму панель:
    // между ними 2px зазора, и без неё панель гасла бы на полпути к кнопке.
    hideTimer = window.setTimeout(() => {
      if (drag.matches(':active') || el.matches(':hover')) return;
      el.dataset.visible = 'false';
      target = null;
    }, 120);
  };

  el.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
  el.addEventListener('mouseleave', scheduleHide);

  // Начало любого взаимодействия внутри таблицы гасит панель. Нажатия на её
  // собственные кнопки сюда не доходят: `mkBtn` глушит всплытие, поэтому
  // перетаскивание колонки панель не прячет.
  wrap.addEventListener('mousedown', () => {
    el.dataset.visible = 'false';
  });
  // По отпусканию кнопки решаем заново: выделения нет — панель возвращается,
  // хотя `mouseenter` больше не придёт (указатель так и стоит в той ячейке).
  wrap.addEventListener('mouseup', () => {
    const restore = target;
    if (!restore) return;
    window.setTimeout(() => {
      if (drag.matches(':active')) return;
      attach(restore.cellEl, restore.colIndex);
    }, 0);
  });

  return { el, attach, scheduleHide };
}

function buildHeaderCtrlCell(view: EditorView, ctx: TableContext): HTMLElement {
  const cellEl = document.createElement('span');
  cellEl.className = 'cm-md-table-cell cm-md-table-row-ctrl';

  const toggleBtn = mkBtn('⇔', 'cm-md-table-btn-toggle', () => {
    view.dispatch({ effects: toggleTableMode.of({ pos: ctx.nodeFrom }) });
  });
  toggleBtn.title = t('editor.tables.toggle_mode');
  cellEl.appendChild(toggleBtn);

  // ⓘ — the cell-editing keys, rendered from the list the key handler resolves
  // against (#69). It goes *inside* this cell rather than into the strip above
  // the header line, which belongs to the column buttons (#48) and is the one
  // place a table at the top of the document has no room to spare.
  cellEl.appendChild(createHotkeySheetButton().el);

  return cellEl;
}

function buildDataCtrlCell(
  view: EditorView,
  ctx: TableContext,
  dataRowIndex: number,
  rowEl: HTMLElement,
  dataCount: number
): HTMLElement {
  const cellEl = document.createElement('span');
  cellEl.className = 'cm-md-table-cell cm-md-table-row-ctrl';

  if (dataCount > 1) {
    const del = mkBtn('−', 'cm-md-table-btn-del cm-md-table-btn-del-row-left', () =>
      deleteRow(view, ctx, dataRowIndex)
    );
    cellEl.appendChild(del);
  }

  const dragHandle = mkBtn('⠿', 'cm-md-table-btn-drag cm-md-table-btn-drag-row', () => {});
  dragHandle.addEventListener('mousedown', (e) => {
    startRowDrag(e, view, ctx, dataRowIndex, rowEl);
  });
  cellEl.appendChild(dragHandle);

  return cellEl;
}

function buildHeaderRow(
  row: RowData,
  ctx: TableContext,
  view: EditorView,
  colCtrl: ColCtrl,
  anchors: CommentAnchorSpan[] = []
): HTMLElement {
  const tr = document.createElement('span');
  tr.className = 'cm-md-table-row cm-md-table-row-header';

  // The header is always `ctx.rows[0]` — `buildTableContext` walks the table's
  // lines in order and the first one is the header by GFM's definition.
  const rowIndex = 0;

  tr.appendChild(buildHeaderCtrlCell(view, ctx));

  row.cells.forEach((cell, i) => {
    tr.appendChild(buildCell(cell, i, true, ctx, view, rowIndex, colCtrl, anchors));
  });

  tr.addEventListener('mouseleave', colCtrl.scheduleHide);

  return tr;
}

function buildDataRow(
  row: RowData,
  dataRowIndex: number,
  ctx: TableContext,
  view: EditorView,
  dataCount: number,
  anchors: CommentAnchorSpan[] = []
): HTMLElement {
  const tr = document.createElement('span');
  tr.className = 'cm-md-table-row cm-md-table-row-data';

  const ctrlCell = buildDataCtrlCell(view, ctx, dataRowIndex, tr, dataCount);
  tr.appendChild(ctrlCell);

  // Navigation steps `ctx.rows`, which still contains the delimiter this row
  // list has filtered out, so the data index is not the one to hand on (#68).
  const rowIndex = ctx.rows.indexOf(row);

  row.cells.forEach((cell, i) => {
    tr.appendChild(buildCell(cell, i, false, ctx, view, rowIndex, undefined, anchors));
  });

  return tr;
}

// --- Main decoration function ---

/**
 * Read a table's shape out of the document.
 *
 * Split out of `decorateTable` for #68: keyboard navigation has to re-read the
 * table *after* the commit it just made, and the only alternative to reusing
 * this walk is a second parser that would drift from this one on the first
 * ragged table. Delimiter detection stays position-based (second line) for the
 * reason in `CLAUDE.md` — the regex form classifies a data row of dashes as the
 * delimiter and hides it.
 *
 * @returns `null` for a table too large to be worth drawing
 */
export function buildTableContext(
  doc: Text,
  nodeFrom: number,
  nodeTo: number
): TableContext | null {
  const startLine = doc.lineAt(nodeFrom);
  const endLine = doc.lineAt(nodeTo);

  // Performance guard — bail before parsing pathological tables
  if (endLine.number - startLine.number + 1 > 500) return null;

  const rows: RowData[] = [];
  const colWidths: number[] = [];
  let dataRowIndex = 0;

  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = doc.line(i);
    const isHeader = i === startLine.number;
    const isDelimiter = i === startLine.number + 1;
    const cells = parseCellsWithPositions(line.text, line.from);

    rows.push({
      from: line.from,
      to: line.to,
      text: line.text,
      cells,
      isDelimiter,
      isHeader,
      rowIndex: isDelimiter ? -1 : dataRowIndex++,
    });

    if (!isDelimiter) {
      cells.forEach((cell, col) => {
        colWidths[col] = Math.max(colWidths[col] ?? 0, cell.text.length);
      });
    }
  }

  return {
    rows,
    colWidths,
    colCount: colWidths.length,
    nodeFrom,
    nodeTo,
  };
}

export function decorateTable(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  // FLAVOUR: tables are pinned to 'never' under every shipped flavour — always
  // rendered as a widget, never reverting to raw markdown on cursor. The widget
  // absorbs its own events, so there is no `shouldReveal` call here by design,
  // not by omission. See preview/CLAUDE.md, "Always Rendered".
  const ctx = buildTableContext(view.state.doc, node.from, node.to);
  if (!ctx) return;
  const rows = ctx.rows;

  const headerRow = rows.find((r) => r.isHeader);
  if (!headerRow) return;

  const mode = getTableMode(view.state, ctx.nodeFrom);
  // Read straight from the comment field, which maps its ranges through every
  // edit — including edits above the table, which is the case where a copy
  // kept anywhere else would drift (#62).
  const anchors = commentAnchorsIn(view.state, node.from, node.to);

  // Header line: host of the full-table widget
  builder.add(
    headerRow.from,
    headerRow.from,
    Decoration.line({ class: 'cm-md-table-line cm-md-table-header' })
  );
  builder.add(
    headerRow.from,
    headerRow.to,
    Decoration.replace({ widget: new TableWidget(ctx, mode, anchors) })
  );

  // Hide all non-header lines (delimiter + data rows)
  for (const row of rows) {
    if (row.isHeader) continue;
    builder.add(
      row.from,
      row.from,
      Decoration.line({ class: 'cm-md-table-line cm-md-table-hidden' })
    );
  }
}
