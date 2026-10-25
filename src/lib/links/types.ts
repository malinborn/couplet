/** What a path is on disk — `PathKind` in `src-tauri/src/links.rs`. */
export type PathKind = 'file' | 'dir' | 'missing' | 'other';

/**
 * `MAX_PATH_KINDS` in `src-tauri/src/links.rs`: a larger batch is refused.
 * Lives here, not in `ipc.ts`, so the editor code that batches by it never
 * imports `@tauri-apps/api` (the landing bundles that editor code).
 */
export const PATH_KINDS_MAX = 256;

/** A picker group, in display order — `LinkGroup` in `src-tauri/src/links.rs`. */
export type LinkGroup = 'tab' | 'project' | 'recent' | 'stash';

export interface LinkCandidate {
  path: string;
  group: LinkGroup;
  /** A stash note's title — its label. */
  title: string | null;
  /** `#N` of another window holding it as a tab; `null` here or not a tab. */
  window: number | null;
}

/** `link_candidates`' answer. */
export interface LinkCandidates {
  candidates: LinkCandidate[];
  /** The project walk hit a limit: not every project file is listed. */
  truncated: boolean;
  projectRoot: string | null;
  /** The document's path as Rust spells it (`path_norm`) — destinations are computed from it. */
  docPath: string | null;
}

/** `link_project`' answer: what a link written into a document is relative to. */
export interface LinkProject {
  projectRoot: string | null;
  docPath: string | null;
}

/** `Modifiers` in `src-tauri/src/reveal.rs`: the keys held at the moment of asking. */
export interface Modifiers {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}
