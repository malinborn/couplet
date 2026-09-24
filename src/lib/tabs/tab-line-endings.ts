import type { DiskDocument, LineEnding } from '../line-endings';

/**
 * The line ending each file uses on disk, for the tabs that are not active.
 *
 * The buffer is always LF (see `line-endings.ts`); this is what a CRLF file is
 * converted back to, so it stays CRLF whether it is saved from the live view
 * or written from the background by an agent's edit. The active tab's ending
 * is `fileState.lineEnding` — an external change or Save As can move it while
 * the tab is shown — and `handOver` writes it back when the tab is left.
 *
 * Every read the controller makes is of a clean tab (a background one, or one
 * about to be shown), so `record` simply takes the disk's ending: a change
 * that only touched the endings is followed, as the active tab follows it.
 */
export function createTabLineEndings() {
  const known = new Map<string, LineEnding>();

  function of(path: string | null): LineEnding {
    return (path !== null ? known.get(path) : undefined) ?? 'lf';
  }

  return {
    /** The ending to write `path` with; LF for a file never read, and for untitled. */
    of,
    /** A read of `path` landed: remember its ending, hand back the editor text. */
    record(path: string, doc: DiskDocument): string {
      known.set(path, doc.lineEnding);
      return doc.text;
    },
    /**
     * The window shows `arriving` instead of `leaving`: keep what the leaving
     * document's ending became while it was shown, and answer the arriving
     * one's. The same path is not written back — it was just read again.
     */
    handOver(leaving: { path: string | null; lineEnding: LineEnding }, arriving: string | null): LineEnding {
      if (leaving.path !== null && leaving.path !== arriving) known.set(leaving.path, leaving.lineEnding);
      return of(arriving);
    },
  };
}
