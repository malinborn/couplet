/**
 * Decides what to do about an FSEvent for the file this window has open.
 *
 * A watcher fires on every write to the path, including the app's own
 * autosave — there is no OS-level way to tell "someone else touched this"
 * from "we just touched this". Content comparison stands in for that: if
 * disk still reads what we last saw there, nothing external happened at all.
 */

export type ExternalChangeDecision = 'ignore' | 'adopt' | 'reload' | 'conflict';

export interface ExternalChangeInput {
  /** Current content of the file on disk (just read). */
  disk: string;
  /** Current editor buffer content. */
  buffer: string;
  /** Disk baseline: content as we last read it from or wrote it to disk; null if never. */
  baseline: string | null;
  /** Disk content the user already declined to reload once; null if none. */
  dismissedDisk: string | null;
}

export function resolveExternalChange(input: ExternalChangeInput): ExternalChangeDecision {
  const { disk, buffer, baseline, dismissedDisk } = input;

  // Disk matches what we ourselves last put there (or read from there) — this
  // event is an echo of our own write, or the file didn't actually change.
  if (disk === baseline) return 'ignore';

  // Disk already reads what the user sees — nothing to reload, just resync
  // the baseline. Checked before `dismissedDisk`: a stale "No" must not block
  // a resync that touches nothing the user can see.
  if (disk === buffer) return 'adopt';

  // The user already declined to reload this exact disk state once; a
  // repeated event for the same bytes (debounce, coalesced writes) must not
  // ask again.
  if (disk === dismissedDisk) return 'ignore';

  // Buffer never diverged from the last known disk state — nothing of the
  // user's to lose, so reload silently.
  if (buffer === (baseline ?? '')) return 'reload';

  return 'conflict';
}
