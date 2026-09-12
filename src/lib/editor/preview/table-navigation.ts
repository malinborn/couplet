/**
 * Keyboard navigation between table cells (#68) — the pure half.
 *
 * Everything here is arithmetic over a table's shape: which column comes next,
 * which row Enter lands in, what has to be inserted to leave the table. The DOM
 * and the `EditorView` live in `tables.ts`; this file is what the unit tests can
 * reach, because there is no jsdom in this project's vitest setup and nothing
 * builds a real view (see `live-render/CLAUDE.md`, "Testing").
 *
 * The shape of the movement is the owner's decision, not a derivation:
 *
 * | key | movement |
 * |---|---|
 * | `Enter` | next row, **same column** |
 * | `Enter` on the last row | leave the table, one empty line beneath it |
 * | `Shift+Enter` | no movement — a paragraph break inside the cell |
 * | `Tab` / `Shift+Tab` | next / previous column, **wrapping inside the row** |
 * | `Cmd+Enter` | no movement — commit, exactly as before |
 * | `Cmd+Shift+Enter` | commit and open a fresh row below the current one |
 *
 * Two asymmetries in that table are deliberate. Vertical motion keeps the
 * column, so walking a column down a table of figures never drifts sideways;
 * horizontal motion keeps the row, so Tab at the right edge does not silently
 * become a row change that Enter already owns. Between them every cell is
 * reachable and no key means two different things.
 */

/** The rows a table has, as far as navigation cares. */
export interface NavRow {
  /** The GFM `|---|---|` line. It is never a destination. */
  isDelimiter: boolean;
  /** How many cells this row actually has (tables can be ragged). */
  cellCount: number;
}

/**
 * The column Tab / Shift+Tab moves to.
 *
 * Wraps inside the row: from the last column Tab lands on the first one, and
 * Shift+Tab from the first lands on the last. It never changes rows — that is
 * Enter's job, and a key that sometimes moves down and sometimes sideways is a
 * key nobody can predict.
 *
 * A single-column table therefore answers with the column it was given, which
 * is the honest result: there is nowhere else on this row to go.
 */
export function stepColumn(col: number, cellCount: number, delta: 1 | -1): number {
  if (cellCount <= 0) return 0;
  return (((col + delta) % cellCount) + cellCount) % cellCount;
}

/**
 * The row Enter moves to, or `null` when there is none below.
 *
 * `null` is the signal to leave the table — see {@link planTableExit}. The
 * delimiter is skipped rather than visited, so Enter in a header cell lands in
 * the first data row.
 *
 * A row with no cells is skipped for a less obvious reason, and it is a shape
 * that really occurs: GFM only ends a table at a blank line or another
 * block-level structure, so a bare paragraph line written directly under a
 * table (`Сразу текст.`, no pipes at all) is parsed as one more row of it.
 * There is no cell there to open an overlay on, so treating it as a destination
 * means Enter closes the editor and does nothing — a dead end at the bottom of
 * the table. Skipping it means Enter leaves the table, which is what the user
 * asked for.
 */
export function nextNavigableRow(rows: NavRow[], from: number): number | null {
  for (let i = from + 1; i < rows.length; i++) {
    if (!rows[i].isDelimiter && rows[i].cellCount > 0) return i;
  }
  return null;
}

/**
 * The column to actually open in a row that may be shorter than the one we came
 * from. Ragged tables are legal markdown and Lezer parses them happily.
 */
export function clampColumn(col: number, cellCount: number): number {
  if (cellCount <= 0) return 0;
  return Math.min(col, cellCount - 1);
}

/** What leaving the table costs the document, and where the caret ends up. */
export interface TableExitPlan {
  /** Text to insert at {@link at}. Empty when the empty line already exists. */
  insert: string;
  at: number;
  /** Where the caret goes, in coordinates *after* the insertion. */
  caret: number;
}

/**
 * Enter on the last row: leave the table with exactly one empty line under it.
 *
 * The "exactly one" is the whole of this function. The naive version always
 * inserts `\n`, and a user who pressed Enter out of a table, typed nothing, and
 * pressed Enter out of it again ends up with a growing stack of blank lines
 * under a table they never touched. So an empty line that is already there is
 * *reused*: the caret goes to it and the document is not changed at all.
 *
 * Three cases, and the third is the one that is easy to miss:
 *
 * - no line below (the table ends the file) → insert `\n`, caret on the new line
 * - the line below is blank → insert nothing, caret on it
 * - the line below has text → insert `\n`, which puts one blank line between
 *   the table and that text rather than shoving the caret into the text
 *
 * @param tableTo end of the table's last line
 * @param nextLine the line after the table, or `null` if the table ends the doc
 */
export function planTableExit(
  tableTo: number,
  nextLine: { from: number; to: number; text: string } | null
): TableExitPlan {
  if (nextLine === null) {
    return { insert: '\n', at: tableTo, caret: tableTo + 1 };
  }
  if (nextLine.text.trim() === '') {
    return { insert: '', at: tableTo, caret: nextLine.from };
  }
  return { insert: '\n', at: tableTo, caret: tableTo + 1 };
}

/**
 * A fresh table row, padded to the table's column widths.
 *
 * `-` rather than a space, and that is load-bearing rather than cosmetic: the
 * Lezer GFM parser **excludes whitespace-only rows** from the `Table` node, so a
 * row of blanks would not be part of the table at all and the widget would stop
 * drawing it. Same reason `addRow` has always done it this way.
 */
export function newRowMarkdown(colWidths: number[]): string {
  const cells = colWidths.map((w) => ' ' + '-'.padEnd(Math.max(w, 1)) + ' ');
  return '|' + cells.join('|') + '|';
}

/**
 * Which row a `Cmd+Shift+Enter` row lands after.
 *
 * "Right after the current one" is unambiguous everywhere except the header,
 * where the line immediately below is the `|---|` delimiter and inserting there
 * would split the table in half — the header would lose its delimiter and stop
 * being a table. From a header cell the new row therefore becomes the **first
 * data row**, which is what "right after this one" means once the delimiter is
 * understood as part of the header rather than as a row.
 *
 * @returns index into `rows` of the row the insertion goes after
 */
export function rowInsertAfter(rows: NavRow[], rowIndex: number): number {
  let i = rowIndex;
  while (i + 1 < rows.length && rows[i + 1].isDelimiter) i++;
  return i;
}
