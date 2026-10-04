import { applyLineEnding, fromDisk, type DiskDocument, type LineEnding } from '../line-endings';
import { previewKindFor, type PreviewKind } from '../editor/file-language';
import { parseCsv, serializeCsv, sniffDialect, type CsvDelimiter, type CsvDialect } from './csv';
import { rowsToTable, tableToRows } from './csv-table';

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

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isCsvPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const ext = extOf(path);
  return ext === 'csv' || ext === 'tsv';
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

/** Disk bytes → buffer. CSV path: the table if it parses, else the text as any file. */
export function decodeFromDisk(path: string, raw: string, fallback: LineEnding): DiskDocument {
  if (!isCsvPath(path)) return fromDisk(raw, fallback);
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
 * path whose file did not parse is shown as `'code'`, plain text.
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
