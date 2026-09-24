/**
 * The decision half of `switchDocument` in `App.svelte`: given what the window
 * shows now and what it was asked to open, what may happen to the buffer.
 *
 * Pure on purpose. Every rule here exists because some path used to discard
 * work silently, and each of those is a one-line case in a unit test instead
 * of a scenario that needs a running app to reproduce.
 */

export type SwitchAction =
  | { kind: 'noop-already-showing' }
  | { kind: 'refuse-save-error' }
  | { kind: 'refuse-unsaved' }
  | { kind: 'focus-other-window' }
  | { kind: 'open-new-window' }
  | { kind: 'switch-in-place' };

export interface SwitchDecisionInput {
  /** The file `switchDocument` was asked to open. */
  targetPath: string;
  /** What this window currently shows, or `null` for an Untitled buffer. */
  currentPath: string | null;
  /** Whether the current buffer has unsaved changes — sampled AFTER the
   * autosave flush, so for a buffer with a path `true` means the save did
   * not happen (conflict dialog open, write failed, …). */
  currentIsDirty: boolean;
  /** A save of the current document is known to have failed and has not
   * succeeded since — see `toasts.hasKind('save-error')`. */
  saveErrorPending: boolean;
  /** `focus_if_open` already found (and focused) another window showing
   * `targetPath`. */
  alreadyOpenElsewhere: boolean;
}

/**
 * Order matters:
 *
 * 1. Asking for the file already on screen changes nothing, whatever else is
 *    true — not even a standing save error is a reason to say no to it.
 * 2. A failed save refuses everything else, including focusing another
 *    window: the user has to see that this document is not on disk, and a
 *    window that jumps away from the error toast hides exactly that.
 * 3. A file already open elsewhere is focused there. That loses nothing here,
 *    so it wins over the dirty-buffer rules below.
 * 4. A file-backed buffer still dirty after the flush means the save did not
 *    land (a conflict dialog held it back, or the write failed without a
 *    toast yet). Replacing it would discard the only copy — refuse.
 * 5. A dirty Untitled buffer has nowhere to be saved to, so the target opens
 *    in a new window and the text stays where it is.
 * 6. Otherwise — a clean file, or an empty Untitled buffer — swap in place.
 */
export function decideSwitchAction(input: SwitchDecisionInput): SwitchAction {
  if (input.targetPath === input.currentPath) return { kind: 'noop-already-showing' };
  if (input.saveErrorPending) return { kind: 'refuse-save-error' };
  if (input.alreadyOpenElsewhere) return { kind: 'focus-other-window' };
  if (input.currentPath !== null && input.currentIsDirty) return { kind: 'refuse-unsaved' };
  if (input.currentPath === null && input.currentIsDirty) return { kind: 'open-new-window' };
  return { kind: 'switch-in-place' };
}
