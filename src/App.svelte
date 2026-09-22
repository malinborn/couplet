<script lang="ts">
  import { onMount } from 'svelte';
  import Editor from './lib/editor/Editor.svelte';
  import type { EditorHandle } from './lib/editor/Editor.svelte';
  import { createThemeStore, createEngineStore, createZoomStore, createLineGlowStore, createOcdAlignmentStore, createFileState, createRecentFilesStore, setProductName } from './lib/stores.svelte';
  import { getName } from '@tauri-apps/api/app';
  import { readFile, writeFile, fileExists, showOpenDialog, showSaveDialog, syncThemeMenu, syncEngineMenu, syncOcdAlignmentMenu, commentThreads, commentStart, commentResolve, commentWriteReply, commentCommit, type PendingOpen } from './lib/tauri/commands';
  import {
    onMenuEvent,
    onOpenFile,
    onFileChangedExternally,
    onSessionRestored,
    onUpdateAvailable,
    onUpdateDismissed,
    onAiCommand,
    onCommentsChanged,
    type AiCommandPayload,
    type UpdateInfo,
  } from './lib/tauri/events';
  import { invoke } from '@tauri-apps/api/core';
  import { ask } from '@tauri-apps/plugin-dialog';
  import RecentFilesPanel from './lib/RecentFilesPanel.svelte';
  import ToastStack from './lib/ToastStack.svelte';
  import AiHintBadge from './lib/AiHintBadge.svelte';
  import AiBindButton from './lib/AiBindButton.svelte';
  import { createToastStore } from './lib/toasts.svelte';
  import { shouldShowHint, nextCheckDelay } from './lib/ai-hint';
  import { previewCompartment, lineGlowCompartment } from './lib/editor/setup';
  import { stashAndUnfoldAll, restoreStashedFolds } from './lib/editor/fold-memory';
  import { EditorView, highlightActiveLine } from '@codemirror/view';
  import { ChangeSet, Text, type StateEffect } from '@codemirror/state';
  import { livePreviewPlugin } from './lib/editor/preview/plugin';
  import { LIVE_PREVIEW, LIVE_RENDER, flavourFacet } from './lib/editor/preview/flavour';
  import { liveRenderExtensions } from './lib/editor/live-render';
  import { envPreviewPlugin } from './lib/editor/preview/env';
  import { shellSecretsPlugin } from './lib/editor/preview/shell-secrets';
  import { MARKDOWN_EXTENSIONS, isShellConfig } from './lib/editor/file-language';
  import { reinitializeTheme } from './lib/editor/preview/mermaid';
  import { computeReplacement, computeChangedLineRanges } from './lib/editor/content-diff';
  import {
    resolveShowTarget,
    changedLineRanges,
    docRangesForLineRanges,
  } from './lib/ai-commands';
  import {
    setAiHighlights,
    pulseAiLine,
    clearAiHighlights,
    aiHighlightRanges,
  } from './lib/editor/ai-highlight';
  import { addAiAsk, removeAiAsk } from './lib/editor/ai-ask';
  import {
    addAiComment,
    aiCommentField,
    clearAiComments,
    CommentWidget,
    COMMENT_IDLE,
    COMMENT_SEND_LABEL,
    COMMENT_SEND_TEXT,
    COMMENT_SENDING,
    COMMENT_SENDING_TEXT,
    type CommentActions,
  } from './lib/editor/ai-comment';
  import {
    anchorContextAt,
    anchorPosition,
    buildHandoffPrompt,
    buildWatchPrompt,
    countdownLabel,
    splitThread,
    type AnchorContext,
    type CommentThread,
  } from './lib/comment-format';
  import { buildBindPrompt } from './lib/ai-bind';
  import { applyJsonOffer, formatJsonCommand } from './lib/editor/json-paste';
  import './lib/theme/dark.css';
  import './lib/theme/light.css';
  import './lib/theme/aurora-dark.css';
  import './lib/theme/aurora-light.css';
  // Обе половины в одном файле — семья описана целиком в одном месте.
  import './lib/theme/blueprint.css';
  import './lib/theme/phosphor.css';
  import './styles/global.css';
  import './styles/editor.css';

  const theme = createThemeStore();
  const engine = createEngineStore();

  const zoom = createZoomStore();
  const lineGlow = createLineGlowStore();
  const ocdAlignment = createOcdAlignmentStore();
  const fileState = createFileState();
  const recentFiles = createRecentFilesStore();
  const toasts = createToastStore();

  let showRecentFiles = $state(false);
  let activePreview: 'markdown' | 'env' | 'code' | 'shell' = $state('markdown');

  let editorHandle: EditorHandle | undefined = $state(undefined);

  // --- AI-edit highlight hint (bottom-left "Esc" nudge) ---
  const AI_HINT_SEEN_KEY = 'md-mini.ai-hint-seen';
  let showAiHint = $state(false);
  // Plain (non-reactive) bookkeeping: when the current highlight became visible,
  // and the pending "recheck at the 2h mark" timer. Neither needs to drive a
  // render on its own — only showAiHint does.
  let aiHighlightVisibleSince: number | null = null;
  let aiHintTimer: ReturnType<typeof setTimeout> | null = null;

  function loadAiHintSeen(): boolean {
    try {
      return localStorage.getItem(AI_HINT_SEEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  function markAiHintSeen(): void {
    try {
      localStorage.setItem(AI_HINT_SEEN_KEY, '1');
    } catch {
      // best-effort; a missing flag just means the hint may show again
    }
  }

  function clearAiHintTimer(): void {
    if (aiHintTimer !== null) {
      clearTimeout(aiHintTimer);
      aiHintTimer = null;
    }
  }

  /** Re-evaluates whether the hint should be showing, and if not, schedules a
   * single recheck for the moment this highlight crosses the 2h mark. */
  function evaluateAiHint(): void {
    if (aiHighlightVisibleSince === null) return;
    const visibleSince = aiHighlightVisibleSince;
    const now = Date.now();
    if (shouldShowHint({ seenBefore: loadAiHintSeen(), visibleSince, now })) {
      showAiHint = true;
      clearAiHintTimer();
      return;
    }
    clearAiHintTimer();
    aiHintTimer = setTimeout(() => {
      aiHintTimer = null;
      // Guard: the highlight (or a later one) must still be visible — a
      // clear in the meantime already reset aiHighlightVisibleSince to null.
      if (aiHighlightVisibleSince !== null) evaluateAiHint();
    }, nextCheckDelay({ visibleSince, now: Date.now() }));
  }

  function handleAiHighlightVisibilityChange(visible: boolean): void {
    if (visible) {
      // Replacing ranges while already visible re-fires this with visible=true
      // only via a false->true transition (see aiHighlightPresenceNotifier), so
      // this branch only ever runs once per empty->non-empty transition and
      // aiHighlightVisibleSince keeps its original timestamp for the run.
      if (aiHighlightVisibleSince === null) aiHighlightVisibleSince = Date.now();
      evaluateAiHint();
    } else {
      // Only the flag the user actually saw the hint burns the one-time show —
      // an unnoticed flash (highlight cleared before evaluateAiHint ever set
      // showAiHint) must not silently consume it.
      if (showAiHint) markAiHintSeen();
      showAiHint = false;
      aiHighlightVisibleSince = null;
      clearAiHintTimer();
    }
  }

  // --- Timers ---
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Track whether we are currently writing to disk (to avoid reacting to our own save)
  let isSaving = false;

  function handleChange(doc: string) {
    fileState.isDirty = true;
    scheduleAutoSave();
  }

  // --- Auto-save (300ms debounce) ---
  function scheduleAutoSave(): void {
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (fileState.isDirty && fileState.filePath) {
        performSave();
      }
    }, 300);
  }

  async function performSave(): Promise<void> {
    if (!fileState.filePath) return;
    const content = editorHandle?.view?.state.doc.toString() ?? '';
    try {
      isSaving = true;
      await writeFile(fileState.filePath, content);
      fileState.isDirty = false;
      fileState.lastSavedAt = Date.now();
      // A previous failure is over the moment a save lands.
      toasts.dismissKind('save-error');
      // Clean up recovery file on successful save
      await invoke('delete_recovery', { path: fileState.filePath }).catch(() => {});
    } catch (err) {
      // `isDirty` deliberately stays true: the document is still unsaved, so
      // the next keystroke reschedules a save and the recovery snapshot keeps
      // being written. Until #18 this branch was a `console.error` and nothing
      // else — a file the filesystem refused to replace went on looking saved
      // while the user kept typing into it.
      console.error('Auto-save failed:', err);
      toasts.push({
        kind: 'save-error',
        fileName: fileState.filePath.split('/').pop() ?? fileState.filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Keep isSaving true briefly to suppress FSEvent from our own atomic write
      setTimeout(() => { isSaving = false; }, 600);
    }
  }

  async function handleSave(): Promise<void> {
    if (!fileState.filePath) {
      await handleSaveAs();
      return;
    }
    await performSave();
  }

  async function handleSaveAs(): Promise<void> {
    const name = fileState.filePath
      ? fileState.filePath.split('/').pop()
      : 'Untitled.md';
    const path = await showSaveDialog(name);
    if (!path) return;
    fileState.filePath = path;
    await performSave();
    recentFiles.add(path);
  }

  async function handleOpen(): Promise<void> {
    const path = await showOpenDialog();
    if (!path) return;
    try {
      const content = await readFile(path);
      fileState.filePath = path;
      // Register this window as the owner of `path` in the Rust-side
      // `OpenFiles` map and (re)start its watcher. Without this, a file
      // opened via the dialog into an already-open window is invisible to
      // every dedup/routing check that consults `OpenFiles` (AI commands,
      // "already open" focus-instead-of-duplicate), and never gets watched
      // for external changes either.
      invoke('register_open_file', { path }).catch(() => {});
      fileState.isDirty = false;
      editorHandle?.replaceContent(content);
      recentFiles.add(path);
    } catch (err) {
      console.error('Open failed:', err);
    }
  }

  function handleNew(): void {
    invoke('open_file_window_cmd', { path: null }).catch((err: unknown) => {
      console.error('Failed to open new window:', err);
    });
  }

  function handleFind(): void {
    const view = editorHandle?.view;
    if (!view) return;
    import('@codemirror/search').then(({ openSearchPanel }) => {
      openSearchPanel(view);
    });
  }

  async function handleOpenFilePath(path: string): Promise<void> {
    try {
      const exists = await fileExists(path);
      if (exists) {
        const content = await readFile(path);
        editorHandle?.replaceContent(content);
      } else {
        editorHandle?.replaceContent('');
      }
      fileState.filePath = path;
      // Register this window as the owner of `path` — see the matching call
      // in `handleOpen`. Also (re)starts the file watcher, replacing the
      // separate `start_watching` invoke this used to make.
      invoke('register_open_file', { path }).catch(() => {});
      fileState.isDirty = false;
      recentFiles.add(path);

      // A different document means different comments; drafts belonged to the
      // file we just left and must not reappear anchored in this one.
      commentDrafts = new Map();
      void reloadComments();

      // Detect file type and switch editor mode
      const basename = path.split('/').pop()?.toLowerCase() ?? '';
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const isEnvFile = basename.startsWith('.env') || ext === 'env';

      if (isEnvFile) {
        editorHandle?.setEnvMode(true);
        activePreview = 'env';
      } else if (!MARKDOWN_EXTENSIONS.has(ext)) {
        editorHandle?.setEnvMode(false);
        editorHandle?.setCodeMode(ext, basename);
        activePreview = isShellConfig(basename) ? 'shell' : 'code';
      } else {
        editorHandle?.setEnvMode(false);
        editorHandle?.setCodeMode(null);
        activePreview = 'markdown';
      }

      // `setCodeMode`/`setEnvMode` above reconfigure the preview compartment
      // themselves, and the markdown branch installs a bare livePreviewPlugin
      // — no flavour facet, no live-render bundle. Re-assert the engine's own
      // configuration on top, or a freshly opened window sits in a half-built
      // state: in live-render that meant no atomic markers, no hidden markers
      // and no selection toolbar until the engine was toggled by hand.
      // `activePreview` was just assigned, so this cannot rely on the $effect
      // firing first.
      applyPreviewConfig();
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }

  // --- Restored caret / scroll ---
  async function applyRestorePosition(cursor: number, topLine: number): Promise<void> {
    const view = editorHandle?.view;
    if (!view) return;
    const { clampCursor, clampTopLine } = await import('./lib/session-position');

    const anchor = clampCursor(cursor, view.state.doc.length);
    const line = view.state.doc.line(clampTopLine(topLine, view.state.doc.lines));

    view.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
    });
  }

  // --- External file change handling ---
  async function handleExternalChange(path: string): Promise<void> {
    if (isSaving) return; // Ignore changes caused by our own save
    if (path !== fileState.filePath) return;

    if (!fileState.isDirty) {
      // Silently reload
      try {
        const content = await readFile(path);
        editorHandle?.updateContent(content);
        fileState.isDirty = false;
      } catch (err) {
        console.error('Failed to reload externally changed file:', err);
      }
    } else {
      // Ask user
      const reload = await ask(
        'The file has been modified externally. Reload and lose your changes?',
        { title: 'External Change', kind: 'warning' }
      );
      if (reload) {
        try {
          const content = await readFile(path);
          editorHandle?.updateContent(content);
          fileState.isDirty = false;
        } catch (err) {
          console.error('Failed to reload externally changed file:', err);
        }
      }
    }
  }

  // --- Comment threads (the reverse AI channel) ---

  /**
   * Anchor of a thread the user has started but not yet written. Draft threads
   * exist only in CM6 state — nothing is written to the sidecar until there is
   * actual text, so opening the menu item and changing your mind leaves no
   * file behind and no empty thread for an agent to be woken by.
   *
   * Keyed by the synthetic id the draft widget carries; `commentActions.reply`
   * uses the presence of a key here to decide "create" versus "append".
   */
  let commentDrafts = new Map<
    string,
    { line: number; quote: string; context: AnchorContext }
  >();
  let commentDraftSeq = 0;

  /**
   * How long after the last keystroke the comment box is written to the
   * sidecar. Long enough that a sentence is one write and not thirty, short
   * enough that clicking away or closing the window right after typing cannot
   * realistically beat it — and both of those flush immediately anyway.
   */
  const COMMENT_AUTOSAVE_MS = 700;

  /**
   * Text in a thread's box that has not been written yet.
   *
   * `saved` is what the last successful write put in the file, and the pair is
   * what decides whether an in-flight edit survives a rebuild: still different
   * means the user has typed since, so the box keeps showing it; equal means
   * the file already has it, so the box goes back to following the file. That
   * second case is what makes the freeze correct — when an agent answers, the
   * user's last turn moves into the frozen part and the new box below it comes
   * up empty instead of repeating the text that is now above it.
   *
   * `path` is captured per entry rather than read at write time: a flush can
   * fire while the window is already showing a different document, and it must
   * write to the file the text was typed in.
   */
  interface CommentPending {
    path: string;
    text: string;
    saved: string;
    timer: ReturnType<typeof setTimeout> | null;
  }
  let commentPending = new Map<string, CommentPending>();

  /** What the file currently says is in each thread's box. */
  let commentEditable = new Map<string, string>();

  /**
   * Threads whose pause is still running, and when each one ends (ms epoch).
   *
   * The deadline is the app's copy of what is already written on the thread's
   * marker line, so a card can count down to the same moment the file will be
   * judged against. Losing the map — a reload, a reopened document — loses
   * nothing that matters: `syncCommentCountdowns` rebuilds it from the file,
   * and the file alone is what decides whether an agent is woken.
   */
  let commentCountdowns = new Map<string, { path: string; deadline: number }>();

  /** One ticker for every card, started on demand. */
  let commentTicker: ReturnType<typeof setInterval> | null = null;

  /**
   * Paint the seconds left into the cards, and fire the ones that have run out.
   *
   * Writing `textContent` into an existing span is the whole mechanism, and
   * that is deliberate: a countdown kept in CM6 state would rebuild the widget
   * once a second, and a rebuilt widget is a new textarea — the caret jumps to
   * the end and an IME composition in progress is destroyed. Same rule as the
   * per-frame transaction ban in CLAUDE.md, for the same reason.
   */
  function tickCommentCountdowns(): void {
    const view = editorHandle?.view;
    const now = Date.now();
    for (const [id, entry] of [...commentCountdowns]) {
      if (now >= entry.deadline) {
        void fireCommentCountdown(id);
        continue;
      }
      const label = view?.dom.querySelector(
        `[data-comment-countdown="${CSS.escape(id)}"]`
      );
      if (label) {
        label.textContent = countdownLabel(entry.deadline - now);
        label.classList.remove(COMMENT_IDLE);
      }
      // The countdown is a child of the button (#61), so both come back into
      // view together — and the verb is reset here as well, because a card
      // whose pause is re-armed after a `sending…` may be the very same DOM.
      const button = view?.dom.querySelector(`[data-comment-send-now="${CSS.escape(id)}"]`);
      button?.classList.remove(COMMENT_IDLE);
      if (button?.classList.contains(COMMENT_SENDING)) {
        button.classList.remove(COMMENT_SENDING);
        (button as HTMLButtonElement).disabled = false;
        const verb = button.querySelector(`.${COMMENT_SEND_LABEL}`);
        if (verb) verb.textContent = COMMENT_SEND_TEXT;
      }
    }
    if (!commentCountdowns.size && commentTicker !== null) {
      clearInterval(commentTicker);
      commentTicker = null;
    }
  }

  /** Start (or restart) a thread's countdown, ending at `deadline` ms epoch. */
  function armCommentCountdown(id: string, path: string, deadline: number): void {
    commentCountdowns.set(id, { path, deadline });
    if (commentTicker === null) commentTicker = setInterval(tickCommentCountdowns, 1000);
    // Paint at once rather than waiting a second: the label must appear with
    // the first keystroke, or the pause is invisible for the moment that
    // matters most — when someone is wondering whether the agent already saw
    // their half-written sentence.
    tickCommentCountdowns();
  }

  /**
   * Stop a thread's countdown.
   *
   * Two endings, and they have to look different. A pause that was *cancelled*
   * — the thread resolved, the file says it is no longer paused — leaves
   * nothing to say, so the button goes away as if it had never been there. A
   * pause that *fired* is the button doing its job, and a control that vanishes
   * under the pointer at the moment you were reaching for it reads as a
   * misclick: it stays, disabled, saying `sending…` until the reload replaces
   * the card with one whose header reads "waiting for agent" (#61).
   */
  function disarmCommentCountdown(id: string, sending = false): void {
    commentCountdowns.delete(id);
    const view = editorHandle?.view;
    const label = view?.dom.querySelector(`[data-comment-countdown="${CSS.escape(id)}"]`);
    if (label) {
      label.textContent = '';
      label.classList.add(COMMENT_IDLE);
    }
    const button = view?.dom.querySelector(`[data-comment-send-now="${CSS.escape(id)}"]`);
    const verb = button?.querySelector(`.${COMMENT_SEND_LABEL}`);
    if (button) {
      button.classList.toggle(COMMENT_IDLE, !sending);
      button.classList.toggle(COMMENT_SENDING, sending);
      (button as HTMLButtonElement).disabled = sending;
      if (verb) verb.textContent = sending ? COMMENT_SENDING_TEXT : COMMENT_SEND_TEXT;
    }
    if (!commentCountdowns.size && commentTicker !== null) {
      clearInterval(commentTicker);
      commentTicker = null;
    }
  }

  /**
   * Hand a thread to the agent now: write what is in the box, then end the
   * pause.
   *
   * The order is the point. Committing first would open the thread with the
   * text as of the last autosave — up to `COMMENT_AUTOSAVE_MS` behind what is
   * on screen — and `mdmini watch` would wake an agent on a sentence that is
   * already stale.
   */
  async function fireCommentCountdown(id: string): Promise<void> {
    const entry = commentCountdowns.get(id);
    if (!entry) return;
    disarmCommentCountdown(id, true);
    // A draft becomes a real thread on its first write, under an id the file
    // gives it — the commit has to follow it there.
    const written = (await writeComment(id)) ?? id;
    try {
      await commentCommit(entry.path, written);
      toasts.dismissKind('comment-error');
    } catch (err) {
      // The thread stays paused: the write that would have handed it to the
      // agent did not happen, and pretending otherwise would leave the user
      // waiting for a reply to a question no agent can see.
      reportCommentError(entry.path, err);
      return;
    }
    await reloadComments();
  }

  /**
   * End every running pause immediately.
   *
   * Called when the window loses focus — which, for a comment, usually means
   * the person has gone to the agent they are writing to, and every second of
   * countdown after that is a second of waiting for nothing. It is also the
   * cheapest insurance against the countdown dying with the app: the window
   * that is about to be closed or quit is almost always one that lost focus
   * first. The paths where it is not are covered in Rust — `CloseRequested`
   * and `save_session_on_exit` in `src-tauri/src/lib.rs` — and, failing even
   * those, by the deadline written on the marker line itself.
   */
  function commitAllCommentPauses(): void {
    for (const id of [...commentCountdowns.keys()]) void fireCommentCountdown(id);
  }

  /**
   * Bring the countdowns in line with what the file says.
   *
   * Runs after every rebuild of the cards. Three cases, and the third is the
   * one that matters: a thread that is `paused` with a deadline already behind
   * it was left that way by an md-mini that did not survive to commit it, and
   * committing it here is how the app heals the file it just opened. The same
   * state also reaches agents on its own — `awaiting` in `comments.rs` reads an
   * expired pause as waiting — this only makes it prompt.
   */
  function syncCommentCountdowns(threads: CommentThread[]): void {
    const path = fileState.filePath;
    if (!path) return;
    for (const thread of threads) {
      if (thread.status !== 'paused') {
        if (commentCountdowns.has(thread.id)) disarmCommentCountdown(thread.id);
        continue;
      }
      const deadline = (thread.until ?? 0) * 1000;
      if (deadline <= Date.now()) {
        // Nothing is being typed into it right now, so there is nothing to
        // wait for: hand it over.
        armCommentCountdown(thread.id, path, 0);
        continue;
      }
      const known = commentCountdowns.get(thread.id);
      // A live countdown wins over the file's: the app's own deadline is the
      // one the user's last keystroke set, and the file may be a write behind.
      if (!known || known.deadline < deadline) armCommentCountdown(thread.id, path, deadline);
      else armCommentCountdown(thread.id, path, known.deadline);
    }
  }

  /** Thread whose box should take the caret on the next rebuild, and where. */
  let commentFocus: { id: string; at: number } | null = null;

  /** The comment box that currently has focus, if any. */
  function focusedCommentBox(): { id: string; at: number } | null {
    const el = document.activeElement as HTMLTextAreaElement | null;
    const id = el?.getAttribute?.('data-comment-input');
    if (!id) return null;
    return { id, at: el?.selectionStart ?? el?.value.length ?? 0 };
  }

  /**
   * Say that a write landed. Autosave is invisible, and that invisibility is
   * exactly what made people think nothing had been saved — so it is written
   * into the card rather than left to be inferred.
   */
  /**
   * Surface a sidecar write that did not reach the disk (#54).
   *
   * Until now every one of these reached `console.error` and stopped there. The
   * document can afford that for a moment — `isDirty` stays true, the next
   * keystroke reschedules the save, and `recovery.rs` has a snapshot from at
   * most five seconds ago. A comment box has none of those: nothing snapshots
   * it, and since #23/#36 it holds a reply the human has not sent. A sidecar
   * whose ACL or volume refuses the write is a conversation that silently stops
   * being recorded while the user keeps typing into it.
   *
   * `fileName` is the *document*'s, not the sidecar's, because that is the file
   * the user knows they are working in; the sidecar's own path is already in
   * the message the backend returns.
   */
  function reportCommentError(path: string, err: unknown): void {
    console.error('Comment write failed:', err);
    toasts.push({
      kind: 'comment-error',
      fileName: path.split('/').pop() ?? path,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  function markCommentSaved(id: string): void {
    // A write that lands ends the failure, whether or not the card is still on
    // screen to show a label — so this runs before the early return below.
    toasts.dismissKind('comment-error');
    const view = editorHandle?.view;
    const card = view?.dom.querySelector(`[data-comment-thread="${CSS.escape(id)}"]`);
    const label = card?.querySelector('.cm-ai-comment-saved');
    if (!label) return;
    label.textContent = 'saved';
    setTimeout(() => {
      if (label.textContent === 'saved') label.textContent = '';
    }, 2500);
  }

  /**
   * Write a thread's pending text now. Creating the thread if this is its
   * first text — that is what turns a draft card into a real one.
   *
   * Returns the id the text ended up under, so a caller that has more to do
   * with this thread — the pause commit — can follow a draft to the real id
   * the file just gave it. `null` when nothing was written.
   */
  async function writeComment(id: string): Promise<string | null> {
    const entry = commentPending.get(id);
    if (!entry) return null;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const text = entry.text;
    // An empty box writes nothing. Clearing it is not how a comment is
    // deleted — resolve is — and an empty thread would reach an agent as an
    // empty question.
    if (!text.trim() || text === entry.saved) return null;

    const draft = commentDrafts.get(id);
    if (draft) {
      commentDrafts.delete(id);
      const caret = focusedCommentBox();
      try {
        const started = await commentStart(
          entry.path,
          draft.line,
          draft.quote,
          text,
          draft.context
        );
        const realId = started.id;
        // The countdown was started under the draft's id by the keystroke that
        // created this thread; move it, with the deadline the file actually
        // recorded rather than the one this side guessed.
        disarmCommentCountdown(id);
        armCommentCountdown(realId, entry.path, started.until * 1000);
        commentPending.delete(id);
        commentPending.set(realId, { path: entry.path, text, saved: text, timer: null });
        commentEditable.set(realId, text);
        // The card is about to be rebuilt under the id the file gave it; the
        // caret has to come along, or the first save silently ejects the user
        // from the box they are writing in.
        commentFocus = { id: realId, at: caret?.id === id ? caret.at : text.length };
        // The sidecar has only just come into existence, so the watcher armed
        // when this document was opened isn't watching it yet. Re-registering
        // the file rebuilds the watcher over both paths — otherwise the very
        // first agent reply would arrive with nothing listening for it.
        await invoke('register_open_file', { path: entry.path }).catch(() => {});
        await reloadComments();
        markCommentSaved(realId);
        return realId;
      } catch (err) {
        // Put the draft back, or the card would keep collecting text that has
        // nowhere to go.
        commentDrafts.set(id, draft);
        reportCommentError(entry.path, err);
        return null;
      }
    }

    try {
      // The status the write implies comes back with it: a deadline while the
      // thread is still being held back, `null` once it has been handed over
      // and cannot be taken back.
      const until = await commentWriteReply(entry.path, id, text);
      entry.saved = text;
      commentEditable.set(id, text);
      if (until === null) disarmCommentCountdown(id);
      else armCommentCountdown(id, entry.path, until * 1000);
      markCommentSaved(id);
      return id;
    } catch (err) {
      // `entry.saved` is deliberately left alone, so the next keystroke tries
      // again — the same reasoning as `isDirty` staying true on a failed
      // document save. The toast is what covers the case where there is no next
      // keystroke because the user has finished typing.
      reportCommentError(entry.path, err);
      return null;
    }
  }

  /** Drop everything pending for a thread — used when it is resolved, so a
   * queued write cannot bring it back from the dead. */
  function forgetCommentPending(id: string): void {
    const entry = commentPending.get(id);
    if (entry?.timer !== null && entry?.timer !== undefined) clearTimeout(entry.timer);
    commentPending.delete(id);
  }

  /**
   * Rebuild every comment widget from the sidecar.
   *
   * Wholesale rather than incremental: threads are few, the file is small, and
   * a full rebuild cannot drift out of sync with the file the way a diff could.
   * Resolved threads are skipped — they stay in the file as history, but the
   * document should not accumulate closed cards forever.
   */
  async function reloadComments(): Promise<void> {
    const path = fileState.filePath;
    const view = editorHandle?.view;
    if (!view) return;
    if (!path) {
      view.dispatch({ effects: clearAiComments.of(null) });
      return;
    }
    const threads = await commentThreads(path).catch(() => []);
    const doc = view.state.doc.toString();
    // Whoever is in a box right now goes back into it afterwards. Without
    // this, an agent answering — or the user's own autosave flipping the
    // status back to open — would throw the caret out of the box mid-word.
    const focus = commentFocus ?? focusedCommentBox();
    commentFocus = null;
    const effects: StateEffect<unknown>[] = [clearAiComments.of(null)];
    for (const thread of threads) {
      if (thread.status === 'resolved') continue;
      const { pos, to, orphaned } = anchorPosition(doc, thread.quote, thread.line, {
        prefix: thread.prefix,
        suffix: thread.suffix,
      });
      commentEditable.set(thread.id, splitThread(thread).editable);
      effects.push(
        addAiComment.of({
          thread,
          pos,
          to,
          orphaned,
          actions: commentActions,
          draft: pendingTextFor(thread.id),
          focusAt: focus?.id === thread.id ? focus.at : undefined,
        })
      );
    }
    // Drafts are not in the file, so a reload would otherwise silently discard
    // half-typed comments — re-add them on top.
    for (const [id, draft] of commentDrafts) {
      const { pos, to, orphaned } = anchorPosition(doc, draft.quote, draft.line, draft.context);
      effects.push(
        addAiComment.of({
          // `paused`, not `open`: a draft is a comment being typed, which is
          // exactly what the pause means. Saying `open` on the card would
          // promise a wake-up that the first write is about to hold back.
          thread: { id, status: 'paused', line: draft.line, quote: draft.quote, replies: [] },
          pos,
          to,
          orphaned,
          actions: commentActions,
          draft: pendingTextFor(id),
          focusAt: focus?.id === id ? focus.at : undefined,
        })
      );
    }
    view.dispatch({ effects });
    // After the dispatch: the cards were just replaced, so the countdown spans
    // in them are the new, empty ones.
    syncCommentCountdowns(threads);
  }

  /**
   * Text to put in a thread's box, or `undefined` to let the file decide.
   *
   * An entry whose text matches what was written is no longer an edit in
   * flight — it is the file, and it is dropped so the box follows the file
   * again. That is what lets a turn freeze: once the agent answers, the same
   * text is above the box and the box itself must come up empty.
   */
  function pendingTextFor(id: string): string | undefined {
    const entry = commentPending.get(id);
    if (!entry) return undefined;
    if (entry.text === entry.saved && entry.timer === null) {
      commentPending.delete(id);
      return undefined;
    }
    return entry.text;
  }

  /** Document offset a comment widget currently sits at, or null if it's gone. */
  function commentWidgetPos(id: string): number | null {
    const view = editorHandle?.view;
    if (!view) return null;
    const set = view.state.field(aiCommentField, false);
    if (!set) return null;
    let found: number | null = null;
    set.between(0, view.state.doc.length, (from, _to, value) => {
      const widget = (value.spec as { widget: unknown }).widget;
      if (widget instanceof CommentWidget && widget.spec.thread.id === id) found = from;
    });
    return found;
  }

  const commentActions: CommentActions = {
    save: (id, text) => {
      const path = fileState.filePath;
      if (!path) return;
      const entry = commentPending.get(id) ?? {
        path,
        text,
        saved: commentEditable.get(id) ?? '',
        timer: null,
      };
      entry.path = path;
      entry.text = text;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void writeComment(id);
      }, COMMENT_AUTOSAVE_MS);
      commentPending.set(id, entry);
    },
    flush: (id) => {
      void writeComment(id);
    },
    sendNow: (id) => {
      // Deliberately not "flush, then let the timer do its thing": the button
      // says now, and what it does is exactly what the countdown would have
      // done when it ran out.
      void fireCommentCountdown(id);
    },
    resolve: (id) => {
      const path = fileState.filePath;
      if (!path) return;
      forgetCommentPending(id);
      // A pause on a resolved thread has nothing left to hand over.
      disarmCommentCountdown(id);
      if (commentDrafts.delete(id)) {
        // Nothing was ever written; just drop the card.
        void reloadComments();
        return;
      }
      // Resolving is a sidecar write like any other, and it had no failure
      // path at all: a refused write left the thread open on disk while the
      // card disappeared from the screen, so it came back on the next reload
      // with no explanation. `reloadComments` still runs, which is what puts
      // the card back — now with a toast saying why.
      void commentResolve(path, id)
        .catch((err) => reportCommentError(path, err))
        .then(reloadComments);
    },
    handoff: (id) => {
      const path = fileState.filePath;
      if (!path) return;
      void navigator.clipboard.writeText(buildHandoffPrompt(path, id));
    },
    insertIntoText: (id, text) => {
      const view = editorHandle?.view;
      const at = commentWidgetPos(id);
      if (!view || at === null) return;
      // A normal, undoable edit: the answer is content the user chose to
      // accept, and Cmd+Z is how they take it back.
      //
      // Highlighted like any other AI edit. Text arriving from an agent looks
      // the same whether it came through `mdmini edit` or through a comment
      // thread, so it gets the same wash and the same Escape to dismiss —
      // without it, a paragraph the user did not write appears in their
      // document with nothing marking it as not theirs.
      view.dispatch({
        changes: { from: at, insert: `\n${text}\n` },
        effects: setAiHighlights.of([{ from: at + 1, to: at + 1 + text.length }]),
      });
    },
  };

  /**
   * Put the "start watching this document's comments" prompt on the clipboard.
   *
   * Same focus guard as comment creation, and for the same reason: a menu event
   * reaches every window, and only the focused one should answer for its own
   * document. The toast is the whole point — a clipboard write is invisible.
   */
  /**
   * Put the "here is the document I'm looking at" prompt on the clipboard —
   * the top-left button's whole job (#29).
   *
   * No focus guard, unlike `copyWatchCommand` below: this is a click inside
   * this window's own chrome, so which document is meant is never in question.
   */
  function copyBindPrompt(): void {
    const path = fileState.filePath;
    if (!path) {
      toasts.push({ kind: 'ai-bind-copied', saved: false });
      return;
    }
    void navigator.clipboard
      .writeText(buildBindPrompt(path))
      .then(() => toasts.push({ kind: 'ai-bind-copied', saved: true }))
      .catch(() => toasts.push({ kind: 'ai-bind-copied', saved: false }));
  }

  /**
   * Expand the JSON the offer toast is pointing at, or — when invoked from the
   * hotkey or the menu with no offer pending — the selection, falling back to
   * the whole document.
   *
   * One ordinary transaction either way, so Cmd+Z undoes it in one press. The
   * document is never reformatted without one of these three explicit acts.
   */
  function formatJson(fromOffer: boolean): void {
    const view = editorHandle?.view;
    if (!view) return;
    if (fromOffer && applyJsonOffer(view)) return;
    formatJsonCommand(view);
  }

  function copyWatchCommand(): void {
    if (!document.hasFocus()) return;
    const path = fileState.filePath;
    if (!path) {
      toasts.push({ kind: 'ai-watch-copied', saved: false });
      return;
    }
    void navigator.clipboard
      .writeText(buildWatchPrompt(path))
      .then(() => toasts.push({ kind: 'ai-watch-copied', saved: true }))
      .catch(() => toasts.push({ kind: 'ai-watch-copied', saved: false }));
  }

  /**
   * Start a comment on the selection, or on the caret's line if nothing is
   * selected — an empty quote would give the thread no anchor to survive on.
   */
  function createCommentFromSelection(): void {
    // Menu events reach every window: `onMenuEvent` listens globally, and a
    // global listener's target is `Any`. That is harmless for idempotent
    // actions like theme or zoom, but this one creates a card — so without
    // this guard a single menu click would start a draft in every open
    // document. Focus is only knowable here, not in the Rust menu handler,
    // where the menu bar itself is what the OS considers active.
    //
    // The in-editor toolbar button calls `startCommentFromSelection` directly
    // instead: a click inside this window's own toolbar already says which
    // document is meant, and going through the guard would make the button
    // untestable under automation, where nothing holds OS focus.
    if (!document.hasFocus()) return;
    startCommentFromSelection();
  }

  /**
   * The actual work, with no focus guard — see `createCommentFromSelection`.
   *
   * `target` overrides the document selection. The live-render toolbar passes
   * one for text selected inside a table cell: that selection lives in the
   * widget's nested editing host, so `state.selection` knows nothing about it
   * and the range has been resolved back to the source by `cell-anchor.ts`
   * (#42).
   */
  function startCommentFromSelection(target?: { from: number; to: number }): void {
    const view = editorHandle?.view;
    if (!view || !fileState.filePath) return;
    const range = target ?? view.state.selection.main;
    const empty = range.from === range.to;
    const line = view.state.doc.lineAt(range.from);
    const raw = empty ? line.text : view.state.sliceDoc(range.from, range.to);
    const quote = raw.trim();
    if (!quote) return;

    // Exact document range of the quote. The quote is trimmed, so the range
    // has to skip the same leading whitespace — otherwise the highlight and
    // the stored context would both be off by the indentation of the line.
    const quoteFrom = (empty ? line.from : range.from) + (raw.length - raw.trimStart().length);
    const quoteTo = quoteFrom + quote.length;
    // Recorded now, while the exact position is known: after this the only way
    // back to it is a search, and a search needs something to disambiguate on.
    const context = anchorContextAt(view.state.doc.toString(), quoteFrom, quoteTo);

    commentDraftSeq += 1;
    const id = `draft:${commentDraftSeq}`;
    commentDrafts.set(id, { line: line.number, quote, context });
    view.dispatch({
      effects: addAiComment.of({
        thread: {
          // See the draft branch of `reloadComments`: a card being written is
          // paused, and says so.
          id,
          status: 'paused',
          line: line.number,
          quote,
          prefix: context.prefix,
          suffix: context.suffix,
          replies: [],
        },
        pos: quoteFrom,
        // A draft already knows its exact range — no quote search needed, and
        // the fragment gets highlighted from the moment the card appears.
        to: quoteTo,
        orphaned: false,
        actions: commentActions,
        // The point of the hotkey is to start writing. Leaving the caret in
        // the document means every comment costs an extra click (#22).
        focusAt: 0,
      }),
    });
  }

  // --- AI command handling (`mdmini show`/`edit`) ---
  interface AiResponse {
    ok: boolean;
    error?: string;
    changed_lines?: [number, number][];
    answer?: string;
    answers?: string[];
    custom?: string;
  }

  async function respondToAi(id: number, response: AiResponse): Promise<void> {
    await invoke('ai_respond', { id, response }).catch((err: unknown) => {
      console.error('Failed to respond to AI command:', err);
    });
  }

  /** Pulse is purely visual; clear it once its animation finishes unless a real
   * edit highlight has since taken its place — an edit's highlight must
   * outlive a pulse cleanup scheduled by an earlier `show`. */
  function schedulePulseCleanup(): void {
    setTimeout(() => {
      const view = editorHandle?.view;
      if (!view) return;
      if (aiHighlightRanges(view.state).length === 0) {
        view.dispatch({ effects: clearAiHighlights.of(null) });
      }
    }, 1600);
  }

  /** Invariant: the edit branch below must stay synchronous between reading
   * `view.state.doc` (via `computeReplacement`) and calling `view.dispatch` —
   * no `await` in between. Two AI edit commands delivered back-to-back would
   * otherwise both read the same pre-edit state and diff against it, and
   * whichever dispatches second would clobber the first's change instead of
   * building on top of it. */
  async function handleAiCommand(payload: AiCommandPayload): Promise<void> {
    // Before any of the command's own outcomes: an agent has reached this
    // install for the first time, and this is the one moment the user is
    // certain to be looking. Raised even if the command below then fails —
    // something visibly happened either way, and the point is to explain what.
    if (payload.firstUse) {
      toasts.push({ kind: 'ai-first-use' });
    }
    if (payload.path !== fileState.filePath) {
      await respondToAi(payload.id, { ok: false, error: 'window does not own this file' });
      return;
    }
    const view = editorHandle?.view;
    if (!view) {
      await respondToAi(payload.id, { ok: false, error: 'editor not ready' });
      return;
    }

    if (payload.cmd === 'show') {
      const pos = resolveShowTarget(view.state, { line: payload.line, find: payload.find });
      if (pos === null) {
        await respondToAi(payload.id, { ok: false, error: 'target not found' });
        return;
      }
      // Move the caret along with the view: otherwise it stays wherever it
      // was (often position 0 in a fresh window) and the next arrow key
      // snaps the view back there — reads as "cursor jumped to the top".
      view.dispatch({
        selection: { anchor: pos },
        effects: [EditorView.scrollIntoView(pos, { y: 'center' }), pulseAiLine.of(pos)],
      });
      schedulePulseCleanup();
      await respondToAi(payload.id, { ok: true });
      return;
    }

    if (payload.cmd === 'ask') {
      let pos: number;
      if (payload.line === null && payload.find === null) {
        pos = view.state.doc.length;
      } else {
        const resolved = resolveShowTarget(view.state, { line: payload.line, find: payload.find });
        if (resolved === null) {
          await respondToAi(payload.id, { ok: false, error: 'target not found' });
          return;
        }
        pos = resolved;
      }

      const askId = payload.id;
      const onAnswer = (
        answerId: number,
        result: string | string[] | { custom: string } | { answers: string[]; custom: string } | null
      ): void => {
        const currentView = editorHandle?.view;
        currentView?.dispatch({ effects: removeAiAsk.of(answerId) });
        if (result === null) {
          respondToAi(answerId, { ok: false, error: 'dismissed by user' });
        } else if (Array.isArray(result)) {
          respondToAi(answerId, { ok: true, answers: result });
        } else if (typeof result === 'string') {
          respondToAi(answerId, { ok: true, answer: result });
        } else if ('answers' in result) {
          respondToAi(answerId, { ok: true, answers: result.answers, custom: result.custom });
        } else {
          respondToAi(answerId, { ok: true, custom: result.custom });
        }
      };

      view.dispatch({
        // Caret follows the question's anchor for the same reason as `show`:
        // a later arrow key must not yank the view back to a stale caret.
        selection: { anchor: pos },
        effects: [
          addAiAsk.of({
            spec: {
              id: askId,
              question: payload.question ?? '',
              options: payload.options,
              multi: payload.multi,
              freeText: payload.freeText,
              onAnswer,
            },
            pos,
          }),
          EditorView.scrollIntoView(pos, { y: 'center' }),
        ],
      });

      // The Rust side owns the timeout/window-close deadline; this is only a
      // fallback to drop a widget the server has already stopped waiting on.
      // Answering after the server timeout is a harmless no-op there, and
      // removing an id the field no longer has is a no-op here too.
      setTimeout(
        () => {
          editorHandle?.view?.dispatch({ effects: removeAiAsk.of(askId) });
        },
        payload.timeoutSecs * 1000 + 2000
      );

      // The socket call is blocking on the user — respond only from the
      // button callbacks above, never immediately here.
      return;
    }

    // cmd === 'edit'
    const oldContent = view.state.doc.toString();
    const newContent = payload.content ?? '';
    const repl = computeReplacement(oldContent, newContent);
    if (!repl) {
      await respondToAi(payload.id, { ok: true, changed_lines: [] });
      return;
    }

    // Single-span diff, exactly mirroring Editor.svelte's updateContent: keeps
    // CM6's automatic selection mapping intact and preserves scroll position.
    const changes = ChangeSet.of(repl, view.state.doc.length);
    const scrollEffect = view.scrollSnapshot().map(changes);
    // The *change* is deliberately one coalescing span; the *highlight* is not.
    // Edits scattered across the file would otherwise wash everything between
    // the first and last of them (issue #27). Positions must be post-change,
    // since the highlight field reads effect values in the end state — hence
    // the diff runs against `newContent` rather than the live doc.
    const lineRanges = computeChangedLineRanges(oldContent, newContent);
    const highlightRanges = docRangesForLineRanges(Text.of(newContent.split('\n')), lineRanges);
    view.dispatch({
      changes,
      // With `show` the user is being led to the change — bring the caret
      // too (post-change coordinates), so arrow keys continue from there.
      ...(payload.show ? { selection: { anchor: repl.from } } : {}),
      effects: [
        ...(scrollEffect ? [scrollEffect] : []),
        setAiHighlights.of(highlightRanges),
        ...(payload.show ? [EditorView.scrollIntoView(repl.from, { y: 'center' })] : []),
      ],
      // Unlike an external-reload or an untitled-restore transaction, an AI
      // edit must stay undoable — it's a content change the user did not
      // author, and Cmd+Z is their way to reject it. No addToHistory(false)
      // annotation here (contrast Editor.svelte's updateContent).
    });
    // docChanged still fires the update listener (handleChange), which arms
    // dirty state + autosave — no separate call needed here.

    await respondToAi(payload.id, {
      ok: true,
      // A pure deletion produces no new lines to report, so fall back to the
      // single span's line (`view.state` is post-change after the dispatch).
      changed_lines: lineRanges.length > 0 ? lineRanges : [changedLineRanges(view.state, repl)],
    });
  }

  // --- Recovery save (every 5s if dirty) ---
  function startRecoveryInterval(): void {
    recoveryInterval = setInterval(() => {
      if (fileState.isDirty && fileState.filePath) {
        const content = editorHandle?.view?.state.doc.toString() ?? '';
        invoke('save_recovery', { path: fileState.filePath, content }).catch((err: unknown) => {
          console.error('Recovery save failed:', err);
        });
      }
      reportSession();
    }, 5000);
  }

  // --- Session heartbeat (rides the recovery interval) ---
  function topVisibleLine(): number {
    const view = editorHandle?.view;
    if (!view) return 1;
    // posAtCoords against the top edge of the scroller is stable across font
    // size and zoom changes, unlike a raw pixel offset.
    const rect = view.scrollDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 });
    if (pos === null) return 1;
    return view.state.doc.lineAt(pos).number;
  }

  function reportSession(): void {
    const view = editorHandle?.view;
    if (!view) return;
    invoke('update_session_document', {
      path: fileState.filePath,
      cursor: view.state.selection.main.head,
      topLine: topVisibleLine(),
      content: fileState.filePath ? null : view.state.doc.toString(),
    }).catch(() => {
      // Session tracking is best-effort; never surface it to the user.
    });
  }

  // --- Save on blur ---
  function handleWindowBlur(): void {
    if (fileState.isDirty && fileState.filePath) {
      performSave();
    }
    // Leaving md-mini ends every running comment pause on the spot.
    //
    // Two reasons, and the second is the load-bearing one. Someone who switches
    // away from a comment they were writing has almost always switched to the
    // agent they were writing it for, and sitting out the rest of the countdown
    // there helps nobody. And a window about to be closed or quit is usually
    // one that lost focus first — so this is the earliest of the several places
    // that keep a thread from staying `paused` with nobody left to un-pause it.
    // The later ones are in Rust (`CloseRequested`, `save_session_on_exit`),
    // and the last one is the deadline on the marker line, which needs no
    // process at all.
    commitAllCommentPauses();
  }

  onMount(() => {
    // Настоящее имя сборки в заголовок: у `dev:app` и `build:dev` оно другое,
    // и титлбар — единственное место, где человек видит, дев перед ним или
    // установленный релиз.
    getName()
      .then(setProductName)
      .catch(() => {});

    // Pull any file path stored by the backend for this window (CLI args or new-window open).
    // This avoids the race condition of the push-based emit approach.
    invoke<PendingOpen | null>('get_pending_file').then(async (pending) => {
      if (!pending) return;
      if (pending.path) {
        await handleOpenFilePath(pending.path);
      } else if (pending.content !== null) {
        // Restored Untitled window — no file on disk, just the buffer.
        editorHandle?.replaceContent(pending.content);
        fileState.isDirty = true;
      }
      if (pending.cursor > 0 || pending.topLine > 1) {
        await applyRestorePosition(pending.cursor, pending.topLine);
      }
    }).then(async () => {
      // Commands queued for this file before its window existed (e.g. an
      // `ai edit` of a file that wasn't open yet triggered this window's
      // creation) — drained once, after the pending-open/restore settles.
      const queued = await invoke<AiCommandPayload[]>('ai_pull_pending').catch(() => []);
      for (const command of queued) {
        await handleAiCommand(command);
      }
    });

    // Menu events
    const unlistenMenu = onMenuEvent((action) => {
      switch (action) {
        case 'new':
          handleNew();
          break;
        case 'open':
          handleOpen();
          break;
        case 'save':
          handleSave();
          break;
        case 'save_as':
          handleSaveAs();
          break;
        case 'select_all': {
          const view = editorHandle?.view;
          if (view) {
            view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
            view.focus();
          }
          break;
        }
        case 'find':
          handleFind();
          break;
        case 'toggle_mode':
          engine.cycle();
          break;
        case 'engine_raw':
          engine.set('raw');
          break;
        case 'engine_live_preview':
          engine.set('live-preview');
          break;
        case 'engine_live_render':
          engine.set('live-render');
          break;
        case 'zoom_in':
          zoom.zoomIn();
          break;
        case 'zoom_out':
          zoom.zoomOut();
          break;
        case 'zoom_reset':
          zoom.reset();
          break;
        case 'toggle_line_glow':
          lineGlow.toggle();
          break;
        case 'toggle_ocd_alignment:on':
          ocdAlignment.set(true);
          break;
        case 'toggle_ocd_alignment:off':
          ocdAlignment.set(false);
          break;
        case 'theme_family_classic':
          theme.setFamily('classic');
          break;
        case 'theme_family_aurora':
          theme.setFamily('aurora');
          break;
        case 'theme_family_blueprint':
          theme.setFamily('blueprint');
          break;
        case 'theme_family_phosphor':
          theme.setFamily('phosphor');
          break;
        case 'theme_half_light':
          theme.setHalf('light');
          break;
        case 'theme_half_dark':
          theme.setHalf('dark');
          break;
        case 'theme_system:on':
          theme.setFollowSystem(true);
          break;
        case 'theme_system:off':
          theme.setFollowSystem(false);
          break;
        case 'recent_files':
          showRecentFiles = true;
          break;
        case 'ai_comment':
          createCommentFromSelection();
          break;
        case 'ai_watch_command':
          copyWatchCommand();
          break;
        case 'format_json':
          // The native accelerator wins over the webview, so in the app this
          // is the path that actually runs for Cmd+Shift+J; the CM6 binding in
          // json-paste.ts covers the browser build of the same editor.
          if (document.hasFocus()) formatJson(false);
          break;
      }

      // macOS/muda toggles the clicked CheckMenuItem natively before this
      // handler runs. Re-clicking the already-active theme assigns the same
      // preference value, so the $effect below never reruns and the native
      // toggle leaves the submenu with nothing checked. Force a corrective
      // sync on every theme_* event, independent of whether the value changed.
      if (action.startsWith('theme_')) {
        syncThemeMenu(theme.resolved, theme.followSystem);
      }
      // Same correction, for the Editor Engine submenu — re-clicking the
      // already-active engine (or toggling Cmd+E onto an unchanged value)
      // would otherwise leave native's toggle uncorrected.
      if (action === 'toggle_mode' || action.startsWith('engine_')) {
        syncEngineMenu(engine.value);
      }
      // Тумблер приходит со своим значением, так что нативная отметка уже
      // верна; корректирующая синхронизация всё равно нужна, потому что
      // значение пишут все окна, а отметка одна.
      if (action.startsWith('toggle_ocd_alignment')) {
        syncOcdAlignmentMenu(ocdAlignment.enabled);
      }
    });

    const unlistenOpenFile = onOpenFile((path) => {
      handleOpenFilePath(path);
    });

    const unlistenExternalChange = onFileChangedExternally((path) => {
      handleExternalChange(path);
    });

    const unlistenAiCommand = onAiCommand((payload) => {
      handleAiCommand(payload);
    });

    // An agent appended a reply to this document's sidecar. Only the comment
    // cards are rebuilt — the document itself did not change, so nothing here
    // touches the buffer, the dirty flag, or autosave.
    const unlistenComments = onCommentsChanged(() => {
      void reloadComments();
    });

    // Drag & drop: open files dropped onto the window
    // If current window is empty (no file, no edits), open first file here; rest in new windows
    const unlistenDragDrop = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths as string[];
        let usedCurrentWindow = false;
        for (const path of paths) {
          if (!usedCurrentWindow && !fileState.filePath && !fileState.isDirty) {
            usedCurrentWindow = true;
            await handleOpenFilePath(path);
          } else {
            await invoke('open_file_window_cmd', { path }).catch((err: unknown) => {
              console.error('Failed to open dropped file:', err);
            });
          }
        }
      })
    );


    // Save on window blur
    window.addEventListener('blur', handleWindowBlur);

    // Start recovery interval
    startRecoveryInterval();

    // Check for updates: first after 15s, then every hour. Only one window
    // actually polls — startUpdateChecker is a no-op in the others.
    let stopUpdateChecker: (() => void) | null = null;
    import('./lib/updater').then(async ({ startUpdateChecker }) => {
      stopUpdateChecker = await startUpdateChecker();
    });

    // The notice itself is process-wide: Rust broadcasts a find to every window
    // and remembers dismissal, so it does not have to be closed window by window.
    invoke<UpdateInfo | null>('pending_update')
      .then((info) => {
        if (info) toasts.push({ kind: 'update', latest: info.latest, current: info.current, highlight: info.highlight });
      })
      .catch(() => {
        // Update notices are best-effort; never surface this.
      });

    const unlistenUpdateAvailable = onUpdateAvailable((info) => {
      toasts.push({ kind: 'update', latest: info.latest, current: info.current, highlight: info.highlight });
    });

    const unlistenUpdateDismissed = onUpdateDismissed(() => {
      toasts.dismissKind('update');
    });

    // Offer the previous session, but only in the window that exists at launch —
    // showing it in every window would be noise.
    import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (getCurrentWindow().label !== 'main') return;
      const count = await invoke<number>('pending_session_count').catch(() => 0);
      if (count > 0) {
        toasts.push({ kind: 'session', count });
      }

      // Same "launch window only" rule, same reason. Rust owns the whole
      // decision — whether an agent has ever connected, how often this has
      // already been shown, and whether the welcome window beat us to it.
      const nudge = await invoke<boolean>('ai_nudge_pending').catch(() => false);
      if (nudge) {
        toasts.push({ kind: 'ai-nudge' });
      }

      // «У нас есть темы» — один раз за установку, в том же окне запуска.
      //
      // Тем стало четыре, и живут они в меню, которое человек открывает
      // примерно никогда: без этого про них знал бы только тот, кто их
      // добавил. Ключ ставится до показа, а не после закрытия: тост ничего не
      // делает, кроме как называет меню, и «показали, но не досмотрел» —
      // не повод показывать снова.
      try {
        if (!localStorage.getItem('md-mini:themesNudgeSeen')) {
          localStorage.setItem('md-mini:themesNudgeSeen', '1');
          toasts.push({ kind: 'themes-nudge' });
        }
      } catch {
        /* приватное окно — лучше не показать, чем показывать каждый запуск */
      }
    });

    const unlistenSessionRestored = onSessionRestored(() => {
      toasts.dismissKind('session');
    });

    // Register this window in the session right away, not 5s later.
    reportSession();

    return () => {
      if (stopUpdateChecker) stopUpdateChecker();
      unlistenMenu.then((fn) => fn());
      unlistenOpenFile.then((fn) => fn());
      unlistenExternalChange.then((fn) => fn());
      unlistenAiCommand.then((fn) => fn());
      unlistenComments.then((fn) => fn());
      unlistenDragDrop.then((fn) => fn());
      unlistenSessionRestored.then((fn) => fn());
      unlistenUpdateAvailable.then((fn) => fn());
      unlistenUpdateDismissed.then((fn) => fn());
      window.removeEventListener('blur', handleWindowBlur);
      if (autoSaveTimer !== null) clearTimeout(autoSaveTimer);
      if (recoveryInterval !== null) clearInterval(recoveryInterval);
      clearAiHintTimer();
    };
  });

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme.resolved);
    reinitializeTheme();
  });

  // Separate effect on purpose, and it reads `resolved` rather than the raw
  // choice: with «система» отмеченной половину выбирает ОС, и галочка в меню
  // должна стоять на той, что действительно на экране. Its first run on mount
  // is the startup sync.
  $effect(() => {
    syncThemeMenu(theme.resolved, theme.followSystem);
  });

  // Startup sync for the Editor Engine submenu and the OCD checkbox,
  // mirroring the theme effect above.
  $effect(() => {
    syncEngineMenu(engine.value);
  });
  $effect(() => {
    syncOcdAlignmentMenu(ocdAlignment.enabled);
  });

  $effect(() => {
    document.documentElement.toggleAttribute('data-ocd', ocdAlignment.enabled);
  });

  $effect(() => {
    const title = fileState.title;
    document.title = title;
    // Sync to native Tauri window title bar
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().setTitle(title);
    });
  });

  // Reconfigure line glow when toggled
  $effect(() => {
    const view = editorHandle?.view;
    if (!view) return;
    view.dispatch({
      effects: lineGlowCompartment.reconfigure(
        lineGlow.enabled ? highlightActiveLine() : []
      ),
    });
  });

  // Reconfigure the preview compartment on engine change (Cmd+E, or a direct
  // Editor Engine menu pick) and on file-type change.
  //
  // Two independent axes, and the precedence between them must be explicit:
  //
  // 1. `raw` wins over everything. It switched off decorations for EVERY file
  //    type before this axis existed (.env and shell configs included), and it
  //    still does — that is the user's escape hatch out of any rendering, and
  //    narrowing it to markdown would be a regression.
  // 2. Otherwise the file type owns the plugin choice: .env, shell and code
  //    files keep their own preview plugin and ignore the flavour, which only
  //    means anything for markdown.
  // 3. Markdown picks its plugin plus the flavour facet.
  /**
   * Put the preview compartment into the shape the current engine and file
   * type call for.
   *
   * Called both from the `$effect` below and imperatively after a file opens,
   * because `Editor.svelte`'s `setCodeMode`/`setEnvMode` reconfigure the SAME
   * compartment — and its markdown branch installs a bare `livePreviewPlugin`
   * with no flavour facet and no live-render bundle. `handleOpenFilePath`
   * calls `setCodeMode(null)` for every markdown file, so on a freshly opened
   * window it wiped whatever this effect had just installed: live-render was
   * dead until the engine was toggled by hand, which re-ran the effect. Two
   * owners of one compartment, and this one is authoritative.
   */
  function applyPreviewConfig(): void {
    const e = engine.value;
    const v = editorHandle?.view;
    if (!v) return;

    // Folds are a preview-mode affordance: their only indicator is the
    // heading line decoration, which the reconfigure below removes. Left
    // folded, a Raw document silently hides the sections the user went to Raw
    // to read. Unfold on the way in, refold on the way out.
    if (e === 'raw') {
      stashAndUnfoldAll(v);
      v.dispatch({ effects: previewCompartment.reconfigure([]) });
      return;
    }
    restoreStashedFolds(v);

    if (activePreview !== 'markdown') {
      const plugin = activePreview === 'shell' ? shellSecretsPlugin
        : activePreview === 'env' ? envPreviewPlugin
        : []; // 'code'
      v.dispatch({ effects: previewCompartment.reconfigure(plugin) });
      return;
    }

    // Both rendering engines run `livePreviewPlugin` and differ in the flavour
    // the facet supplies. live-render additionally installs its own bundle —
    // atomic markers, the block-format Backspace, inline continuation, the
    // selection toolbar and the inspector. None of that is present in the
    // live-preview state, so that mode cannot be affected by it.
    const liveRender = e === 'live-render';
    v.dispatch({
      effects: previewCompartment.reconfigure([
        livePreviewPlugin,
        flavourFacet.of(liveRender ? LIVE_RENDER : LIVE_PREVIEW),
        // The toolbar's comment button reaches the same code path as the menu
        // item, minus the focus guard: a click in this window's own toolbar is
        // unambiguous about which document is meant.
        ...(liveRender
          ? liveRenderExtensions({ onComment: (range) => startCommentFromSelection(range) })
          : []),
      ]),
    });
  }

  $effect(() => {
    // Read both dependencies unconditionally so the effect re-runs on either.
    void engine.value;
    void editorHandle?.view;
    void activePreview;
    applyPreviewConfig();
  });

  // Keep the editor's idea of which file it holds in step with the store.
  //
  // An effect rather than a call inside `handleOpen`, because the path also
  // changes on Save As and on New, and the JSON formatter's fence decision has
  // to be right immediately in all three — a stale path here means a ```
  // line offered into a `.py` buffer.
  $effect(() => {
    const path = fileState.filePath;
    void editorHandle?.view;
    editorHandle?.setDocumentPath(path ?? null);
  });
</script>

<!-- Масштаб применяется зумом страницы webview, а не каскадом `font-size` —
     см. `lib/window-zoom.ts`. Атрибут ничего не масштабирует: это проба,
     по которой уровень видно в DOM (и в браузерном тесте) без IPC. -->
<main data-zoom={zoom.level}>
  <Editor
    bind:handle={editorHandle}
    onchange={handleChange}
    onAiHighlightVisibilityChange={handleAiHighlightVisibilityChange}
    onJsonOffer={() => toasts.push({ kind: 'json-offer' })}
    onJsonOfferWithdrawn={() => toasts.dismissKind('json-offer')}
  />
</main>

<AiHintBadge visible={showAiHint} />

<AiBindButton onclick={copyBindPrompt} />

{#if showRecentFiles}
  <RecentFilesPanel
    files={recentFiles.list}
    onopen={handleOpenFilePath}
    onclose={() => { showRecentFiles = false; }}
  />
{/if}

<ToastStack
  store={toasts}
  onFormatJson={() => formatJson(true)}
  onDismiss={(entry) => {
    // Closing the update notice closes it everywhere, not just here.
    if (entry.payload.kind === 'update') {
      invoke('dismiss_update').catch(() => {});
    }
    // Closing the AI nudge retires it permanently — it has had its say.
    if (entry.payload.kind === 'ai-nudge') {
      invoke('ai_nudge_dismiss').catch(() => {});
    }
  }}
/>

<style>
  main {
    height: 100vh;
    width: 100vw;
  }
</style>
