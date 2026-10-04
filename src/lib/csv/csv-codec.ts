import { applyLineEnding, fromDisk, type DiskDocument, type LineEnding } from '../line-endings';
import { parseCsv, serializeCsv, type CsvDialect } from './csv';
import { rowsToTable, tableToRows } from './csv-table';

/**
 * CSV at the disk boundary. A CSV document's buffer is a GFM table; this is
 * the only place that knows the file on disk is CSV.
 *
 * Per-path state: the dialect the file was read in, or `'raw'` when it did not
 * parse — such a file is shown and saved as plain text. A path with no entry
 * (a new file) is a CSV document with the extension's default dialect.
 */
const state = new Map<string, CsvDialect | 'raw'>();

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

/** Is this path edited as a table (as opposed to a CSV that failed to parse)? */
export function isCsvDocument(path: string | null | undefined): boolean {
  return isCsvPath(path) && state.get(path as string) !== 'raw';
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

function parseFor(path: string, raw: string) {
  return parseCsv(raw, extOf(path) === 'tsv' ? { delimiter: '\t' } : undefined);
}

export function decodeFromDisk(path: string, raw: string, fallback: LineEnding): DiskDocument {
  if (!isCsvPath(path)) return fromDisk(raw, fallback);
  const parsed = parseFor(path, raw);
  if (!parsed.ok) {
    state.set(path, 'raw');
    return fromDisk(raw, fallback);
  }
  state.set(path, parsed.dialect);
  // CSV owns its line endings (the dialect); the buffer is LF table text.
  return { text: rowsToTable(parsed.rows), lineEnding: 'lf' };
}

export function encodeForDisk(path: string, text: string, lineEnding: LineEnding): string {
  if (!isCsvDocument(path)) return applyLineEnding(text, lineEnding);
  const table = tableToRows(text);
  if (!table.ok) throw new Error(`Cannot save as CSV: ${table.error}`);
  const entry = state.get(path);
  const dialect = entry && entry !== 'raw' ? entry : defaultDialect(path);
  return serializeCsv(table.rows, dialect);
}

/**
 * What the next read of `path` returns after `text` is saved to it — the
 * value a save must store as the disk baseline. A cell commit leaves the
 * table unpadded, the file comes back canonical, and with the buffer as the
 * baseline our own save's echo would read as an external change.
 */
export function codecRoundTrip(path: string | null, text: string): string {
  if (!path || !isCsvDocument(path)) return text;
  let written: string;
  try {
    written = encodeForDisk(path, text, 'lf');
  } catch {
    return text;
  }
  const parsed = parseFor(path, written);
  return parsed.ok ? rowsToTable(parsed.rows) : text;
}

/** TEST-ONLY: forget every path's state. Never call from app code. */
export function resetCsvCodec(): void {
  state.clear();
}
