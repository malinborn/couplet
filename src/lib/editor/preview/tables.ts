import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { DecoSink } from './utils';
import { markdownTable } from 'markdown-table';
import { toggleTableMode, getTableMode } from './table-state';
import { encodeForCommit, decodeForEdit } from './table-encoding';
import { navigateToHeading } from '../heading-slugs';
import { makeWidgetTextSelectable, eventInside } from '../widget-text-selection';

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
  const lastRow = ctx.rows[ctx.rows.length - 1];
  const cells = ctx.colWidths.map(w => ' ' + '-'.padEnd(Math.max(w, 1)) + ' ');
  const newRow = '|' + cells.join('|') + '|';
  view.dispatch({
    changes: { from: lastRow.to, to: lastRow.to, insert: '\n' + newRow },
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
  grid[0].push('New');
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
    private mode: 'wrap' | 'full'
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
      table.appendChild(buildHeaderRow(headerRow, this.ctx, view, colCtrl));
    }

    const dataRows = this.ctx.rows.filter((r) => !r.isDelimiter && !r.isHeader);
    const dataCount = dataRows.length;
    dataRows.forEach((row, i) => {
      table.appendChild(buildDataRow(row, i, this.ctx, view, dataCount));
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
   * `false` everywhere except inside a cell's text.
   *
   * The widget deliberately lets CM6 handle its events (that is what `false`
   * means here — see `eventBelongsToEditor` in `@codemirror/view`), which is
   * how a click on a table still moves the document selection.
   *
   * But cell text is a nested editing host (`makeWidgetTextSelectable`), and
   * CM6's `MouseSelection` would immediately snap a drag started there out to
   * the whole table range via `atomicRanges`, leaving the browser with an
   * empty selection — measured, that is exactly what #31 reported. Handing
   * those events back to the browser lets the native selection stand, and the
   * same exemption makes `copy` copy the visible cell text instead of the
   * table's markdown source.
   */
  ignoreEvent(event: Event): boolean {
    return eventInside(event, `.${CELL_TEXT_CLASS}`);
  }
}

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'boldItalic'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'link'; text: string; url: string };

/**
 * Parse a cell's text into inline markdown tokens.
 *
 * Supported: code, bold+italic, bold, italic, strikethrough, links `[text](url)`.
 * Order matters — longer patterns are matched first to avoid emphasis swallowing link
 * brackets. Unmatched text becomes `text` tokens.
 */
export function parseInlineMarkdown(text: string): InlineToken[] {
  if (!text) return [];

  // Order: code | link | ***bi*** | **b** | *i* | ~~s~~. Link before emphasis so the
  // square brackets don't get treated as italic-eligible text.
  const inlineRegex = /(`+)(.*?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)|(\*\*\*|___)(.*?)\5|(\*\*|__)(.*?)\7|(\*|_)(.*?)\9|(~~)(.*?)\11/g;

  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      tokens.push({ type: 'code', value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: 'link', text: match[3], url: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'boldItalic', value: match[6] });
    } else if (match[7] !== undefined) {
      tokens.push({ type: 'bold', value: match[8] });
    } else if (match[9] !== undefined) {
      tokens.push({ type: 'italic', value: match[10] });
    } else if (match[11] !== undefined) {
      tokens.push({ type: 'strike', value: match[12] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return tokens;
}

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
  if (url.startsWith('#')) {
    navigateToHeading(view, url.slice(1));
  } else {
    openExternal(url);
  }
}

/** Render inline markdown (code, bold, italic, strikethrough, links) into a cell element. */
function renderCellContent(cellEl: HTMLElement, text: string, view: EditorView): void {
  if (!text) return;

  const tokens = parseInlineMarkdown(text);

  if (tokens.length === 0) {
    cellEl.textContent = text;
    return;
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        cellEl.appendChild(document.createTextNode(token.value));
        break;
      case 'code': {
        const code = document.createElement('code');
        code.className = 'cm-md-table-inline-code';
        code.textContent = token.value;
        cellEl.appendChild(code);
        break;
      }
      case 'boldItalic': {
        const strong = document.createElement('strong');
        const em = document.createElement('em');
        em.textContent = token.value;
        strong.appendChild(em);
        cellEl.appendChild(strong);
        break;
      }
      case 'bold': {
        const el = document.createElement('strong');
        el.textContent = token.value;
        cellEl.appendChild(el);
        break;
      }
      case 'italic': {
        const el = document.createElement('em');
        el.textContent = token.value;
        cellEl.appendChild(el);
        break;
      }
      case 'strike': {
        const el = document.createElement('s');
        el.textContent = token.value;
        cellEl.appendChild(el);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        a.className = 'cm-md-link';
        a.href = token.url;
        a.rel = 'noopener noreferrer';
        a.textContent = token.text;
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

function showCellEditor(view: EditorView, cellEl: HTMLElement, cell: CellInfo): void {
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

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      destroy();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit();
    }
    // Plain Enter -> textarea default newline behavior
  });
  ta.addEventListener('blur', () => setTimeout(commit, 50));

  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  reflow(); // initial size
}

// --- DOM builder helpers (used by TableWidget in Task 5) ---

function buildCell(
  cell: CellInfo,
  colIndex: number,
  isHeader: boolean,
  ctx: TableContext,
  view: EditorView,
  colCtrl?: ColCtrl
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
  makeWidgetTextSelectable(textEl, { source: { from: cell.from, to: cell.to } });
  renderCellContent(textEl, cell.text, view);
  cellEl.appendChild(textEl);

  cellEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCellEditor(view, cellEl, cell);
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

  return { el, attach, scheduleHide };
}

function buildHeaderCtrlCell(view: EditorView, ctx: TableContext): HTMLElement {
  const cellEl = document.createElement('span');
  cellEl.className = 'cm-md-table-cell cm-md-table-row-ctrl';

  const toggleBtn = mkBtn('⇔', 'cm-md-table-btn-toggle', () => {
    view.dispatch({ effects: toggleTableMode.of({ pos: ctx.nodeFrom }) });
  });
  toggleBtn.title = 'Toggle wrap / full width';
  cellEl.appendChild(toggleBtn);

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
  colCtrl: ColCtrl
): HTMLElement {
  const tr = document.createElement('span');
  tr.className = 'cm-md-table-row cm-md-table-row-header';

  tr.appendChild(buildHeaderCtrlCell(view, ctx));

  row.cells.forEach((cell, i) => {
    tr.appendChild(buildCell(cell, i, true, ctx, view, colCtrl));
  });

  tr.addEventListener('mouseleave', colCtrl.scheduleHide);

  return tr;
}

function buildDataRow(
  row: RowData,
  dataRowIndex: number,
  ctx: TableContext,
  view: EditorView,
  dataCount: number
): HTMLElement {
  const tr = document.createElement('span');
  tr.className = 'cm-md-table-row cm-md-table-row-data';

  const ctrlCell = buildDataCtrlCell(view, ctx, dataRowIndex, tr, dataCount);
  tr.appendChild(ctrlCell);

  row.cells.forEach((cell, i) => {
    tr.appendChild(buildCell(cell, i, false, ctx, view));
  });

  return tr;
}

// --- Main decoration function ---

export function decorateTable(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  // FLAVOUR: tables are pinned to 'never' under every shipped flavour — always
  // rendered as a widget, never reverting to raw markdown on cursor. The widget
  // absorbs its own events, so there is no `shouldReveal` call here by design,
  // not by omission. See preview/CLAUDE.md, "Always Rendered".
  const doc = view.state.doc;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);

  // Performance guard — bail before parsing pathological tables
  if (endLine.number - startLine.number + 1 > 500) return;

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

  const ctx: TableContext = {
    rows,
    colWidths,
    colCount: colWidths.length,
    nodeFrom: node.from,
    nodeTo: node.to,
  };

  const headerRow = rows.find((r) => r.isHeader);
  if (!headerRow) return;

  const mode = getTableMode(view.state, ctx.nodeFrom);

  // Header line: host of the full-table widget
  builder.add(
    headerRow.from,
    headerRow.from,
    Decoration.line({ class: 'cm-md-table-line cm-md-table-header' })
  );
  builder.add(
    headerRow.from,
    headerRow.to,
    Decoration.replace({ widget: new TableWidget(ctx, mode) })
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
