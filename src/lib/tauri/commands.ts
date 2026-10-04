import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { ConcreteTheme, ThemeFamily, ThemeHalf } from '../theme-resolve';
import type { EditorEngine } from '../stores.svelte';
import type { CommentThread } from '../comment-format';
import type { InboxItem } from '../tabs/agent-inbox';
import type { DiskDocument, LineEnding } from '../line-endings';
import { decodeFromDisk, encodeForDisk, isTableBuffer } from '../csv/csv-codec';

/**
 * Read a document from disk, normalized to LF for the editor.
 *
 * The one read boundary for document text: the raw string from `read_file`
 * never reaches the editor, because CM6 would normalize `\r\n` itself and
 * every length computed from the raw string would then be wrong — see
 * `line-endings.ts`. `fallback` is the ending to assume when the file has no
 * line break at all. A `.csv`/`.tsv` path is decoded to a GFM table here — see
 * `csv/csv-codec.ts`.
 */
export async function readDocument(path: string, fallback: LineEnding = 'lf'): Promise<DiskDocument> {
  return decodeFromDisk(path, await invoke<string>('read_file', { path }), fallback);
}

/**
 * Write editor (LF) text to disk in the file's own line ending — the mirror of
 * `readDocument`, and the one write boundary for document text. A `.csv`/`.tsv`
 * path whose buffer is one table is encoded as CSV here, in the dialect of the
 * file it replaces (read at the same path, just before) — see
 * `csv/csv-codec.ts`.
 *
 * Returns the save baseline. For a buffer written as CSV that is the decoded
 * written bytes — what the next read returns — not the buffer: a cell commit
 * leaves the table unpadded and the file comes back canonical, so the buffer
 * as the baseline would make the echo of this very write look like an
 * external change. For anything written as is (any other file, or plain text
 * on a CSV path) it is the buffer: almost any text parses as CSV, so a decoded
 * baseline there would never equal the buffer again, while the buffer lets the
 * echo take the ordinary reload path and turn the tab into the table it reads as.
 *
 * Only a missing file falls back to the default dialect; an existing file that
 * cannot be read fails the save (rejects, writes nothing) rather than being
 * rewritten in a dialect it does not use.
 */
export async function writeDocument(path: string, text: string, lineEnding: LineEnding): Promise<string> {
  const csv = isTableBuffer(path, text);
  const current = csv && (await fileExists(path)) ? await invoke<string>('read_file', { path }) : null;
  const content = encodeForDisk(path, text, lineEnding, current);
  await invoke('write_file', { path, content });
  return csv ? decodeFromDisk(path, content, lineEnding).text : text;
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>('file_exists', { path });
}

/**
 * Sets the Theme menu checkmarks; harmless no-op outside Tauri (browser dev).
 *
 * Берёт уже разрешённую тему, а не выбор человека: с галочкой «система»
 * половину выбирает ОС, и в меню должна стоять галочка на той, что на экране.
 */
export function syncThemeMenu(resolved: ConcreteTheme, followSystem: boolean): void {
  invoke('sync_theme_menu', { resolved, followSystem }).catch(() => {});
}

/**
 * Sets the Dock icon; harmless no-op outside Tauri. Takes the committed theme
 * (`theme.committed`), never a `/theme` preview — see `sync_dock_icon`.
 */
export function syncDockIcon(theme: ConcreteTheme): void {
  invoke('sync_dock_icon', { theme }).catch(() => {});
}

/**
 * Broadcasts a `/theme` commit to every window over the same `menu-event`
 * path a native Theme-menu click already uses (`broadcast_theme` in
 * commands.rs) — so `App.svelte`'s `menu-event` handler needs no changes at
 * all to stay in sync. Harmless no-op outside Tauri (browser dev), like
 * `syncThemeMenu`: the local theme is applied either way, which is what
 * lets `/theme` be checked in `npm run dev`.
 *
 * A concrete theme needs both `family` and `half` — the native menu only
 * ever changes one at a time, but a `/theme` commit changes both in one
 * action. `followSystem` alone matches a "Follow System" click.
 */
export function broadcastTheme(payload: {
  family?: ThemeFamily;
  half?: ThemeHalf;
  followSystem?: boolean;
}): void {
  invoke('broadcast_theme', payload).catch(() => {});
}

/** Sets the Editor Engine submenu checkmarks; harmless no-op outside Tauri. */
export function syncEngineMenu(engine: EditorEngine): void {
  invoke('sync_engine_menu', { engine }).catch(() => {});
}

/** Sets the "OCD Alignment" checkbox; harmless no-op outside Tauri. */
export function syncOcdAlignmentMenu(enabled: boolean): void {
  invoke('sync_ocd_alignment_menu', { enabled }).catch(() => {});
}

/** Sets View → Tabs → Compact; harmless no-op outside Tauri. */
export function syncTabsCompactMenu(enabled: boolean): void {
  invoke('sync_tabs_compact_menu', { enabled }).catch(() => {});
}

/** Sets View → Tabs → Show Dates; harmless no-op outside Tauri. */
export function syncTabsDatesMenu(enabled: boolean): void {
  invoke('sync_tabs_dates_menu', { enabled }).catch(() => {});
}

/** Sets File → quick looks' radio pair; harmless no-op outside Tauri. */
export function syncTransientMenu(policy: 'keep' | 'close'): void {
  invoke('sync_transient_menu', { policy }).catch(() => {});
}

const FILE_FILTERS = [
  { name: 'All Supported', extensions: ['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yml', 'yaml', 'toml', 'py', 'rs', 'ts', 'js', 'sh', 'env'] },
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
  { name: 'Data', extensions: ['csv', 'tsv', 'json', 'yml', 'yaml', 'toml'] },
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

/** One tab a window opens with. Matches `PendingTab` in src-tauri/src/window.rs. */
export interface PendingTab {
  tabId: string;
  path: string | null;
  /** Text of an untitled tab being restored. */
  content: string | null;
  cursor: number;
  topLine: number;
  /** Drawer stamps, ms since the epoch; `0` / `false` for a new tab. */
  openedAt: number;
  viewedAt: number;
  /** The last change to its text; `0` for none (or a session from before the stamp). */
  editedAt: number;
  unviewed: boolean;
  /** A quick look carried by a move between windows (plan 05); `false` otherwise. */
  transient: boolean;
  transientSeenAt: number;
  /** What waited for the tab in its old window's agent inbox; absent unless it moved. */
  inbox?: InboxItem[];
}

/** What a window loads on mount. Matches `WindowInit` in src-tauri/src/window.rs. */
export interface WindowInit {
  /** `#N`; null when all 99 were taken. */
  number: number | null;
  tabs: PendingTab[];
  activeTabId: string | null;
}

/** What `tab_claim` answers (Save As). Matches `TabClaim` in src-tauri/src/tab_commands.rs. */
export type TabClaim =
  /** `path`: the file as the registry spells it (normalized) — the tab takes that one. */
  | { kind: 'claimed'; path?: string | null }
  | { kind: 'this-window'; tabId: string }
  | { kind: 'other-window'; label: string }
  /** The tab id is another window's: nothing was claimed. */
  | { kind: 'refused' };

/**
 * Comment threads of a document, read from its `.mdmini_comments_<doc>.md`
 * sidecar. An absent sidecar is an empty list, not an error — most documents
 * have no comments, and the file only appears once the first one is written.
 */
export async function commentThreads(path: string): Promise<CommentThread[]> {
  return invoke<CommentThread[]>('comment_threads', { path });
}

/** What creating a thread hands back: its id, and when its pause runs out. */
export interface StartedComment {
  id: string;
  /** Epoch **seconds** at which the thread stops being `paused`. */
  until: number;
}

/**
 * Creates a thread anchored to `quote`, `paused` because the person is still
 * typing it (#36).
 *
 * The pause is part of the creating write, not a second one after it: a thread
 * that exists as `open` for even a moment is a thread `couplet watch` can wake
 * an agent on, with one word of a question in it.
 */
export async function commentStart(
  path: string,
  line: number,
  quote: string,
  text: string,
  context: { prefix?: string; suffix?: string } = {}
): Promise<StartedComment> {
  // `prefix`/`suffix` are the document text on either side of the fragment.
  // They are what lets a repeated quote be told apart from its duplicates when
  // the thread is resolved again later — see `anchorPosition` (#20).
  return invoke<StartedComment>('comment_start', {
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
 * `couplet watch` emits an event for, so the agent gets woken by it.
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
 *
 * Returns the epoch second at which the thread's pause runs out, or `null` when
 * there is no pause to wait for because the thread is already `open` — the
 * point of no return, see `status_after_edit` in `src-tauri/src/comments.rs`.
 */
export async function commentWriteReply(
  path: string,
  id: string,
  text: string
): Promise<number | null> {
  return invoke<number | null>('comment_write_reply', { path, id, text });
}

/**
 * Ends a thread's pause now: `paused` becomes `open` and the agent is woken.
 *
 * Resolves to `false` when there was nothing to end — an agent can answer the
 * thread while its countdown is still running, and that answer must not be
 * undone by a timer that fires a moment later.
 */
export async function commentCommit(path: string, id: string): Promise<boolean> {
  return invoke<boolean>('comment_commit', { path, id });
}

/** Marks a thread `resolved`. It stays in the file as history, never deleted. */
export async function commentResolve(path: string, id: string): Promise<void> {
  return invoke('comment_resolve', { path, id });
}
