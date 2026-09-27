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
