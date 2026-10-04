/**
 * RFC 4180 CSV, parsed to rows of strings and written back in the dialect it
 * was read in. Pure: no editor, no disk. The table side lives in
 * `csv-table.ts`, the disk side in `csv-codec.ts`.
 */

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvDialect {
  delimiter: CsvDelimiter;
  /** The file started with U+FEFF. */
  bom: boolean;
  /** Record separator, taken from the first line break in the file. */
  eol: '\n' | '\r\n';
  /** The file ended with a record separator. */
  trailingNewline: boolean;
}

export type CsvParse =
  | { ok: true; rows: string[][]; dialect: CsvDialect }
  | { ok: false; error: string };

const BOM = '\uFEFF';
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];
const SNIFF_CHARS = 65536;
const SNIFF_ROWS = 20;

/**
 * Split `text` into records. `lenient` returns what was read when the text
 * ends inside quotes (used for sniffing a truncated sample); otherwise that
 * is an error and the answer is `null`.
 */
function parseWith(text: string, delimiter: string, lenient: boolean): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
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
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  if (quoted && !lenient) return null;
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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
    const rows = (parseWith(sample, d, true) ?? []).slice(0, SNIFF_ROWS);
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

export function parseCsv(text: string, hint?: { delimiter?: CsvDelimiter }): CsvParse {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const delimiter = hint?.delimiter ?? sniffDelimiter(body);
  const rows = parseWith(body, delimiter, false);
  if (rows === null) return { ok: false, error: 'unterminated quoted field' };
  const lf = body.indexOf('\n');
  const eol = lf > 0 && body[lf - 1] === '\r' ? '\r\n' : '\n';
  const trailingNewline = body.endsWith('\n') || body.endsWith('\r');
  return { ok: true, rows, dialect: { delimiter, bom, eol, trailingNewline } };
}

function quoteField(field: string, delimiter: string): string {
  const needs =
    field.includes(delimiter) || field.includes('"') || field.includes('\n') || field.includes('\r');
  return needs ? '"' + field.replace(/"/g, '""') + '"' : field;
}

export function serializeCsv(rows: string[][], dialect: CsvDialect): string {
  if (rows.length === 0) return dialect.bom ? BOM : '';
  const body = rows
    .map((row) => row.map((f) => quoteField(f, dialect.delimiter)).join(dialect.delimiter))
    .join(dialect.eol);
  return (dialect.bom ? BOM : '') + body + (dialect.trailingNewline ? dialect.eol : '');
}
