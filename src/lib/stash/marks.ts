import type { StashEntry, StashKind } from './types';

/** What a tab needs to know about its document's stash entry — for display only (D13). */
export interface StashMark {
  kind: StashKind;
  title: string | null;
  repo: string | null;
}

/** A trashed entry marks nothing: the document is not in the stash any more. */
export function markOf(entry: StashEntry | null): StashMark | null {
  if (!entry || entry.deletedAt !== null) return null;
  return { kind: entry.kind, title: entry.title, repo: entry.repo };
}
