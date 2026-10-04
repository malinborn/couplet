import { applyLineEnding, fromDisk, type DiskDocument, type LineEnding } from '../line-endings';
import { previewKindFor, type PreviewKind } from '../editor/file-language';
import {
  countCsvRecords,
  parseCsv,
  serializeCsv,
  sniffDialect,
  type CsvDelimiter,
  type CsvDialect,
} from './csv';
import { rowsToTable, tableToRows } from './csv-table';
import { extOf, isCsvPath } from './csv-path';

/**
 * CSV at the disk boundary. A CSV document's buffer is a GFM table; this is
 * the only place that knows the file on disk is CSV.
 *
 * Stateless on purpose (spec §3, "No state"). A per-path memory of the dialect
 * or of a failed parse was found to corrupt files: any read — a drawer
 * preview, an agent, an external-change check — rewrote it, and two spellings
 * of one path split the read from the write. So what to write is decided by
 * the buffer (exactly one table → CSV, anything else as is), and the dialect
 * by the file being replaced, read at the same path just before the write.
 */

/**
 * Will `encodeForDisk` write this buffer as CSV? A CSV path whose buffer is
 * exactly one table — the same rule `encodeForDisk` applies. Anything else is
 * written as is, and that write's baseline is the buffer itself (see
 * `writeDocument`).
 */
export function isTableBuffer(path: string, text: string): boolean {
  return isCsvPath(path) && tableToRows(text).ok;
}

/** A `.tsv` is tab-separated by name; a `.csv` has its delimiter sniffed. */
function hintFor(path: string): { delimiter: CsvDelimiter } | undefined {
  return extOf(path) === 'tsv' ? { delimiter: '\t' } : undefined;
}

function defaultDialect(path: string): CsvDialect {
  return {
    delimiter: extOf(path) === 'tsv' ? '\t' : ',',
    bom: false,
    eol: '\n',
    trailingNewline: true,
    trailingBlankLines: 0,
  };
}

/**
 * The most data rows (header excluded) a CSV opens as a table with. A larger
 * file opens as plain text, exactly like one that does not parse: the table
 * widget has no row virtualization yet, and at 100k rows its ~1.6M DOM nodes
 * plus CM6 re-measuring the hidden table lines hung the whole window. At
 * exactly this many data rows it is still a table.
 */
export const CSV_TABLE_MAX_ROWS = 20_000;

/** Why a CSV file opens as plain text rather than a table. */
export type CsvTableRefusal = { reason: 'unparseable' } | { reason: 'too-large'; rows: number };

/**
 * Why CSV text would open as plain text, or `null` when it opens as a table.
 * Counts records without building them (`countCsvRecords`, the parser's own
 * machine), so a huge file costs one scan, not a parse plus a table. The
 * answer is the same for the disk bytes and for the LF buffer decoded from
 * them: line-ending normalization changes neither the quotes nor the number
 * of record separators.
 */
function refusalOf(path: string, text: string): CsvTableRefusal | null {
  const records = countCsvRecords(text, hintFor(path));
  if (records === null) return { reason: 'unparseable' };
  const rows = Math.max(0, records - 1);
  return rows > CSV_TABLE_MAX_ROWS ? { reason: 'too-large', rows } : null;
}

/**
 * Why the buffer of a CSV document is plain text and not a table — for
 * telling the human. `null` for a non-CSV path, for a table buffer, and for a
 * plain-text buffer that would read as a table now (edited since it was
 * opened: it becomes one on the next read, nothing to explain).
 */
export function csvTableRefusal(path: string | null, text: string): CsvTableRefusal | null {
  if (path === null || !isCsvPath(path) || tableToRows(text).ok) return null;
  return refusalOf(path, text);
}

/**
 * Disk bytes → buffer. CSV path: the table if it parses and has at most
 * `CSV_TABLE_MAX_ROWS` data rows, else the text as any file.
 */
export function decodeFromDisk(path: string, raw: string, fallback: LineEnding): DiskDocument {
  if (!isCsvPath(path)) return fromDisk(raw, fallback);
  // Sized before parsing: a file over the cap never has its rows built.
  if (refusalOf(path, raw) !== null) return fromDisk(raw, fallback);
  const parsed = parseCsv(raw, hintFor(path));
  if (!parsed.ok) return fromDisk(raw, fallback);
  // CSV owns its line endings (the dialect); the buffer is LF table text.
  return { text: rowsToTable(parsed.rows), lineEnding: 'lf' };
}

/**
 * Buffer → bytes. CSV path + a buffer that is exactly one table → CSV in the
 * dialect sniffed from `current` (the file being replaced), or the extension's
 * default when `current` is null. Any other buffer → `applyLineEnding`, as for
 * any file.
 */
export function encodeForDisk(
  path: string,
  text: string,
  lineEnding: LineEnding,
  current: string | null
): string {
  if (!isCsvPath(path)) return applyLineEnding(text, lineEnding);
  const table = tableToRows(text);
  if (!table.ok) return applyLineEnding(text, lineEnding);
  const dialect = current === null ? defaultDialect(path) : sniffDialect(current, hintFor(path));
  return serializeCsv(table.rows, dialect);
}

/**
 * The kind a document gets: `'csv'` only when the buffer is one table — a CSV
 * path whose file did not parse, or has more than `CSV_TABLE_MAX_ROWS` data
 * rows, is shown as `'code'`, plain text (`csvTableRefusal` says which).
 */
export function documentPreviewKind(path: string | null, text: string): PreviewKind {
  const kind = previewKindFor(path);
  if (kind !== 'csv') return kind;
  return tableToRows(text).ok ? 'csv' : 'code';
}

/**
 * The buffer of a path that does not exist yet: for a CSV path the empty
 * one-column table (editable as a table, saves as an empty file until
 * something is typed), for anything else empty text.
 */
export function newFileText(path: string): string {
  return isCsvPath(path) ? rowsToTable([]) : '';
}
