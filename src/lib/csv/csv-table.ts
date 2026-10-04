import { markdownTable } from 'markdown-table';
import { parseCellsWithPositions } from '../editor/preview/tables';
import { decodeForEdit } from '../editor/preview/table-encoding';

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export type TableRows = { ok: true; rows: string[][] } | { ok: false; error: string };

function encodeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
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
  // An all-empty row stays a table row (Lezer GFM keeps `|   |   |`, measured
  // with @lezer/markdown 1.6.3), so it needs no mark.
  const grid = source.map((row) =>
    Array.from({ length: width }, (_, i) => encodeCell(row[i] ?? ''))
  );
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
    rows.push(parseCellsWithPositions(lines[i], 0).map((c) => decodeForEdit(c.text)));
  }
  return { ok: true, rows };
}
