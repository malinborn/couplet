/**
 * The decisions behind the tab controller (`lib/tabs/controller.ts`): may the
 * active tab be left, and what does "open this path" do in a window with tabs.
 *
 * Pure on purpose. Every rule here exists because some path used to discard
 * work silently, and each of those is a one-line case in a unit test instead
 * of a scenario that needs a running app to reproduce.
 */

export type LeaveVerdict =
  | { kind: 'ok' }
  | { kind: 'refuse-save-error' }
  | { kind: 'refuse-unsaved' };

/**
 * The active tab as it stands AFTER the caller has flushed its autosave (with
 * the bounded retries). Sampling any earlier would turn a keystroke still
 * inside the 300 ms debounce into a refusal, and that is never a reason to
 * refuse.
 */
export interface LeaveDecisionInput {
  /** The active tab's file, or `null` for an untitled tab. */
  activePath: string | null;
  /** Sampled after the autosave flush: for a file tab, `true` means the save
   * did not land (a conflict dialog held it back, or the write failed). */
  activeIsDirty: boolean;
  /** A save is known to have failed and has not succeeded since — sampled
   * after the flush, so a flush that landed has already cleared it. */
  saveErrorPending: boolean;
}

/**
 * May the active tab go to the background (or be closed)?
 *
 * Refuses only when the save did not land after the flush: a standing save
 * error, or a file tab still dirty once the flush and its retries are done. A
 * cached state has no autosave, recovery snapshot or watcher, so it would be
 * the only copy of that text. A dirty untitled tab is fine: its text travels
 * with the tab and into its session sidecar.
 */
export function decideLeave(input: LeaveDecisionInput): LeaveVerdict {
  if (input.saveErrorPending) return { kind: 'refuse-save-error' };
  if (input.activePath !== null && input.activeIsDirty) return { kind: 'refuse-unsaved' };
  return { kind: 'ok' };
}

/** Who holds a path, as far as this window can tell. */
export type TabOwner =
  | { kind: 'none' }
  | { kind: 'this-window'; tabId: string }
  | { kind: 'other-window'; label?: string };

export type OpenAction =
  | { kind: 'noop' }
  | { kind: 'refuse-save-error' }
  | { kind: 'refuse-unsaved' }
  | { kind: 'focus-other-window' }
  | { kind: 'activate-tab'; tabId: string }
  | { kind: 'replace-active' }
  | { kind: 'open-new-tab' };

/** The active-tab fields are sampled AFTER the autosave flush, as in `LeaveDecisionInput`. */
export interface OpenDecisionInput {
  targetPath: string;
  activeTabId: string | null;
  activePath: string | null;
  /** Sampled after the autosave flush — see `LeaveDecisionInput`. */
  activeIsDirty: boolean;
  /** Untitled, no text, never typed into — the blank tab a new window opens with. */
  activeIsEmptyUntitled: boolean;
  /** Sampled after the autosave flush — see `LeaveDecisionInput`. */
  saveErrorPending: boolean;
  owner: TabOwner;
}

/**
 * What "open `targetPath`" does in a window with tabs. The caller flushes the
 * active tab's autosave first, so a refusal means that save did not land.
 * Order matters:
 *
 * 1. The file already on screen: nothing to do, whatever else is true.
 * 2. A standing save error refuses everything else, focusing another window
 *    included — the user has to see that this document is not on disk.
 * 3. Held by another window: focus it there. Nothing here is left, so an
 *    unsaved active tab is no obstacle.
 * 4. Anything else leaves the active tab, so it must be allowed to leave.
 * 5. Held by a background tab here: activate it.
 * 6. The active tab is a blank untitled one: the file takes its place.
 * 7. Otherwise a new tab, right after the active one.
 */
export function decideOpenAction(input: OpenDecisionInput): OpenAction {
  const { owner } = input;
  if (owner.kind === 'this-window' && owner.tabId === input.activeTabId) return { kind: 'noop' };
  if (input.saveErrorPending) return { kind: 'refuse-save-error' };
  if (owner.kind === 'other-window') return { kind: 'focus-other-window' };
  const leave = decideLeave(input);
  if (leave.kind !== 'ok') return leave;
  if (owner.kind === 'this-window') return { kind: 'activate-tab', tabId: owner.tabId };
  if (input.activeIsEmptyUntitled) return { kind: 'replace-active' };
  return { kind: 'open-new-tab' };
}
