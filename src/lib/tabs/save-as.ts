import type { TabClaim } from '../tauri/commands';

export type SaveAsBlockReason = 'held' | 'tab-gone' | 'unavailable';

export type SaveAsStep =
  /** `path`: where to write — the claimed spelling of the path the human picked. */
  | { kind: 'write'; path: string }
  | { kind: 'blocked'; reason: SaveAsBlockReason; focusOtherWindow: boolean };

/**
 * What Save As does once it has asked Rust to point the tab at the new path.
 *
 * Only a claim lets it write. A file another tab holds would otherwise be
 * open in two editors autosaving over each other, while the registry and the
 * watcher went on following the old file. `null` is a claim that could not be
 * asked for at all. The tab adopts the path as Rust registered it: agents
 * name the file by that spelling, and tabs are found by path.
 */
export function decideSaveAs(claim: TabClaim | null, requested: string): SaveAsStep {
  if (claim === null) return { kind: 'blocked', reason: 'unavailable', focusOtherWindow: false };
  switch (claim.kind) {
    case 'claimed':
      return { kind: 'write', path: claim.path ?? requested };
    case 'this-window':
      return { kind: 'blocked', reason: 'held', focusOtherWindow: false };
    case 'other-window':
      return { kind: 'blocked', reason: 'held', focusOtherWindow: true };
    case 'refused':
      return { kind: 'blocked', reason: 'unavailable', focusOtherWindow: false };
  }
}

/** The two paths of a Save As that moved a saved file (`stash_note_saved_as`). */
export interface SavedAsReport {
  oldPath: string;
  newPath: string;
}

/**
 * Whether to tell Rust that a Save As moved `oldPath` to `newPath` — which
 * takes a stash note out of the stash (roadmap A14). Only once the tab is on
 * the new path with nothing unsaved: the new file must hold exactly what the
 * note held, or Rust leaves the note where it is. Whether `oldPath` was a
 * note at all is Rust's to decide, from the database: the window's stash
 * marks are a display cache, and a mark not yet loaded would skip a real note.
 */
export function savedAsReport(
  oldPath: string | null,
  newPath: string,
  now: { path: string | null; dirty: boolean }
): SavedAsReport | null {
  if (oldPath === null || oldPath === newPath) return null;
  if (now.path !== newPath || now.dirty) return null;
  return { oldPath, newPath };
}
