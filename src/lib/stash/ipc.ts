import { invoke } from '@tauri-apps/api/core';
import type { PutAwayResult, StashEntry, StashKind, WindowProject } from './types';

/**
 * Typed wrappers over the stash commands (roadmap «Tauri commands»), one per
 * command Rust registers today. Arguments cross flat and camelCased — Tauri
 * maps `top_line` to `topLine`. Paths cross as the normalized string.
 */

export interface StashListQuery {
  repo?: string;
  tag?: string;
  kind?: StashKind;
  sort?: 'changed' | 'opened' | 'kind';
  deleted?: boolean;
  /** Only entries with `COALESCE(stashedAt, modifiedAt) >= since` (roadmap A9). */
  since?: number;
  limit?: number;
  /** Opaque: the previous page's `nextCursor`, valid only for the same sort / trash mode. */
  cursor?: string;
}

export interface StashListPage {
  entries: StashEntry[];
  total: number;
  nextCursor: string | null;
}

export interface StashCounts {
  total: number;
  stashedToday: number;
  deleted: number;
}

export function stashCreateNote(text: string, repo: string | null): Promise<StashEntry> {
  return invoke<StashEntry>('stash_create_note', { text, repo });
}

/** `caret` / `topLine` only with exactly one path — Rust refuses them otherwise. */
export function stashPutAway(
  paths: string[],
  opts: { caret?: number; topLine?: number; tags?: string[] } = {}
): Promise<PutAwayResult[]> {
  return invoke<PutAwayResult[]>('stash_put_away', { paths, ...opts });
}

export function stashList(query: StashListQuery = {}): Promise<StashListPage> {
  return invoke<StashListPage>('stash_list', { ...query });
}

export function stashGet(id: string): Promise<StashEntry> {
  return invoke<StashEntry>('stash_get', { id });
}

export function stashTag(id: string, add: string[] = [], remove: string[] = []): Promise<StashEntry> {
  return invoke<StashEntry>('stash_tag', { id, add, remove });
}

export function stashTouchOpened(path: string): Promise<void> {
  return invoke<void>('stash_touch_opened', { path });
}

export function stashCounts(repo?: string): Promise<StashCounts> {
  return invoke<StashCounts>('stash_counts', repo === undefined ? {} : { repo });
}

/** The entry of a tab's file, trashed or not (`deletedAt` set); `null` when it is not in the stash. */
export function stashEntryForPath(path: string): Promise<StashEntry | null> {
  return invoke<StashEntry | null>('stash_entry_for_path', { path });
}

/** The calling window's project; its `repo` is a new note's `repo` (roadmap A3). */
export function windowProject(): Promise<WindowProject> {
  return invoke<WindowProject>('window_project');
}
