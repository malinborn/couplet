import { markdownTable } from 'markdown-table';
import { parseCellsWithPositions } from '../editor/preview/tables';
import { decodeForEdit } from '../editor/preview/table-encoding';

/**
 * The invisible content an otherwise empty table row carries. Lezer GFM drops
 * a whitespace-only row from the `Table` node — the table would end there —
 * while a row holding U+200B is kept, and `trim()` does not strip it. Every
 * U+200B is removed when the table is read back as CSV, so the mark never
 * reaches the file, wherever the caret was when someone typed into the cell.
 */
export const EMPTY_CELL_MARK = '\u200B';

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export type TableRows = { ok: true; rows: string[][] } | { ok: false; error: string };

function encodeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

function decodeCell(text: string): string {
  return decodeForEdit(text).split(EMPTY_CELL_MARK).join('');
}

/**
 * CSV rows → the canonical GFM table a CSV buffer holds: first row is the
 * header, rows padded to the widest one, padding identical to the widget's own
 * whole-table rewrite, a trailing newline.
 */
export function rowsToTable(rows: string[][]): string {
  const source = rows.length === 0 ? [['']] : rows;
  // A reduce, not `Math.max(...spread)`: a CSV has no row cap, and spreading
  // one argument per row overflows the engine's argument limit on a big file.
  const width = source.reduce((w, r) => Math.max(w, r.length), 1);
  const grid = source.map((row) => {
    const cells = Array.from({ length: width }, (_, i) => encodeCell(row[i] ?? ''));
    // `some`, not `every`: TS infers `every((c) => c === '')` as a type
    // predicate and narrows `cells` to `''[]`, rejecting the assignment.
    if (!cells.some((c) => c !== '')) cells[0] = EMPTY_CELL_MARK;
    return cells;
  });
  return markdownTable(grid, { align: null, padding: true }) + '\n';
}

/**
 * A CSV buffer → CSV rows, or why it is not exactly one table. Cells are read
 * with the widget's own `parseCellsWithPositions`, so the codec sees the cells
 * the user sees (trimmed — leading/trailing spaces of a value do not survive).
 */
export function tableToRows(md: string): TableRows {
  const lines = md.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return { ok: false, error: 'not a table' };
  if (!DELIMITER_ROW.test(lines[1])) return { ok: false, error: 'line 2 is not a table delimiter row' };
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 1) continue;
    if (!lines[i].trimStart().startsWith('|')) {
      return { ok: false, error: `line ${i + 1} is not a table row` };
    }
    rows.push(parseCellsWithPositions(lines[i], 0).map((c) => decodeCell(c.text)));
  }
  return { ok: true, rows };
}
