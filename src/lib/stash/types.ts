/**
 * The stash's shared types (roadmap «TypeScript types»). Rust mirrors them in
 * `src-tauri/src/stash/mod.rs` with `#[serde(rename_all = "camelCase")]`;
 * a field renamed on one side only arrives as `undefined`, silently.
 */

export type StashKind = 'note' | 'file';

export interface StashEntry {
  id: string;
  kind: StashKind;
  path: string;
  title: string | null; // null → localized «Без названия»
  repo: string | null; // a directory name, never a path (roadmap A3); files: git toplevel's name
  branch: string | null; // files only, from git_info
  tags: string[]; // without '#', repo tag NOT included (UI renders repo separately)
  createdAt: number;
  modifiedAt: number;
  stashedAt: number | null;
  openedAt: number | null;
  deletedAt: number | null;
  caret: number;
  topLine: number;
  preview: string; // first ~400 chars of text (notes and readable files)
}

export interface PutAwayResult {
  entry: StashEntry;
  created: boolean; // false: the path was already in the stash (dedup hit)
}

export interface StashHit {
  entry: StashEntry;
  snippet: string; // plain text around the match, ~200 chars
  ranges: [number, number][]; // match offsets inside snippet (UTF-16 code units, A9), for highlighting
  score: number;
}

/** `stash-changed`'s payload (roadmap A6). `ids` is absent when Rust does not know which entries changed. */
export interface StashChanged {
  reason: string;
  ids?: string[];
}

/** `window_project`'s answer (roadmap A3): the absolute root and its directory name — a new note's `repo`. */
export interface WindowProject {
  root: string | null;
  repo: string | null;
}

/** A card's tag edit (`stash_tag`'s `add` / `remove`, stash stage 04). */
export interface TagChange {
  add?: string[];
  remove?: string[];
}

/** `tab_holders` (stash stage 04): the other window holding an entry's file — «открыта в #N». */
export interface TabHolder {
  label: string;
  number: number | null;
}

/** `tab_request_move` (stash stage 04): what opening an entry from this window means. */
export type PullAnswer =
  | { kind: 'not-open' }
  | { kind: 'this-window'; tabId: string }
  | { kind: 'requested'; label: string; number: number | null };

/**
 * Why a note stayed in the stash (stage 06): its tab's save had not landed,
 * the window holding it did not answer in time, or it was opened again.
 */
export type KeptReason = 'unsaved' | 'timeout' | 'open';

/**
 * `stash_delete`'s answer (roadmap A7): a note went to the trash (`entry` is
 * the trashed row, its `path` inside `.trash/`), a file reference went (the
 * file stays), or a tab in window `label` still holds the note.
 */
export type DeleteOutcome =
  | { kind: 'trashed'; entry: StashEntry }
  | { kind: 'removed' }
  | { kind: 'kept'; reason: KeptReason; label: string; number: number | null };

/**
 * Which list the stash drawer shows (stage 06): the stash, or «Удалённые».
 * Not `StashView` — that is `stash-view.ts`'s row model.
 */
export type StashMode = 'stash' | 'trash';
