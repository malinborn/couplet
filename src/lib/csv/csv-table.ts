import { markdownTable } from 'markdown-table';
import { parseCellsWithPositions, type CellInfo } from '../editor/preview/tables';
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
 * A line `tableToRows` strips from the end of a buffer. Only trailing ones are
 * stripped: a blank line between rows fails `isClosedRow` like any other text.
 */
export function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/** The rule for every line of the table: opens with `|`, closes with an unescaped `|`. */
export function isClosedRow(line: string): boolean {
  return line.trimStart().startsWith('|') && CLOSED_ROW.test(line);
}

/**
 * The header and delimiter lines as a table head: its width (the header's
 * cell count), or why they are not one. Both lines must already have passed
 * `isClosedRow`.
 */
export function tableHead(
  header: string,
  delimiter: string
): { ok: true; width: number } | { ok: false; error: string } {
  if (!DELIMITER_ROW.test(delimiter)) return { ok: false, error: 'line 2 is not a table delimiter row' };
  const width = parseCellsWithPositions(header, 0).length;
  if (parseCellsWithPositions(delimiter, 0).length !== width) {
    return { ok: false, error: 'the delimiter row does not match the header' };
  }
  return { ok: true, width };
}

/**
 * The cells of a row that is not the delimiter (the header included), or
 * `null` when it has more cells than the head is wide — GFM would drop the
 * extra ones, a silent loss on save.
 */
export function bodyRowCells(line: string, width: number): CellInfo[] | null {
  const cells = parseCellsWithPositions(line, 0);
  return cells.length > width ? null : cells;
}

/**
 * Everything `tableToRows` demands of one line below the delimiter row, built
 * from the same two pieces it uses. The edit guard's incremental check
 * (`csv-guard.ts`) validates the lines an edit touched with this, so the
 * guard and the save path cannot drift apart.
 */
export function isTableBodyLine(line: string, width: number): boolean {
  return isClosedRow(line) && bodyRowCells(line, width) !== null;
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
 * (GFM drops the extra cells). The rules themselves are the exported per-line
 * helpers above — this function only arranges them.
 */
export function tableToRows(md: string): TableRows {
  const lines = md.split('\n');
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1])) lines.pop();
  if (lines.length < 2) return { ok: false, error: 'not a table' };
  for (let i = 0; i < lines.length; i++) {
    if (!isClosedRow(lines[i])) return { ok: false, error: `line ${i + 1} is not a table row` };
  }
  const head = tableHead(lines[0], lines[1]);
  if (!head.ok) return head;
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 1) continue;
    const cells = bodyRowCells(lines[i], head.width);
    if (!cells) return { ok: false, error: `line ${i + 1} has more cells than the header` };
    rows.push(cells.map((c) => decodeForEdit(c.text)));
  }
  // Inverse of rowsToTable's [] → [['']]: one empty header cell and no data is
  // an empty file. Cost: a file holding exactly `""` saves as empty.
  if (rows.length === 1 && rows[0].length === 1 && rows[0][0] === '') return { ok: true, rows: [] };
  return { ok: true, rows };
}
