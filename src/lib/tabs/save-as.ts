import type { TabClaim } from '../tauri/commands';

export type SaveAsBlockReason = 'held' | 'tab-gone' | 'unavailable';

export type SaveAsStep =
  | { kind: 'write' }
  | { kind: 'blocked'; reason: SaveAsBlockReason; focusOtherWindow: boolean };

/**
 * What Save As does once it has asked Rust to point the tab at the new path.
 *
 * Only a claim lets it write. A file another tab holds would otherwise be
 * open in two editors autosaving over each other, while the registry and the
 * watcher went on following the old file. `null` is a claim that could not be
 * asked for at all.
 */
export function decideSaveAs(claim: TabClaim | null): SaveAsStep {
  if (claim === null) return { kind: 'blocked', reason: 'unavailable', focusOtherWindow: false };
  switch (claim.kind) {
    case 'claimed':
      return { kind: 'write' };
    case 'this-window':
      return { kind: 'blocked', reason: 'held', focusOtherWindow: false };
    case 'other-window':
      return { kind: 'blocked', reason: 'held', focusOtherWindow: true };
    case 'refused':
      return { kind: 'blocked', reason: 'unavailable', focusOtherWindow: false };
  }
}
