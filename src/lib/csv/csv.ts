/**
 * RFC 4180 CSV, parsed to rows of strings and written back in the dialect it
 * was read in. Pure: no editor, no disk. The table side lives in
 * `csv-table.ts`, the disk side in `csv-codec.ts`.
 */

export type CsvDelimiter = ',' | ';' | '\t';
export type CsvEol = '\n' | '\r\n' | '\r';

export interface CsvDialect {
  delimiter: CsvDelimiter;
  /** The file started with U+FEFF. */
  bom: boolean;
  /** Record separator: the first line break outside quotes. */
  eol: CsvEol;
  /** The last record was followed by a record separator. */
  trailingNewline: boolean;
  /**
   * Empty lines after the last record. Kept out of the rows — as rows they
   * would become table rows and save back as `,` lines — and written back as
   * that many extra separators.
   */
  trailingBlankLines: number;
}

export type CsvParse =
  | { ok: true; rows: string[][]; dialect: CsvDialect }
  | { ok: false; error: string };

interface Records {
  rows: string[][];
  /** The first line break outside quotes, or null when there is none. */
  eol: CsvEol | null;
  /** How many of the last rows are empty lines (not a quoted `""`). */
  trailingBlank: number;
}

const BOM = '\uFEFF';
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];
const SNIFF_CHARS = 65536;
const SNIFF_ROWS = 20;

/**
 * Split `text` into records. `lenient` returns what was read when the text
 * ends inside quotes (used for sniffing a truncated sample); otherwise that
 * is an error and the answer is `null`.
 */
function parseWith(text: string, delimiter: string, lenient: boolean): Records | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  /** The current field was opened by a quote — `""` is a field, not nothing. */
  let fieldQuoted = false;
  /** The current record has seen a quote: it is not an empty line. */
  let rowQuoted = false;
  let eol: CsvEol | null = null;
  let trailingBlank = 0;
  let i = 0;
  const n = text.length;
  const endRecord = () => {
    row.push(field);
    const blank = row.length === 1 && field === '' && !rowQuoted;
    trailingBlank = blank ? trailingBlank + 1 : 0;
    rows.push(row);
    row = [];
    field = '';
    fieldQuoted = false;
    rowQuoted = false;
  };
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      fieldQuoted = true;
      rowQuoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      fieldQuoted = false;
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      const crlf = c === '\r' && text[i + 1] === '\n';
      eol ??= crlf ? '\r\n' : c;
      endRecord();
      i += crlf ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (quoted && !lenient) return null;
  if (field !== '' || fieldQuoted || row.length > 0) endRecord();
  return { rows, eol, trailingBlank };
}

/**
 * The delimiter that splits the sample into the most consistent multi-column
 * records: the header's field count, times how many of the first records share
 * it. A strict `>` keeps `,` on a tie.
 */
function sniffDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, SNIFF_CHARS);
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const rows = (parseWith(sample, d, true)?.rows ?? []).slice(0, SNIFF_ROWS);
    if (rows.length === 0) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    const score = width * rows.filter((r) => r.length === width).length;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * The rules that turn text into a dialect, once: `lenient` reads to the end
 * even inside an unterminated quote (the dialect of a file that no longer
 * parses), otherwise that is a failure and the answer is `null`.
 */
function analyse(
  text: string,
  hint: { delimiter?: CsvDelimiter } | undefined,
  lenient: boolean
): { rows: string[][]; dialect: CsvDialect } | null {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const delimiter = hint?.delimiter ?? sniffDelimiter(body);
  const records = parseWith(body, delimiter, lenient);
  if (records === null) return null;
  const { eol, trailingBlank } = records;
  const rows = records.rows.slice(0, records.rows.length - trailingBlank);
  const trailingNewline = body.endsWith('\n') || body.endsWith('\r');
  return {
    rows,
    dialect: { delimiter, bom, eol: eol ?? '\n', trailingNewline, trailingBlankLines: trailingBlank },
  };
}

/**
 * The dialect `text` is written in — the same answer `parseCsv` gives, also
 * for text that does not parse. Never fails: a save takes the dialect of the
 * file it replaces, whatever state that file is in.
 */
export function sniffDialect(text: string, hint?: { delimiter?: CsvDelimiter }): CsvDialect {
  // A lenient parse never answers null.
  return (analyse(text, hint, true) as { dialect: CsvDialect }).dialect;
}

export function parseCsv(text: string, hint?: { delimiter?: CsvDelimiter }): CsvParse {
  const result = analyse(text, hint, false);
  if (result === null) return { ok: false, error: 'unterminated quoted field' };
  return { ok: true, rows: result.rows, dialect: result.dialect };
}

function quoteField(field: string, separators: readonly string[]): string {
  const needs =
    separators.some((d) => field.includes(d)) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r');
  return needs ? '"' + field.replace(/"/g, '""') + '"' : field;
}

export function serializeCsv(rows: string[][], dialect: CsvDialect): string {
  const bom = dialect.bom ? BOM : '';
  const blank = dialect.eol.repeat(dialect.trailingBlankLines);
  if (rows.length === 0) return bom + blank;
  // A trailing one-field empty record written bare is an empty line, which
  // `parseCsv` would read back as a trailing blank line and drop. Quoted, it
  // stays a record. In the middle a bare empty line reads back as a record.
  const isLoneEmpty = (row: string[]) => row.length === 1 && row[0] === '';
  let firstTrailingEmpty = rows.length;
  while (firstTrailingEmpty > 0 && isLoneEmpty(rows[firstTrailingEmpty - 1])) firstTrailingEmpty--;
  // One column has no delimiter in it for the re-read to sniff, so the file
  // comes back as `,`: a bare `Moscow, RU` would split into two columns. Quote
  // every candidate delimiter, and the re-read stays one column whatever it sniffs.
  const separators = rows[0].length === 1 ? CANDIDATES : [dialect.delimiter];
  const body = rows
    .map((row, r) =>
      r >= firstTrailingEmpty
        ? '""'
        : row.map((f) => quoteField(f, separators)).join(dialect.delimiter)
    )
    .join(dialect.eol);
  return bom + body + (dialect.trailingNewline ? dialect.eol : '') + blank;
}
