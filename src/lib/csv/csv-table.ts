import { markdownTable } from 'markdown-table';
import { parseCellsWithPositions } from '../editor/preview/tables';
import { decodeForEdit } from '../editor/preview/table-encoding';

const DELIMITER_ROW = /^\s*\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|\s*$/;
/** Ends with a `|` that is not escaped — the widget's own rule for a pipe. */
const CLOSED_ROW = /(^|[^\\])\|\s*$/;

export type TableRows = { ok: true; rows: string[][] } | { ok: false; error: string };

// Not `encodeForCommit`: it strips trailing newlines, losing them from a value like "a\n".
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
 *
 * Strict on purpose: this is the edit guard's invariant and the save path, so
 * anything not drawn as exactly this one table, or drawn with a cell missing,
 * is refused rather than saved short. Every line opens and closes with `|`
 * (the canonical form always does); the delimiter row has the header's cell
 * count; a row may be narrower than the header (GFM pads it) but not wider
 * (GFM drops the extra cells).
 */
export function tableToRows(md: string): TableRows {
  const lines = md.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return { ok: false, error: 'not a table' };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('|') || !CLOSED_ROW.test(lines[i])) {
      return { ok: false, error: `line ${i + 1} is not a table row` };
    }
  }
  if (!DELIMITER_ROW.test(lines[1])) return { ok: false, error: 'line 2 is not a table delimiter row' };
  const width = parseCellsWithPositions(lines[0], 0).length;
  if (parseCellsWithPositions(lines[1], 0).length !== width) {
    return { ok: false, error: 'the delimiter row does not match the header' };
  }
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 1) continue;
    const cells = parseCellsWithPositions(lines[i], 0);
    if (cells.length > width) {
      return { ok: false, error: `line ${i + 1} has more cells than the header` };
    }
    rows.push(cells.map((c) => decodeForEdit(c.text)));
  }
  return { ok: true, rows };
}
