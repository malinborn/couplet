import type { CsvTableRefusal } from './csv-codec';

/** What the window does with its `csv-as-text` toast for the document just configured. */
export type CsvNoticeStep =
  | { do: 'tell'; refusal: CsvTableRefusal }
  /** The document it was about reads as a table again: take its toast down. */
  | { do: 'withdraw' }
  | { do: 'nothing' };

/**
 * When a window says why a CSV is on screen as plain text: once per open tab,
 * not on every switch back to it.
 *
 * A path is told about once and then remembered. It is forgotten when its tab
 * is no longer open (so reopening the file says it again) and when it reads
 * as a table again (so a later break of the same file is reported) — the
 * second case also withdraws the toast, which would otherwise go on claiming
 * a fixed file is text. Per window: tabs moved to another window are told
 * about again there.
 */
export function createCsvNotices() {
  const told = new Set<string>();
  return {
    /**
     * `refusal`: why the document `path` is plain text, `null` when it is not
     * (a table, or not a CSV at all). `openPaths`: the window's tabs now — the
     * one being configured may not be listed yet.
     */
    settle(
      path: string | null,
      refusal: CsvTableRefusal | null,
      openPaths: Iterable<string | null>
    ): CsvNoticeStep {
      const open = new Set(openPaths);
      for (const p of told) if (!open.has(p) && p !== path) told.delete(p);
      if (path === null) return { do: 'nothing' };
      if (refusal === null) return told.delete(path) ? { do: 'withdraw' } : { do: 'nothing' };
      if (told.has(path)) return { do: 'nothing' };
      told.add(path);
      return { do: 'tell', refusal };
    },
  };
}
