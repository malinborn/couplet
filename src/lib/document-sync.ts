/**
 * Pure bookkeeping for keeping one window's buffer and its file in step —
 * the decisions `App.svelte` makes around open, save and external reload,
 * pulled out so they can be tested without a window.
 *
 * Nothing here does I/O. Each function answers one question from the state
 * the caller already has.
 */

import type { ExternalChangeDecision } from './external-change';
import type { LineEnding } from './line-endings';

export interface SaveGate {
  isDirty: boolean;
  filePath: string | null;
  /** The external-change conflict dialog is up. */
  conflictDialogOpen: boolean;
  /**
   * The last read of the file failed while it still existed — half-written by
   * a non-atomic writer, not valid UTF-8, unreadable permissions.
   */
  diskUnreadable: boolean;
}

/**
 * May an automatic save (the debounce timer, window blur) write the buffer
 * now?
 *
 * Two states block it, for the same reason: the disk holds something the
 * window has not seen. With the conflict dialog up, the dialog's own "Yes"
 * needs that state to still be there. With the file unreadable, the version on
 * disk is exactly the one the user would lose — the watcher's leading-edge
 * debounce can drop the follow-up event that would have produced a conflict
 * dialog, so the next keystroke would otherwise overwrite it silently.
 *
 * An explicit ⌘S is not gated: it is the user choosing their version.
 */
export function canAutoSave(gate: SaveGate): boolean {
  return gate.isDirty && gate.filePath !== null && !gate.conflictDialogOpen && !gate.diskUnreadable;
}

/**
 * The line ending the document should use after an external-change event,
 * given the decision `resolveExternalChange` reached.
 *
 * - `adopt` / `reload`: the buffer now matches disk, so it takes disk's ending.
 * - `ignore` because disk still reads the baseline: the text did not change,
 *   but its line endings may have (an external CRLF -> LF conversion). Follow
 *   them, or the next save converts the file back. Our own save's echo carries
 *   our own ending, so this changes nothing for it.
 * - `ignore` because the user already declined this disk state, and
 *   `conflict`: the buffer is not disk's, so it keeps its own ending. (The
 *   conflict dialog's "Yes" re-reads and goes through `reload` semantics.)
 */
export function lineEndingAfterExternalChange(input: {
  decision: ExternalChangeDecision;
  /** Normalized disk text. */
  disk: string;
  baseline: string | null;
  diskLineEnding: LineEnding;
  current: LineEnding;
}): LineEnding {
  const { decision, disk, baseline, diskLineEnding, current } = input;
  switch (decision) {
    case 'adopt':
    case 'reload':
      return diskLineEnding;
    case 'ignore':
      return disk === baseline ? diskLineEnding : current;
    case 'conflict':
      return current;
  }
}

/**
 * After a failed open: should this window give back the `OpenFiles` entry Rust
 * made for `path` on its behalf?
 *
 * Only when the window holds no file. A window created for a CLI path is
 * registered as that path's owner before the frontend reads a byte; if the
 * read fails, the window stays Untitled, and a stale entry would make every
 * later open of the path focus it instead of trying again. A window that
 * already shows a document keeps it — Rust never registered the failed path
 * for it (that happens only after a successful open).
 */
export function shouldReleaseUnopenedPath(currentFilePath: string | null): boolean {
  return currentFilePath === null;
}

/**
 * Delay before retry `attempt` (0-based) of reading a file that could not be
 * read. Starts just past the watcher's 500ms debounce, so a non-atomic writer
 * that was caught mid-write has finished; backs off to a 5s ceiling, because
 * while the file stays unreadable autosave stays paused and the only way the
 * window finds out it recovered — short of another FSEvent — is to look.
 */
export function reloadRetryDelay(attempt: number): number {
  return Math.min(700 * 2 ** Math.max(0, attempt), 5000);
}
