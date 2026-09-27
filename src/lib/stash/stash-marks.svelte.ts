import type { StashEntry } from './types';
import { markOf, type StashMark } from './marks';

/**
 * Per window: which open documents are notes or stashed files, for the tab
 * cards and the window title. A cache over `stash_entry_for_path`, refreshed
 * on `stash-changed`; it decides nothing that writes (D13) — what closing a
 * tab means for the stash is decided in Rust from the database.
 */
export function createStashMarks(lookup: (path: string) => Promise<StashEntry | null>) {
  let marks = $state<Record<string, StashMark | null>>({});
  /** Path → the request whose answer may land; a later ask or `learn` supersedes it. */
  const asked = new Map<string, number>();
  /** Path → the id of its entry, for a `deleted` change (which names ids, not paths). */
  const ids = new Map<string, string>();
  let seq = 0;

  function remember(path: string, entry: StashEntry | null): void {
    if (entry) ids.set(path, entry.id);
    else ids.delete(path);
    marks = { ...marks, [path]: markOf(entry) };
  }

  async function fetchOne(path: string): Promise<void> {
    const mine = ++seq;
    asked.set(path, mine);
    let entry: StashEntry | null;
    try {
      entry = await lookup(path);
    } catch {
      // Unknown, not "not in the stash": asked again next time.
      if (asked.get(path) === mine) asked.delete(path);
      return;
    }
    if (asked.get(path) !== mine) return;
    remember(path, entry);
  }

  function refresh(paths: readonly string[]): Promise<void> {
    return Promise.all(paths.map(fetchOne)).then(() => {});
  }

  return {
    get(path: string | null): StashMark | null {
      return path === null ? null : (marks[path] ?? null);
    },
    /** Ask for every path not known or asked yet. */
    ensure(paths: readonly (string | null)[]): void {
      for (const p of new Set(paths)) {
        if (p !== null && !(p in marks) && !asked.has(p)) void fetchOne(p);
      }
    },
    /** Ask again; resolves once every answer landed or was dropped. */
    refresh,
    /**
     * `stash-changed`: every open path is asked again — one whose last lookup
     * failed included. Entries it reports `deleted` lose their mark at once,
     * over any answer in flight: a discarded note's row is gone.
     */
    changed(reason: string, changedIds: readonly string[] | undefined, openPaths: readonly string[]): Promise<void> {
      if (reason === 'deleted' && changedIds && changedIds.length > 0) {
        const gone = new Set(changedIds);
        for (const [path, id] of ids) {
          if (!gone.has(id)) continue;
          asked.set(path, ++seq);
          remember(path, null);
        }
      }
      return refresh(openPaths);
    },
    /** Forget every path not in `openPaths` (the tab list changed); a late answer for one is dropped. */
    retain(openPaths: readonly (string | null)[]): void {
      const open = new Set(openPaths);
      for (const path of asked.keys()) if (!open.has(path)) asked.delete(path);
      for (const path of ids.keys()) if (!open.has(path)) ids.delete(path);
      const stale = Object.keys(marks).filter((path) => !open.has(path));
      if (stale.length === 0) return;
      const kept = { ...marks };
      for (const path of stale) delete kept[path];
      marks = kept;
    },
    /** An entry this window just made (a note birth): known at once, over any answer in flight. */
    learn(entry: StashEntry): void {
      asked.set(entry.path, ++seq);
      remember(entry.path, entry);
    },
  };
}

export type StashMarks = ReturnType<typeof createStashMarks>;
