import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { RecentSnapshot } from '../stores.svelte';

export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'save_as'
  | 'close'
  | 'select_all'
  | 'find'
  | 'toggle_mode'
  | 'engine_raw'
  | 'engine_live_preview'
  | 'engine_live_render'
  | 'zoom_in'
  | 'zoom_out'
  | 'zoom_reset'
  | 'toggle_line_glow'
  // Тумблеры приходят со своим значением, а не как команда «переключи»:
  // событие меню рассылается во все окна, и N окон переключили бы настройку
  // N раз. См. `toggle_value` в `src-tauri/src/lib.rs`.
  | 'toggle_ocd_alignment:on'
  | 'toggle_ocd_alignment:off'
  | 'theme_family_classic'
  | 'theme_family_aurora'
  | 'theme_family_blueprint'
  | 'theme_family_phosphor'
  | 'theme_half_light'
  | 'theme_half_dark'
  | 'theme_system:on'
  | 'theme_system:off'
  | 'recent_files'
  | 'ai_comment'
  | 'ai_watch_command'
  | 'format_json';

export function onMenuEvent(handler: (action: MenuAction) => void): Promise<() => void> {
  return listen<string>('menu-event', (event) => {
    handler(event.payload as MenuAction);
  });
}

/**
 * A file the OS handed to the app (`RunEvent::Opened`), routed by Rust to one
 * window with `emit_to`. Listened for through the current webview window for
 * the same reason as `onAiCommand`: a global listener's target is `Any` and
 * matches targeted emits too, so every window would run `switchDocument` for
 * it.
 */
export function onOpenFile(handler: (path: string) => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen<string>('open-file', (event) => {
    handler(event.payload);
  });
}

export function onFileChangedExternally(handler: (path: string) => void): Promise<() => void> {
  return listen<string>('file-changed-externally', (event) => {
    handler(event.payload);
  });
}

/** Emitted by Rust after windows from the previous session have been reopened. */
export function onSessionRestored(handler: (count: number) => void): Promise<() => void> {
  return listen<number>('session-restored', (event) => {
    handler(event.payload);
  });
}

/** Emitted by Rust whenever any window adds to, or imports into, the shared
 * Recent Files list — every other window applies it via `setList`. */
export function onRecentChanged(handler: (snapshot: RecentSnapshot) => void): Promise<() => void> {
  return listen<RecentSnapshot>('recent-changed', (event) => {
    handler(event.payload);
  });
}

/**
 * The native menu's Language item failed to persist (`apply_language_change`
 * in `lib.rs` returned an error before ever reaching `app.restart()`).
 * Broadcast to every window, deliberately not window-targeted like
 * `onAiCommand`/`onCheckUpdatesRequested`: a language change is a process-wide
 * setting, not something owned by one document's window, so every open
 * window surfacing the same failure is correct rather than noisy.
 */
export function onLanguageChangeFailed(handler: (message: string) => void): Promise<() => void> {
  return listen<string>('language-change-failed', (event) => {
    handler(event.payload);
  });
}

/** A newer release was found. Emitted to every window by the polling one. */
/** Matches `UpdateInfo` in src-tauri/src/updater.rs. */
export interface UpdateInfo {
  latest: string;
  current: string;
  /** One line from the release notes; absent when the notes had nothing usable. */
  highlight?: string;
}

export function onUpdateAvailable(handler: (info: UpdateInfo) => void): Promise<() => void> {
  return listen<UpdateInfo>('update-available', (event) => {
    handler(event.payload);
  });
}

/**
 * The update notice was dismissed. Broadcast so closing it in one window closes
 * it in all of them, rather than once per window.
 */
export function onUpdateDismissed(handler: () => void): Promise<() => void> {
  return listen('update-dismissed', () => {
    handler();
  });
}

/**
 * The user picked "Check for Updates…" from the menu (#82).
 *
 * Routed like `ai-command`, deliberately **not** through the general
 * `menu-event` broadcast (`onMenuEvent`, above): that channel reaches every
 * window, and five open windows would mean five simultaneous GitHub
 * requests for the same answer. Rust targets exactly one window with
 * `emit_to` (see the `check_updates` handler in `lib.rs`) — a bare `emit`
 * would not have been enough on its own, since an unfiltered `emit`
 * broadcasts to every listener regardless of target label. That is also why
 * this must be read through `getCurrentWebviewWindow().listen()` rather than
 * the global `listen`: a global listener's target is `Any`, which matches a
 * *targeted* emit too, so every window's global listener would still fire
 * and race to run its own check. See `onAiCommand` below for the same trap.
 */
export function onCheckUpdatesRequested(handler: () => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen('check-updates-requested', () => {
    handler();
  });
}

/**
 * One `mdmini ai show`/`edit`/`ask` request, routed by Rust to the window
 * that owns `path`. Mirrors the camelCase `AiCommandPayload` serialized by
 * `src-tauri/src/ai_socket.rs` — field names and optionality must match.
 * `question`/`options`/`multi`/`freeText`/`timeoutSecs` are only meaningful
 * for `ask` (`options` empty, `multi`/`freeText` false, and `timeoutSecs` 0
 * for `show`/`edit`).
 */
export interface AiCommandPayload {
  id: number;
  cmd: 'show' | 'edit' | 'ask';
  path: string;
  line: number | null;
  find: string | null;
  content: string | null;
  show: boolean;
  question: string | null;
  options: string[];
  /** Multi-choice (checkbox chips + confirm) vs single-choice (click an option). */
  multi: boolean;
  /** Adds a free-text input below the option row, in either mode. */
  freeText: boolean;
  timeoutSecs: number;
  /**
   * Set on exactly one command per install — the first an agent ever delivers.
   * Cues the "that was your AI" toast, which is the only surface that reaches
   * someone whose agent config arrived pre-made from a colleague.
   */
  firstUse: boolean;
}

/**
 * Emitted to the window that owns the file targeted by an AI command.
 *
 * Must listen via the current webview window, not the global `listen`: a
 * global listener's target is `Any`, which matches *targeted* emits too, so
 * every window would receive the command and the non-owners would race to
 * answer it with an error.
 */
export function onAiCommand(handler: (payload: AiCommandPayload) => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen<AiCommandPayload>('ai-command', (event) => {
    handler(event.payload);
  });
}

/**
 * The comment sidecar of a document changed on disk — usually an agent
 * appending a reply.
 *
 * Deliberately NOT `file-changed-externally`. That path early-returns on any
 * path but the open document's, and when the buffer is dirty it pops a
 * blocking modal asking whether to reload — neither is right here. The
 * document itself did not change, and an agent writing a reply must never
 * interrupt the user with a dialog.
 *
 * Window-targeted, so it must be listened for through the current webview
 * window rather than the global `listen`, for the same reason `onAiCommand`
 * documents: a global listener's target is `Any` and would also match
 * targeted emits, so every window would react to every document's comments.
 */
export function onCommentsChanged(handler: (path: string) => void): Promise<() => void> {
  return getCurrentWebviewWindow().listen<string>('comments-changed', (event) => {
    handler(event.payload);
  });
}
