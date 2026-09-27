import { invoke } from '@tauri-apps/api/core';
import type {
  DeleteOutcome,
  PullAnswer,
  PutAwayResult,
  StashEntry,
  StashHit,
  StashKind,
  TabHolder,
  WindowProject,
} from './types';

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

/** `stash_search`'s arguments (stash stage 05). */
export interface StashSearchArgs {
  /** Words, `"phrases"` and `#tags` (exact stored tags, unlike the drawer's own prefix rule). */
  query: string;
  repo?: string;
  tag?: string;
  kind?: StashKind;
  /** Search the trash («Удалённые», title only) instead of the stash (roadmap A8). */
  deleted?: boolean;
  /** Rust caps it at 200. */
  limit?: number;
  /** Opaque: the previous page's `nextCursor`, for the same query and filters. */
  cursor?: string;
}

export interface StashSearchResult {
  /** Relevance order. */
  hits: StashHit[];
  /** Matching entries across all pages. */
  total: number;
  nextCursor: string | null;
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

// --- stash stage 04: the drawer ---

/** «убрать из тайника»: a file reference goes, the file stays. A note is refused until stage 06's trash. */
export function stashDelete(id: string): Promise<DeleteOutcome> {
  return invoke<DeleteOutcome>('stash_delete', { id });
}

/** Per path, the other window holding it («открыта в #N»); `null` for nobody or this window. */
export function tabHolders(paths: string[]): Promise<(TabHolder | null)[]> {
  return invoke<(TabHolder | null)[]>('tab_holders', { paths });
}

/** Open an entry here: our own tab is activated, another window's is asked to move here (`tab-pull`). */
export function requestTabMove(path: string): Promise<PullAnswer> {
  return invoke<PullAnswer>('tab_request_move', { path });
}

// --- stash stage 05: search ---

export function stashSearch(args: StashSearchArgs): Promise<StashSearchResult> {
  return invoke<StashSearchResult>('stash_search', { ...args });
}

/** `stash_list`'s own page maximum (`MAX_LIMIT`, `entries.rs`). */
export const LIST_PAGE = 500;
/** 20 000 entries: a cursor that never ends must not spin forever. */
export const LIST_MAX_PAGES = 40;

/**
 * The whole live stash — the drawer filters and sorts on the client. Every page
 * keeps the default sort: a cursor is mode-prefixed (roadmap A9) and valid only
 * for the sort that issued it.
 */
export async function listAllEntries(
  page: (query: StashListQuery) => Promise<StashListPage> = stashList
): Promise<StashEntry[]> {
  const out: StashEntry[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < LIST_MAX_PAGES; i++) {
    const query: StashListQuery = { limit: LIST_PAGE, deleted: false };
    if (cursor !== undefined) query.cursor = cursor;
    const res = await page(query);
    out.push(...res.entries);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}
