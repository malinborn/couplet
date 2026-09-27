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
  let seq = 0;

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
    marks = { ...marks, [path]: markOf(entry) };
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
    /** Ask again (on `stash-changed`); resolves once every answer landed or was dropped. */
    refresh(paths: readonly string[]): Promise<void> {
      return Promise.all(paths.map(fetchOne)).then(() => {});
    },
    /** An entry this window just made (a note birth): known at once, over any answer in flight. */
    learn(entry: StashEntry): void {
      asked.set(entry.path, ++seq);
      marks = { ...marks, [entry.path]: markOf(entry) };
    },
  };
}

export type StashMarks = ReturnType<typeof createStashMarks>;
