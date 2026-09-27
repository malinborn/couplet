/**
 * The trash view's pure rules (stash stage 06, mockup `renderTrash`): days
 * left, the order, the filter. What a key does there lives with the other
 * stash keys (`stash-state.ts`); no DOM, no IPC here.
 */
import { indexText } from '../tabs/drawer-filter';
import { matchStash, parseStashQuery } from './stash-query';
import { calendarDaysAgo, entryTitle } from './stash-view';
import type { StashEntry } from './types';

/** Mirrors `stash::trash::TRASH_RETENTION_DAYS`; `trash-view.test.ts` reads the Rust file. */
export const TRASH_DAYS = 30;

/**
 * «удалится через N дн.» (mockup `daysLeft`): the retention minus the calendar
 * days since the deletion, never below 1 — the purge runs once a day, so an
 * overdue note is still there until it does.
 */
export function trashDaysLeft(deletedAt: number, now: number): number {
  return Math.max(1, TRASH_DAYS - calendarDaysAgo(deletedAt, now));
}

/** Newest deletion first (mockup), whatever the stash's own sort is. */
export function sortTrash(entries: readonly StashEntry[]): StashEntry[] {
  return [...entries].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

/**
 * Trashed notes are not in the search index (roadmap A8), so the trash filters
 * here, with the stash's own rule (`matchStash`: `#tag` by prefix over tags and
 * the repo, text over the title and the preview). The repo chip does not
 * apply (D13). The order is kept: the list is sorted before it is filtered.
 * Only the preview's ~400 characters are searched, not the whole note.
 */
export function filterTrash(entries: readonly StashEntry[], query: string, untitled: string): StashEntry[] {
  const q = parseStashQuery(query);
  if (q.tags.length === 0 && !q.text) return [...entries];
  return entries.filter(
    (e) =>
      matchStash(
        { title: entryTitle(e, untitled), repo: e.repo, tags: e.tags, index: q.text ? indexText(e.preview) : null },
        q
      ) !== null
  );
}
