<script lang="ts">
  import { onMount } from 'svelte';
  import Editor from './lib/editor/Editor.svelte';
  import type { EditorHandle } from './lib/editor/Editor.svelte';
  import { createThemeStore, createEngineStore, createZoomStore, createLineGlowStore, createFileState, createRecentFilesStore } from './lib/stores.svelte';
  import { readFile, writeFile, fileExists, showOpenDialog, showSaveDialog, syncThemeMenu, syncEngineMenu, syncBetaInCycleMenu, commentThreads, commentCreate, commentReply, commentResolve, type PendingOpen } from './lib/tauri/commands';
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
  import { createToastStore } from './lib/toasts.svelte';
  import { shouldShowHint, nextCheckDelay } from './lib/ai-hint';
  import { previewCompartment, lineGlowCompartment } from './lib/editor/setup';
  import { EditorView, highlightActiveLine } from '@codemirror/view';
  import { ChangeSet, type StateEffect } from '@codemirror/state';
  import { livePreviewPlugin } from './lib/editor/preview/plugin';
  import { LIVE_PREVIEW, LIVE_RENDER, flavourFacet } from './lib/editor/preview/flavour';
  import { liveRenderExtensions } from './lib/editor/live-render';
  import { envPreviewPlugin } from './lib/editor/preview/env';
  import { shellSecretsPlugin } from './lib/editor/preview/shell-secrets';
  import { isShellConfig } from './lib/editor/file-language';
  import { reinitializeTheme } from './lib/editor/preview/mermaid';
  import { computeReplacement } from './lib/editor/content-diff';
  import { resolveShowTarget, changedLineRanges } from './lib/ai-commands';
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
    type CommentActions,
  } from './lib/editor/ai-comment';
  import { anchorPosition, buildHandoffPrompt, buildWatchPrompt } from './lib/comment-format';
  import './lib/theme/dark.css';
  import './lib/theme/light.css';
  import './lib/theme/aurora-dark.css';
  import './lib/theme/aurora-light.css';
  import './styles/global.css';
  import './styles/editor.css';

  const theme = createThemeStore();
  const engine = createEngineStore();
  const zoom = createZoomStore();
  const lineGlow = createLineGlowStore();
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
      // Clean up recovery file on successful save
      await invoke('delete_recovery', { path: fileState.filePath }).catch(() => {});
    } catch (err) {
      console.error('Auto-save failed:', err);
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

  const MD_EXTENSIONS = new Set(['md', 'markdown', 'txt', '']);

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
      } else if (!MD_EXTENSIONS.has(ext)) {
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
  let commentDrafts = new Map<string, { line: number; quote: string }>();
  let commentDraftSeq = 0;

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
    const effects: StateEffect<unknown>[] = [clearAiComments.of(null)];
    for (const thread of threads) {
      if (thread.status === 'resolved') continue;
      const { pos, to, orphaned } = anchorPosition(doc, thread.quote, thread.line);
      effects.push(addAiComment.of({ thread, pos, to, orphaned, actions: commentActions }));
    }
    // Drafts are not in the file, so a reload would otherwise silently discard
    // half-typed comments — re-add them on top.
    for (const [id, draft] of commentDrafts) {
      const { pos, to, orphaned } = anchorPosition(doc, draft.quote, draft.line);
      effects.push(
        addAiComment.of({
          thread: { id, status: 'open', line: draft.line, quote: draft.quote, replies: [] },
          pos,
          to,
          orphaned,
          actions: commentActions,
        })
      );
    }
    view.dispatch({ effects });
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
    reply: (id, text) => {
      const path = fileState.filePath;
      if (!path) return;
      const draft = commentDrafts.get(id);
      if (draft) {
        // First text on a draft is what creates the thread in the file.
        commentDrafts.delete(id);
        void commentCreate(path, draft.line, draft.quote, text).then(async () => {
          // The sidecar has only just come into existence, so the watcher armed
          // when this document was opened isn't watching it yet. Re-registering
          // the file rebuilds the watcher over both paths — otherwise the very
          // first agent reply would arrive with nothing listening for it.
          await invoke('register_open_file', { path }).catch(() => {});
          await reloadComments();
        });
        return;
      }
      void commentReply(path, id, text).then(reloadComments);
    },
    resolve: (id) => {
      const path = fileState.filePath;
      if (!path) return;
      if (commentDrafts.delete(id)) {
        // Nothing was ever written; just drop the card.
        void reloadComments();
        return;
      }
      void commentResolve(path, id).then(reloadComments);
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
    const quote = empty
      ? line.text.trim()
      : view.state.sliceDoc(range.from, range.to).trim();
    if (!quote) return;

    commentDraftSeq += 1;
    const id = `draft:${commentDraftSeq}`;
    commentDrafts.set(id, { line: line.number, quote });
    view.dispatch({
      effects: addAiComment.of({
        thread: { id, status: 'open', line: line.number, quote, replies: [] },
        pos: range.from,
        // A draft already knows its exact range — no quote search needed, and
        // the fragment gets highlighted from the moment the card appears.
        to: empty ? line.to : range.to,
        orphaned: false,
        actions: commentActions,
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
    const repl = computeReplacement(view.state.doc.toString(), payload.content ?? '');
    if (!repl) {
      await respondToAi(payload.id, { ok: true, changed_lines: [] });
      return;
    }

    // Single-span diff, exactly mirroring Editor.svelte's updateContent: keeps
    // CM6's automatic selection mapping intact and preserves scroll position.
    const changes = ChangeSet.of(repl, view.state.doc.length);
    const scrollEffect = view.scrollSnapshot().map(changes);
    const highlightRange = { from: repl.from, to: repl.from + repl.insert.length };
    view.dispatch({
      changes,
      // With `show` the user is being led to the change — bring the caret
      // too (post-change coordinates), so arrow keys continue from there.
      ...(payload.show ? { selection: { anchor: repl.from } } : {}),
      effects: [
        ...(scrollEffect ? [scrollEffect] : []),
        setAiHighlights.of([highlightRange]),
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
      changed_lines: [changedLineRanges(view.state, repl)],
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
  }

  onMount(() => {
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
        case 'toggle_beta_in_cycle':
          engine.toggleBetaInCycle();
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
        case 'theme_light':
          theme.preference = 'light';
          break;
        case 'theme_dark':
          theme.preference = 'dark';
          break;
        case 'theme_aurora_light':
          theme.preference = 'aurora-light';
          break;
        case 'theme_aurora_dark':
          theme.preference = 'aurora-dark';
          break;
        case 'theme_system':
          theme.preference = 'system';
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
      }

      // macOS/muda toggles the clicked CheckMenuItem natively before this
      // handler runs. Re-clicking the already-active theme assigns the same
      // preference value, so the $effect below never reruns and the native
      // toggle leaves the submenu with nothing checked. Force a corrective
      // sync on every theme_* event, independent of whether the value changed.
      if (action.startsWith('theme_')) {
        syncThemeMenu(theme.preference);
      }
      // Same correction, for the Editor Engine submenu — re-clicking the
      // already-active engine (or toggling Cmd+E onto an unchanged value)
      // would otherwise leave native's toggle uncorrected.
      if (action === 'toggle_mode' || action.startsWith('engine_')) {
        syncEngineMenu(engine.value);
      }
      if (action === 'toggle_beta_in_cycle') {
        syncBetaInCycleMenu(engine.betaInCycle);
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

  // Separate effect on purpose: it depends on `preference` (not `resolved`),
  // and its first run on mount is the startup sync.
  $effect(() => {
    syncThemeMenu(theme.preference);
  });

  // Startup sync for the Editor Engine submenu + beta-cycle checkbox,
  // mirroring the theme effect above.
  $effect(() => {
    syncEngineMenu(engine.value);
  });
  $effect(() => {
    syncBetaInCycleMenu(engine.betaInCycle);
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

    if (e === 'raw') {
      v.dispatch({ effects: previewCompartment.reconfigure([]) });
      return;
    }

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
</script>

<main style="font-size: {zoom.level}rem;">
  <Editor
    bind:handle={editorHandle}
    onchange={handleChange}
    onAiHighlightVisibilityChange={handleAiHighlightVisibilityChange}
  />
</main>

<AiHintBadge visible={showAiHint} />

{#if showRecentFiles}
  <RecentFilesPanel
    files={recentFiles.list}
    onopen={handleOpenFilePath}
    onclose={() => { showRecentFiles = false; }}
  />
{/if}

<ToastStack
  store={toasts}
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
