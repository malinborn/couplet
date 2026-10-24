/** What a path is on disk — `PathKind` in `src-tauri/src/links.rs`. */
export type PathKind = 'file' | 'dir' | 'missing' | 'other';

/**
 * `MAX_PATH_KINDS` in `src-tauri/src/links.rs`: a larger batch is refused.
 * Lives here, not in `ipc.ts`, so the editor code that batches by it never
 * imports `@tauri-apps/api` (the landing bundles that editor code).
 */
export const PATH_KINDS_MAX = 256;
