import { invoke } from '@tauri-apps/api/core';
import type { PathKind } from './types';

export { PATH_KINDS_MAX } from './types';

/** What each path is, in order. Rejects when the IPC fails. */
export function pathKinds(paths: readonly string[]): Promise<PathKind[]> {
  return invoke<PathKind[]>('path_kinds', { paths });
}

/** Select `path` in a Finder window. Rejects with Rust's reason (no such file…). */
export function revealInFinder(path: string): Promise<void> {
  return invoke<void>('reveal_in_finder', { path });
}
