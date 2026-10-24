import { invoke } from '@tauri-apps/api/core';
import type { LinkCandidates, LinkProject, Modifiers, PathKind } from './types';

export { PATH_KINDS_MAX } from './types';

/** What each path is, in order. Rejects when the IPC fails. */
export function pathKinds(paths: readonly string[]): Promise<PathKind[]> {
  return invoke<PathKind[]>('path_kinds', { paths });
}

/** Select `path` in a Finder window. Rejects with Rust's reason (no such file…). */
export function revealInFinder(path: string): Promise<void> {
  return invoke<void>('reveal_in_finder', { path });
}

/** Picker candidates for the document at `docPath` (`null`: untitled). Rejects when the IPC fails. */
export function linkCandidates(docPath: string | null): Promise<LinkCandidates> {
  return invoke<LinkCandidates>('link_candidates', { docPath });
}

/** The project root and normalized document path a new link is relative to. */
export function linkProject(docPath: string | null): Promise<LinkProject> {
  return invoke<LinkProject>('link_project', { docPath });
}

/** The modifier keys held right now — asked at a Finder drop, which brings no key events. */
export function currentModifiers(): Promise<Modifiers> {
  return invoke<Modifiers>('current_modifiers');
}
