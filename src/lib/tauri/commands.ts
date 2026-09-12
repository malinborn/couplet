import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { ThemeSetting } from '../theme-resolve';
import type { EditorEngine } from '../stores.svelte';
import type { CommentThread } from '../comment-format';

export async function readFile(path: string): Promise<string> {
  return invoke<string>('read_file', { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke('write_file', { path, content });
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>('file_exists', { path });
}

/** Sets the Theme menu checkmarks; harmless no-op outside Tauri (browser dev). */
export function syncThemeMenu(preference: ThemeSetting): void {
  invoke('sync_theme_menu', { preference }).catch(() => {});
}

/** Sets the Editor Engine submenu checkmarks; harmless no-op outside Tauri. */
export function syncEngineMenu(engine: EditorEngine): void {
  invoke('sync_engine_menu', { engine }).catch(() => {});
}

/** Sets the "Include Live Render in Cmd+E" checkbox; harmless no-op outside Tauri. */
export function syncBetaInCycleMenu(enabled: boolean): void {
  invoke('sync_beta_in_cycle_menu', { enabled }).catch(() => {});
}

const FILE_FILTERS = [
  { name: 'All Supported', extensions: ['md', 'markdown', 'txt', 'csv', 'json', 'yml', 'yaml', 'toml', 'py', 'rs', 'ts', 'js', 'sh', 'env'] },
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
  { name: 'Data', extensions: ['csv', 'json', 'yml', 'yaml', 'toml'] },
  { name: 'Code', extensions: ['py', 'rs', 'ts', 'js', 'sh'] },
  { name: 'All Files', extensions: ['*'] },
];

export async function showOpenDialog(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: FILE_FILTERS,
  });
  return result as string | null;
}

export async function showSaveDialog(defaultName?: string): Promise<string | null> {
  const result = await save({
    defaultPath: defaultName,
    filters: FILE_FILTERS,
  });
  return result as string | null;
}

/** Matches `PendingOpen` in src-tauri/src/window.rs. */
export interface PendingOpen {
  path: string | null;
  content: string | null;
  cursor: number;
  topLine: number;
}

/**
 * Comment threads of a document, read from its `.mdmini_comments_<doc>.md`
 * sidecar. An absent sidecar is an empty list, not an error — most documents
 * have no comments, and the file only appears once the first one is written.
 */
export async function commentThreads(path: string): Promise<CommentThread[]> {
  return invoke<CommentThread[]>('comment_threads', { path });
}

/** Creates a thread anchored to `quote` and returns its new id. */
export async function commentCreate(
  path: string,
  line: number,
  quote: string,
  text: string,
  context: { prefix?: string; suffix?: string } = {}
): Promise<string> {
  // `prefix`/`suffix` are the document text on either side of the fragment.
  // They are what lets a repeated quote be told apart from its duplicates when
  // the thread is resolved again later — see `anchorPosition` (#20).
  return invoke<string>('comment_create', {
    path,
    line,
    quote,
    text,
    prefix: context.prefix ?? null,
    suffix: context.suffix ?? null,
  });
}

/**
 * Appends the user's own reply and returns the thread to `open`.
 *
 * The status matters: an agent's reply means "answered", but the user replying
 * again means they are waiting once more — and `open` is exactly what
 * `mdmini watch` emits an event for, so the agent gets woken by it.
 */
export async function commentReply(path: string, id: string, text: string): Promise<void> {
  return invoke('comment_reply', { path, id, text });
}

/**
 * Writes what is currently in a thread's comment box.
 *
 * Replaces the user's own trailing reply rather than appending one, so a pause
 * in typing is not a separate comment; once an agent has answered, the next
 * write starts a new reply under the answer. This is the autosave behind the
 * always-editable comment area — there is no send action (#23).
 */
export async function commentSetReply(path: string, id: string, text: string): Promise<void> {
  return invoke('comment_set_reply', { path, id, text });
}

/** Marks a thread `resolved`. It stays in the file as history, never deleted. */
export async function commentResolve(path: string, id: string): Promise<void> {
  return invoke('comment_resolve', { path, id });
}
