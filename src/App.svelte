<script lang="ts">
  import { onMount } from 'svelte';
  import Editor from './lib/editor/Editor.svelte';
  import type { EditorHandle } from './lib/editor/Editor.svelte';
  import type { ViewUpdate } from '@codemirror/view';
  import { isHumanEdit } from './lib/editor/human-edit';
  import { createThemeStore, createEngineStore, createZoomStore, createLineGlowStore, createOcdAlignmentStore, createTabsCompactStore, createTransientPolicyStore, createFileState, createRecentFilesStore, setProductName, setWindowNumber, getWindowNumber } from './lib/stores.svelte';
  import { getName } from '@tauri-apps/api/app';
  import { readDocument, writeDocument, fileExists, showOpenDialog, showSaveDialog, syncThemeMenu, syncDockIcon, syncEngineMenu, syncOcdAlignmentMenu, broadcastTheme, syncTabsCompactMenu, syncTransientMenu, commentThreads, commentStart, commentResolve, commentWriteReply, commentCommit, type TabClaim, type WindowInit } from './lib/tauri/commands';
  import { concreteTheme, halfOf, type ThemeFamily } from './lib/theme-resolve';
  import type { ThemeControl } from './lib/editor/slash-theme';
  import {
    onMenuEvent,
    onOpenFile,
    onReopenTab,
    onTabsArrive,
    onWindowNumber,
    onFileChangedExternally,
    onSessionRestored,
    onRecentChanged,
    onUpdateAvailable,
    onUpdateDismissed,
    onCheckUpdatesRequested,
    onLanguageChangeFailed,
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
  import TabDrawer from './lib/tabs/TabDrawer.svelte';
  import TransientBar from './lib/tabs/TransientBar.svelte';
  import type { TabDrawerHandle } from './lib/tabs/TabDrawer.svelte';
  import type { GitInfo } from './lib/tabs/drawer-data';
  import { tabNames } from './lib/tabs/tab-name';
  import { createToastStore, type ToastPayload } from './lib/toasts.svelte';
  import {
    WINDOW_NUMBER_TOAST_MS,
    ctrlDigitHandler,
    renumberWindow,
    type RenumberResult,
    type RevealResult,
  } from './lib/tabs/window-number';
  import { ctrlTabHandler } from './lib/tabs/tab-cycle-keys';
  import { shouldShowHint, nextCheckDelay } from './lib/ai-hint';
  import { previewCompartment, lineGlowCompartment } from './lib/editor/setup';
  import { stashAndUnfoldAll, restoreStashedFolds } from './lib/editor/fold-memory';
  import { EditorView, highlightActiveLine } from '@codemirror/view';
  import type { StateEffect } from '@codemirror/state';
  import { livePreviewPlugin } from './lib/editor/preview/plugin';
  import { LIVE_PREVIEW, LIVE_RENDER, flavourFacet } from './lib/editor/preview/flavour';
  import { liveRenderExtensions } from './lib/editor/live-render';
  import { envPreviewPlugin } from './lib/editor/preview/env';
  import { shellSecretsPlugin } from './lib/editor/preview/shell-secrets';
  import { findCodeLanguage, previewKindFor } from './lib/editor/file-language';
  import { reinitializeTheme } from './lib/editor/preview/mermaid';
  import { resolveExternalChange } from './lib/external-change';
  import { createAutoSaveScheduler } from './lib/autosave';
  import { resolveShowTarget, buildAiEdit, aiEditTransaction } from './lib/ai-commands';
  import { normalizeLineEndings, type LineEnding } from './lib/line-endings';
  import { canAutoSave, lineEndingAfterExternalChange, reloadRetryDelay } from './lib/document-sync';
  import {
    setAiHighlights,
    pulseAiLine,
    clearAiHighlights,
    aiHighlightRanges,
  } from './lib/editor/ai-highlight';
  import { activeAskIds, addAiAsk, removeAiAsk } from './lib/editor/ai-ask';
  import type { TabOwner } from './lib/switch-document';
  import { activeCellEditSession } from './lib/editor/cell-edit-session';
  import { closeSearchPanel } from '@codemirror/search';
  import { hideHoverMenu } from './lib/editor/hover-menu';
  import { createTabController, type DiskOptions, type MoveDone, type OpenAnswer, type Stranded } from './lib/tabs/controller';
  import { AGENT_ERRORS, createAgentCommands, type AgentResponse, type AskResult } from './lib/tabs/agent-commands';
  import { createTypingTracker } from './lib/tabs/typing';
  import { emptyTabList, type TabListState } from './lib/tabs/tab-model';
  import type { CarouselWindow, MoveTarget } from './lib/tabs/carousel';
  import { stripLeavingState } from './lib/tabs/tab-cache';
  import { decideSaveAs } from './lib/tabs/save-as';
  import { createCommentWriter, adoptStartedDraft } from './lib/comment-writer';
  import {
    addAiComment,
    aiCommentField,
    clearAiComments,
    CommentWidget,
    COMMENT_IDLE,
    COMMENT_SEND_LABEL,
    COMMENT_SENDING,
    commentSendText,
    commentSendingText,
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
  import { t } from './lib/i18n';
  import './lib/theme/dark.css';
  import './lib/theme/light.css';
  import './lib/theme/aurora-dark.css';
  import './lib/theme/aurora-light.css';
  // Обе половины в одном файле — семья описана целиком в одном месте.
  import './lib/theme/blueprint.css';
  import './lib/theme/phosphor.css';
  import './lib/theme/paper.css';
  import './lib/theme/ink.css';
  import './lib/theme/riso.css';
  import './styles/global.css';
  import './styles/editor.css';
  import './styles/tabs.css';

  const theme = createThemeStore();
  const engine = createEngineStore();

  /**
   * Bridges `/theme` and `/tone` (which cannot import the theme store
   * directly — see `EditorDeps` in `lib/editor/setup.ts`) to it.
   *
   * Each commit mirrors what the matching native Theme-menu click already
   * does in this file's `menu-event` handler below: write the choice,
   * correct the native menu's checkmarks, and broadcast to every other
   * window over the same `menu-event` path (`broadcast_theme` in
   * commands.rs), so two windows never end up on different themes after a
   * picker closes. `commitFamily` and `commitTone` each touch only the one
   * thing their own picker owns — a family choice never changes the tone or
   * "Follow System", and a tone choice never changes the family.
   */
  const themeControl: ThemeControl = {
    get current() {
      return theme.resolved;
    },
    get followSystem() {
      return theme.followSystem;
    },
    previewFamily(family: ThemeFamily | null) {
      if (family === null) {
        theme.setPreview(null);
      } else {
        // Same tone that is already on screen — a family preview must never
        // move the brightness (that split is the whole point of `/theme`
        // vs. `/tone`), whether that tone came from an explicit choice or
        // from "Follow System".
        theme.setPreview(concreteTheme(family, halfOf(theme.resolved)));
      }
    },
    commitFamily(family: ThemeFamily) {
      theme.setPreview(null);
      theme.setFamily(family);
      syncThemeMenu(theme.resolved, theme.followSystem);
      broadcastTheme({ family });
    },
    commitTone(tone: 'light' | 'dark' | 'system') {
      if (tone === 'system') {
        theme.setFollowSystem(true);
      } else {
        theme.setHalf(tone);
      }
      syncThemeMenu(theme.resolved, theme.followSystem);
      broadcastTheme(tone === 'system' ? { followSystem: true } : { half: tone });
    },
  };

  const zoom = createZoomStore();
  const lineGlow = createLineGlowStore();
  const ocdAlignment = createOcdAlignmentStore();
  const tabsCompact = createTabsCompactStore();
  const transientPolicy = createTransientPolicyStore();
  const fileState = createFileState();
  const recentFiles = createRecentFilesStore();
  const toasts = createToastStore();

  let showRecentFiles = $state(false);
  let activePreview: 'markdown' | 'env' | 'code' | 'shell' = $state('markdown');
  // This window's tabs, for the drawer. The controller owns the truth; this
  // is its last published copy.
  let tabList = $state<TabListState>(emptyTabList());
  // The bar shows while the active tab is a quick look (spec §7).
  const activeQuickLook = $derived(
    tabList.tabs.find((tab) => tab.id === tabList.activeId)?.transient === true ? tabList.activeId : null
  );

  let editorHandle: EditorHandle | undefined = $state(undefined);
  let drawerHandle: TabDrawerHandle | undefined = $state(undefined);

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
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Disk baseline: content as we last read it from, or wrote it to, disk.
  // An FSEvent whose content still matches this is our own write echoing back,
  // not an external change — see `resolveExternalChange`.
  let diskBaseline: string | null = null;
  // Disk content the user already said No to reloading; a repeated FSEvent for
  // the same bytes must not ask again.
  let dismissedDisk: string | null = null;
  // The in-flight save, if any. External-change handling awaits it first, so
  // it always compares against the disk state the save actually produced.
  let currentSave: Promise<void> | null = null;
  // Bumped at the start of every `doSave`, so a reader can tell whether a save
  // landed while it was mid-await (e.g. mid-`readDocument`) even though by the
  // time it checks `currentSave` is already back to null.
  let saveGeneration = 0;
  // Coalesces external-change events that arrive while the conflict dialog is
  // already up (FSEvents can fire more than once for one write).
  let conflictDialogOpen = false;
  // The last read of this window's file failed while the file still existed
  // (a non-atomic writer caught mid-write, invalid UTF-8, permissions). Until a
  // read succeeds, disk holds a version the window has never seen, so
  // automatic saves are paused — see `canAutoSave`. The watcher's leading-edge
  // debounce may drop the follow-up event, so the read is retried on a timer.
  let diskUnreadable = false;
  let reloadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadRetryAttempt = 0;

  function saveGate() {
    return {
      isDirty: fileState.isDirty,
      filePath: fileState.filePath,
      conflictDialogOpen,
      diskUnreadable,
    };
  }

  /** The file could not be re-read: pause autosave, say so, try again later. */
  function markDiskUnreadable(path: string, err: unknown): void {
    diskUnreadable = true;
    console.error('Reload failed:', err);
    toasts.push({
      kind: 'reload-error',
      fileName: path.split('/').pop() ?? path,
      message: err instanceof Error ? err.message : String(err),
    });
    if (reloadRetryTimer !== null) clearTimeout(reloadRetryTimer);
    reloadRetryTimer = setTimeout(() => {
      reloadRetryTimer = null;
      void handleExternalChange(path);
    }, reloadRetryDelay(reloadRetryAttempt++));
  }

  /**
   * Disk and window agree again — a read succeeded, a save landed, or the
   * window moved on to another file. Returns whether autosave had been paused.
   */
  function endDiskUnreadable(): boolean {
    const was = diskUnreadable;
    diskUnreadable = false;
    reloadRetryAttempt = 0;
    if (reloadRetryTimer !== null) {
      clearTimeout(reloadRetryTimer);
      reloadRetryTimer = null;
    }
    toasts.dismissKind('reload-error');
    return was;
  }

  function handleChange(_doc: string, update: ViewUpdate) {
    fileState.isDirty = true;
    autoSave.schedule();
    // Editing a quick look is working in it: «Оставить» (spec §7).
    if (isHumanEdit(update)) tabs.humanEdited();
  }

  // --- Auto-save (300ms debounce). `performSave` is declared below, but
  // `function` declarations are hoisted, so referencing it here is safe. ---
  const autoSave = createAutoSaveScheduler({
    delayMs: 300,
    // Not while the conflict dialog is up (its "Yes" re-reads the disk state
    // it is asking about) and not while the file is unreadable (the unread
    // version would be overwritten) — see `canAutoSave`.
    shouldSave: () => canAutoSave(saveGate()),
    save: performSave,
  });

  async function performSave(): Promise<void> {
    if (!fileState.filePath) return;
    // Serialize saves: two overlapping atomic writes can land in either order,
    // which would desync the baseline from what disk actually ends up holding.
    // A loop, not a single await — another save can start between the await
    // resolving and `currentSave = save` below, and this must wait for that
    // one too.
    while (currentSave) await currentSave.catch(() => {});

    const save = doSave(fileState.filePath);
    currentSave = save;
    try {
      await save;
    } finally {
      if (currentSave === save) currentSave = null;
    }
  }

  async function doSave(path: string): Promise<void> {
    saveGeneration += 1;
    // `content` stays LF: it is what the buffer holds, so it is also what the
    // dirty check and the disk baseline below compare against. Only the bytes
    // that reach the disk carry the file's own line ending.
    const content = editorHandle?.view?.state.doc.toString() ?? '';
    const lineEnding = fileState.lineEnding;
    try {
      await writeDocument(path, content, lineEnding);
      // A window can switch to a different file (Cmd+O) while this write is
      // in flight; the bookkeeping below belongs to `path`, not to whatever
      // file the window holds by the time the write resolves.
      if (fileState.filePath === path) {
        // Only clear dirty if the buffer still reads exactly what was
        // written — keystrokes typed during the write are not covered by it
        // and must stay unsaved, or the next external-change check would
        // read the file as clean and silently discard them on reload.
        if (editorHandle?.view?.state.doc.toString() === content) {
          fileState.isDirty = false;
        }
        fileState.lastSavedAt = Date.now();
        // A landed save supersedes any earlier "No" — the disk state the user
        // declined no longer exists.
        diskBaseline = content;
        dismissedDisk = null;
        // A previous failure is over the moment a save lands.
        toasts.dismissKind('save-error');
        toasts.dismissKind('unsaved-blocked');
        // So is an unreadable disk: it now holds exactly what we wrote. Only
        // an explicit ⌘S gets here while it was paused.
        endDiskUnreadable();
      }
      // Clean up recovery file on successful save
      await invoke('delete_recovery', { path }).catch(() => {});
    } catch (err) {
      // `isDirty` deliberately stays true: the document is still unsaved, so
      // the next keystroke reschedules a save and the recovery snapshot keeps
      // being written. Until #18 this branch was a `console.error` and nothing
      // else — a file the filesystem refused to replace went on looking saved
      // while the user kept typing into it.
      console.error('Auto-save failed:', err);
      toasts.push({
        kind: 'save-error',
        fileName: path.split('/').pop() ?? path,
        message: err instanceof Error ? err.message : String(err),
      });
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
      : t('ui.untitled_filename');
    // The dialog holds back the human, not an agent: a tab switch can land
    // while it is open, and the name picked belongs to the tab it was opened
    // for. The tab queue is not held meanwhile — agents keep working.
    const tabId = tabs.list.activeId;
    const path = await showSaveDialog(name);
    if (!path) return;
    const fileName = path.split('/').pop() ?? path;
    await tabs.runExclusive(async () => {
      if (tabId === null || !tabs.list.tabs.some((tab) => tab.id === tabId)) {
        toasts.push({ kind: 'save-as-blocked', fileName, reason: 'tab-gone' });
        return;
      }
      if (tabs.list.activeId !== tabId) {
        // The human's choice wins over the agent's switch. A refusal has
        // already said why (unsaved-blocked, save-error, open-error).
        if ((await tabs.activateNow(tabId)) !== 'ok') return;
      }
      // Claimed before anything is written: the tab must own `path` first, or
      // a file another tab holds ends up in two autosaving editors.
      const claim = await invoke<TabClaim>('tab_claim', { tabId, path }).catch((err: unknown) => {
        console.error('tab_claim failed:', err);
        return null;
      });
      const step = decideSaveAs(claim, path);
      if (step.kind === 'blocked') {
        toasts.push({ kind: 'save-as-blocked', fileName, reason: step.reason });
        if (step.focusOtherWindow) {
          await invoke('focus_if_open', { path }).catch(logTabIpc('focus_if_open'));
        }
        return;
      }
      fileState.filePath = step.path;
      tabs.renameActive(step.path);
      await performSave();
      // The claim pointed the watcher at the path before the save created it,
      // and a file that does not exist yet is not watched.
      await invoke('tab_activate', { tabId }).catch(logTabIpc('tab_activate'));
      recentFiles.add(step.path);
    });
  }

  async function handleOpen(): Promise<void> {
    const path = await showOpenDialog();
    if (!path) return;
    await openTab(path);
  }

  /**
   * Say that a document could not be opened. Until this, every such failure
   * was a `console.error` — which meant an empty Untitled window and no hint
   * that a file had been asked for at all.
   */
  function reportOpenError(path: string, err: unknown): void {
    console.error('Open failed:', err);
    toasts.push({
      kind: 'open-error',
      fileName: path.split('/').pop() ?? path,
      message: err instanceof Error ? err.message : String(err),
    });
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

  /**
   * Say why a switch or close did nothing when the buffer it would have left
   * is still not on disk.
   *
   * With the conflict dialog up there is nothing to add — the dialog is the
   * reason, and it is on screen. A real write failure already has its own
   * `save-error` toast with the OS's message, and a file that could not be
   * re-read its `reload-error` one. What is left is a save that has simply not
   * landed yet.
   */
  function reportSwitchBlockedByUnsaved(): void {
    // An unreadable disk has its own standing toast, which says ⌘S.
    if (conflictDialogOpen || diskUnreadable || toasts.hasKind('save-error')) return;
    const path = fileState.filePath ?? '';
    toasts.push({ kind: 'unsaved-blocked', fileName: path.split('/').pop() ?? path });
  }

  /**
   * Write every comment box typed into for `path` now, before the window
   * stops showing it.
   *
   * The debounced write would otherwise fire after the switch — and a draft,
   * whose anchor lives only in `commentDrafts`, would then reach the sidecar
   * as a reply to a thread that does not exist, losing the text. Returns
   * whether everything typed is now on disk; a failure has already raised the
   * `comment-error` toast.
   */
  async function flushCommentsFor(path: string): Promise<boolean> {
    for (const [id, entry] of [...commentPending]) {
      if (entry.path === path) await writeComment(id);
    }
    return ![...commentPending.values()].some(
      (e) => e.path === path && e.text.trim() !== '' && e.text !== e.saved
    );
  }

  /** Drop the app-side comment state of `path` once its pauses are committed. */
  function forgetCommentsFor(path: string): void {
    for (const [id, entry] of [...commentPending]) {
      if (entry.path === path) forgetCommentPending(id);
    }
    for (const [id, entry] of [...commentCountdowns]) {
      if (entry.path === path) disarmCommentCountdown(id);
    }
    // A different document means different comments; drafts belonged to the
    // file we just left and must not reappear anchored in this one.
    commentDrafts = new Map();
    commentEditable = new Map();
    commentFocus = null;
  }

  /** Make `path` the active document for every singleton that follows the active tab. */
  function setActiveDocument(
    path: string | null,
    dirty: boolean,
    baseline: string | null,
    lineEnding: LineEnding
  ): void {
    // Carried by the tab itself, never looked up by path: a file opened under
    // another spelling than the registry's would find nothing and save as LF.
    fileState.lineEnding = lineEnding;
    // An unreadable disk belonged to the document that is leaving; the one
    // arriving was read to be shown, or is the same one read again.
    endDiskUnreadable();
    fileState.filePath = path;
    fileState.isDirty = dirty;
    diskBaseline = baseline;
    dismissedDisk = null;
    activePreview = previewKindFor(path);
  }

  /**
   * Re-apply this window's configuration for `path` to the state just swapped
   * in — cached ones included, whose compartments hold whatever they held when
   * they were left.
   */
  function applyDocumentConfig(path: string | null): void {
    const kind = previewKindFor(path);
    const basename = path?.split('/').pop()?.toLowerCase() ?? '';
    const ext = path?.split('.').pop()?.toLowerCase() ?? '';
    if (kind === 'env') {
      editorHandle?.setEnvMode(true);
    } else if (kind === 'markdown') {
      editorHandle?.setEnvMode(false);
      void editorHandle?.setCodeMode(null);
    } else {
      editorHandle?.setEnvMode(false);
      void editorHandle?.setCodeMode(ext, basename).then((applied) => {
        // Only for the state that asked: a language that lands after a newer
        // swap or mode is dropped, and so is this.
        if (applied) applyPreviewConfig();
      });
      // `setCodeMode` adds the class only once its language has loaded; a
      // tab coming back from the background would otherwise flash unstyled.
      if (findCodeLanguage(basename, ext)) {
        editorHandle?.view?.dom.classList.add('cm-code-file-mode');
      }
    }
    // `setCodeMode(null)` and `setEnvMode(true)` reconfigure the preview
    // compartment themselves, with no flavour facet and no live-render
    // bundle; the engine's own configuration goes on top (see
    // `applyPreviewConfig`).
    applyPreviewConfig();
    applyLineGlow();
    // The state's own path field: the `$effect` below only re-runs when
    // `fileState.filePath` changes, and two untitled tabs share `null`.
    editorHandle?.setDocumentPath(path);
  }

  /**
   * Clean the live state for the background, and close what belongs to the
   * window rather than the tab: the search panel, the gutter menu (a module
   * singleton holding the view), the JSON offer's toast, the Recent panel.
   */
  function stripForBackground(): void {
    const view = editorHandle?.view;
    if (view) {
      stripLeavingState(view, themeControl);
      closeSearchPanel(view);
    }
    hideHoverMenu();
    toasts.dismissKind('json-offer');
    showRecentFiles = false;
  }

  /**
   * A file that cannot be read is not shown — an empty buffer on its path
   * would be autosaved over it — so the read's failure is the only thing the
   * human would otherwise never see.
   */
  async function readingForTab<T>(path: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      reportOpenError(path, err);
      throw err;
    }
  }

  /**
   * The controller's disk, with a toast for a read the human asked for. An
   * agent's read (`quiet`) fails into the agent's answer instead: a red toast
   * for something the human never did would stand there unexplained.
   */
  function diskCall<T>(path: string, opts: DiskOptions | undefined, call: () => Promise<T>): Promise<T> {
    return opts?.quiet ? call() : readingForTab(path, call);
  }

  /** The Rust half of a tab operation failed; the tab model itself goes on. */
  function logTabIpc(command: string): (err: unknown) => void {
    return (err) => console.error(`${command} failed:`, err);
  }

  /**
   * The one path that changes what this window shows — see
   * `lib/tabs/controller.ts`. Its dependencies are the singletons that follow
   * the active tab.
   */
  const tabs = createTabController({
    editor: {
      current: () => editorHandle?.view?.state ?? null,
      createState: (doc, cursor) => {
        if (!editorHandle) throw new Error('editor not mounted');
        return editorHandle.createState(doc, cursor);
      },
      swap: (state, opts) => editorHandle?.swapState(state, opts),
      applyDocumentConfig,
      stripForBackground,
      scrollSnapshot: () => editorHandle?.view?.scrollSnapshot() ?? null,
      applyPosition: ({ cursor, topLine }) => applyRestorePosition(cursor, topLine),
      topLine: topVisibleLine,
      commitCellEdit: () => activeCellEditSession()?.commit(),
    },
    doc: {
      path: () => fileState.filePath,
      dirty: () => fileState.isDirty,
      baseline: () => diskBaseline,
      lineEnding: () => fileState.lineEnding,
      setActive: setActiveDocument,
    },
    autosave: {
      flush: () => autoSave.flush(),
      holdsBack: () => conflictDialogOpen || diskUnreadable,
    },
    saveErrorPending: () => toasts.hasKind('save-error'),
    reportUnsaved: reportSwitchBlockedByUnsaved,
    comments: {
      flush: flushCommentsFor,
      // Queued, so it lands after any write still waiting — a countdown's
      // fire, say — rather than between that write's read and its rename.
      commitPauses: async (path) => {
        await commentWriter.enqueue(() =>
          invoke('commit_document_pauses', { path }).catch(logTabIpc('commit_document_pauses'))
        );
      },
      forget: forgetCommentsFor,
      reload: reloadComments,
    },
    ai: {
      // `agent` is created further down from `tabs` itself; the controller
      // calls these only around a switch or a close, after the script ran.
      leave: (tabId) => agent.leave(tabId),
      enter: (tabId) => agent.enter(tabId),
      forget: (tabId) => agent.forget(tabId),
      carry: (tabId) => agent.carry(tabId),
      adopt: (tabId, items) => agent.adopt(tabId, items),
      hasLiveAsk: () => liveAskShown(),
    },
    disk: {
      exists: (path, opts) => diskCall(path, opts, () => fileExists(path)),
      // No line break on disk says nothing about the file's convention, so
      // the tab's known ending is the fallback (see `detectLineEnding`).
      read: (path, opts) => diskCall(path, opts, () => readDocument(path, opts?.fallback)),
      write: (path, content, lineEnding) => writeDocument(path, content, lineEnding),
    },
    rust: {
      owner: (path) =>
        invoke<TabOwner>('tab_owner', { path }).catch((err: unknown): TabOwner => {
          logTabIpc('tab_owner')(err);
          return { kind: 'none' };
        }),
      open: (path) =>
        invoke<OpenAnswer>('tab_open', { path }).catch((err: unknown): OpenAnswer => {
          // Without Rust behind the page (`npm run dev` in a browser) a tab
          // still needs an id, and there is nothing to dedup against.
          if (!('__TAURI_INTERNALS__' in window)) {
            return { kind: 'created', tabId: `local-${Date.now()}-${Math.random().toString(36).slice(2)}` };
          }
          // With Rust, a tab it never registered is invisible to dedup and
          // agents; none is shown.
          console.error('tab_open failed:', err);
          toasts.push({
            kind: 'open-error',
            fileName: path?.split('/').pop() ?? t('ui.untitled_filename'),
            message: err instanceof Error ? err.message : String(err),
          });
          return { kind: 'failed' };
        }),
      release: (tabId) => invoke<void>('tab_release', { tabId }).catch(logTabIpc('tab_release')),
      activate: (tabId) => invoke<void>('tab_activate', { tabId }).catch(logTabIpc('tab_activate')),
      close: (tabId, { cursor, topLine }) =>
        invoke<void>('tab_close', { tabId, cursor, topLine }).catch(logTabIpc('tab_close')),
      focusElsewhere: async (path) => {
        await invoke('focus_if_open', { path }).catch(logTabIpc('focus_if_open'));
      },
      closeWindow: () =>
        import('@tauri-apps/api/window')
          .then(({ getCurrentWindow }) => getCurrentWindow().close())
          .catch(logTabIpc('window close')),
      move: (moving, target) => invoke<MoveDone>('tab_move', { tabs: moving, target }),
    },
    entered: (path, opened) => {
      if (path === null) return;
      if (opened) recentFiles.add(path);
      // A write that landed between the read that loaded this tab and its
      // watcher starting fired no event this window saw; one more read now
      // catches it (and is a no-op when nothing changed).
      void handleExternalChange(path);
    },
    changed: (list) => {
      tabList = list;
    },
    settled: () => reportTabs(),
    now: () => Date.now(),
    windowFocused: () => document.hasFocus(),
  });

  // Rust counts this window as mounted from `get_window_init` on and delivers
  // files as events from then on; one that lands before `tabs.init` is queued
  // would run on an empty tab list, and init would then publish over it. Every
  // tab-delivering source waits for this, in arrival order.
  let releaseTabSources: () => void = () => {};
  const tabSourcesReady = new Promise<void>((resolve) => {
    releaseTabSources = resolve;
  });

  function openTab(path: string, position?: { cursor: number; topLine: number }): Promise<void> {
    return tabSourcesReady.then(() => tabs.openPath(path, position));
  }

  /**
   * Native menu actions that open something in the page, put the caret in
   * the editor or change the document behind the drawer. The drawer closes
   * first: its focus handling keeps the keyboard while it is open and would
   * fight them.
   */
  const DRAWER_CLOSING_ACTIONS: ReadonlySet<string> = new Set([
    'find',
    'recent_files',
    'ai_comment',
    'select_all',
    'open',
    'save_as',
    'new_tab',
    'format_json',
  ]);

  /** What the drawer reads its cards' text and project line from. */
  const drawerSource = {
    held: (tabId: string) => tabs.textOf(tabId),
    read: (path: string) => readDocument(path).then((doc) => doc.text),
    gitInfo: (paths: string[]) =>
      invoke<(GitInfo | null)[]>('tab_git_info', { paths }).catch(() => paths.map(() => null)),
  };

  /** The other windows, for the drawer's carousel (plan 05, `tab_carousel_windows`). */
  const carouselSource = {
    windows: () =>
      invoke<CarouselWindow[]>('tab_carousel_windows').catch((err: unknown): CarouselWindow[] => {
        logTabIpc('tab_carousel_windows')(err);
        return [];
      }),
  };

  /** The window carousel is up: the page behind it blurs (D9, D11). */
  let carouselOn = $state(false);

  /** A move from the drawer's carousel (plan 05). A refusal already has its toast (`mayLeave`). */
  async function moveTabs(tabIds: string[], target: MoveTarget): Promise<void> {
    const paths = tabIds.map((id) => tabList.tabs.find((tab) => tab.id === id)?.path ?? null);
    const outcome = await tabs.moveTabs(tabIds, target);
    if (outcome?.kind === 'moved') announceMoved([{ label: outcome.label, number: outcome.number }]);
    if (outcome?.kind === 'failed') reportStranded(paths.map((path) => ({ path, error: outcome.error })));
  }

  /** Tabs a move left in this window; say so, or the gesture looks like it did nothing. */
  function reportStranded(stranded: readonly Stranded[]): void {
    if (stranded.length === 0) return;
    // One toast for all of them: a toast replaces any other of its kind.
    const errors = [...new Set(stranded.flatMap(({ error }) => (error ? [error] : [])))];
    toasts.push({
      kind: 'tabs-stranded',
      fileNames: tabNames(stranded.map(({ path }) => path)),
      count: stranded.length,
      message: errors.length > 0 ? errors.join('; ') : null,
    });
  }

  /** How long «Перенесено в #N» stays (D5). */
  const TABS_MOVED_TOAST_MS = 6000;

  /**
   * The human stays here (D5): say where the tabs went, with «Перейти». A
   * newer move replaces the toast, and its timer then finds nothing to close.
   */
  function announceMoved(moved: readonly MoveDone[]): void {
    if (moved.length === 0) return;
    const id = toasts.push({ kind: 'tabs-moved', label: moved[0].label, numbers: moved.map((m) => m.number) });
    // Never cleared, and needn't be: dismiss is by id, so once a newer toast replaced this one it closes nothing.
    setTimeout(() => toasts.dismiss(id), TABS_MOVED_TOAST_MS);
  }

  /** A toast that answers a key and goes by itself («Номер #N занят»). */
  function quietToast(payload: ToastPayload): void {
    const id = toasts.push(payload);
    setTimeout(() => toasts.dismiss(id), WINDOW_NUMBER_TOAST_MS);
  }

  /** The notch's edit of `#N` (spec §3). */
  function renumber(number: number): Promise<RenumberResult> {
    return renumberWindow(number, {
      setNumber: (n) => invoke<RenumberResult>('window_set_number', { number: n }),
      apply: setWindowNumber,
      toast: quietToast,
    });
  }

  /** «В новые окна» (spec §6): each tab through `tab_move`, into a window of its own. */
  async function moveTabsToNewWindows(tabIds: string[]): Promise<void> {
    const outcome = await tabs.moveToNewWindows(tabIds);
    if (outcome) {
      announceMoved(outcome.moved);
      reportStranded(outcome.stranded);
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
  //
  // The watcher fires on every write to the path, our own autosave included —
  // there is no OS-level way to tell those apart from a real external edit.
  // `resolveExternalChange` tells them apart by content instead.
  /**
   * A watcher event for our file, and the file would not read.
   *
   * A file that is simply gone is not this case: that was never an error
   * here, and the next save recreates it, as it always has. A file that is
   * still there but unreadable is — its content is a version the window has
   * not seen, so autosave pauses until a read succeeds.
   */
  async function handleReloadFailure(path: string, err: unknown): Promise<void> {
    const exists = await fileExists(path).catch(() => true);
    if (path !== fileState.filePath) return;
    if (!exists) {
      endDiskUnreadable();
      return;
    }
    markDiskUnreadable(path, err);
  }

  async function handleExternalChange(path: string): Promise<void> {
    if (path !== fileState.filePath) return;

    // A save may still be writing the very bytes this event is about, or one
    // could start between the wait below resolving and the read that follows
    // it — either way `disk` must reflect what a save actually produced, not
    // a state caught mid-write. Retry the read until no save landed while it
    // was in flight.
    let disk: string;
    let diskLineEnding: LineEnding;
    for (;;) {
      while (currentSave) await currentSave.catch(() => {});
      // Cmd+O (or another window event) may have switched this window to a
      // different file while the loop was waiting.
      if (path !== fileState.filePath) return;
      const generation = saveGeneration;
      try {
        // No line break on disk says nothing about the file's convention, so
        // keep the one the document already has (see `detectLineEnding`).
        ({ text: disk, lineEnding: diskLineEnding } = await readDocument(path, fileState.lineEnding));
      } catch (err) {
        if (path === fileState.filePath) await handleReloadFailure(path, err);
        return;
      }
      // A save that began during the read may have landed on either side of
      // it — if the generation moved, `disk` may already be stale.
      if (generation === saveGeneration) break;
    }
    if (path !== fileState.filePath) return;
    const wasUnreadable = endDiskUnreadable();

    // Every comparison below is between LF texts: `disk` is normalized by
    // `readDocument`, and the buffer and baseline never held anything else.
    // That is what keeps our own CRLF save from echoing back as a change.
    const decision = resolveExternalChange({
      disk,
      buffer: editorHandle?.view?.state.doc.toString() ?? '',
      baseline: diskBaseline,
      dismissedDisk,
    });

    fileState.lineEnding = lineEndingAfterExternalChange({
      decision,
      disk,
      baseline: diskBaseline,
      diskLineEnding,
      current: fileState.lineEnding,
    });

    switch (decision) {
      case 'ignore':
        // Edits typed while autosave was paused are still only in the buffer,
        // and the disk turned out to be the version they were made on top of.
        if (wasUnreadable && fileState.isDirty) autoSave.schedule();
        return;
      case 'adopt':
        // Buffer already matches disk — nothing to reload, just resync.
        diskBaseline = disk;
        fileState.isDirty = false;
        invoke('delete_recovery', { path }).catch(() => {});
        return;
      case 'reload':
        editorHandle?.updateContent(disk);
        diskBaseline = disk;
        fileState.isDirty = false;
        return;
      case 'conflict': {
        // FSEvents can fire more than once for one external write; coalesce
        // rather than stacking a second dialog on top of the first. This also
        // suppresses the autosave timer and the blur-save (see their guards)
        // for as long as the dialog is open, so "Yes" below re-reads the
        // external state rather than the buffer that just overwrote it.
        if (conflictDialogOpen) return;
        conflictDialogOpen = true;
        try {
          const reload = await ask(
            t('dialog.external_change.message'),
            { title: t('dialog.external_change.title'), kind: 'warning' }
          );
          if (path !== fileState.filePath) return;
          if (reload) {
            // Disk may have moved on again while the dialog was up.
            try {
              const latest = await readDocument(path, fileState.lineEnding);
              if (path !== fileState.filePath) return;
              editorHandle?.updateContent(latest.text);
              diskBaseline = latest.text;
              fileState.lineEnding = latest.lineEnding;
              fileState.isDirty = false;
              dismissedDisk = null;
            } catch (err) {
              if (path === fileState.filePath) await handleReloadFailure(path, err);
            }
          } else {
            // Suppress repeats for this exact disk state; a further external
            // change still asks again.
            dismissedDisk = disk;
            // The autosave that fired while the dialog was up (if any) was
            // suppressed by the guard above — the edits it would have saved
            // are still only in the buffer, so re-arm it.
            if (fileState.isDirty) autoSave.schedule();
          }
        } finally {
          conflictDialogOpen = false;
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
        if (verb) verb.textContent = commentSendText();
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
      if (verb) verb.textContent = sending ? commentSendingText() : commentSendText();
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
   * on screen — and `couplet watch` would wake an agent on a sentence that is
   * already stale.
   */
  async function fireCommentCountdown(id: string): Promise<void> {
    const entry = commentCountdowns.get(id);
    if (!entry) return;
    disarmCommentCountdown(id, true);
    // Write and commit are one queued step: the sidecar is read-modify-written
    // with no lock on the Rust side, so a write queued behind this one must not
    // land between them. `writeCommentNow`, not `writeComment` — the latter
    // would queue behind this very step and wait for itself.
    const committed = await commentWriter.run(id, async (realId) => {
      // A draft becomes a real thread on its first write, under an id the file
      // gives it — the commit has to follow it there.
      const written = (await writeCommentNow(realId)) ?? realId;
      try {
        await commentCommit(entry.path, written);
        toasts.dismissKind('comment-error');
        return true;
      } catch (err) {
        // The thread stays paused: the write that would have handed it to the
        // agent did not happen, and pretending otherwise would leave the user
        // waiting for a reply to a question no agent can see.
        reportCommentError(entry.path, err);
        return false;
      }
    });
    if (!committed) return;
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
   * it was left that way by a couplet that did not survive to commit it, and
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
    const savedText = t('editor.ai_comment.saved_label');
    label.textContent = savedText;
    setTimeout(() => {
      if (label.textContent === savedText) label.textContent = '';
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
  async function writeCommentNow(id: string): Promise<string | null> {
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
        commentWriter.redirect(id, realId);
        // The start opened the thread already paused; count that pause down
        // from the deadline the file recorded, under the id the file gave it.
        disarmCommentCountdown(id);
        armCommentCountdown(realId, entry.path, started.until * 1000);
        adoptStartedDraft(commentPending, id, realId, text);
        commentEditable.set(realId, text);
        // The card is about to be rebuilt under the id the file gave it; the
        // caret has to come along, or the first save silently ejects the user
        // from the box they are writing in.
        commentFocus = { id: realId, at: caret?.id === id ? caret.at : text.length };
        // The sidecar has only just come into existence, so the watcher armed
        // when this tab was activated isn't watching it yet. Activating the
        // tab again rebuilds the watcher over both paths — otherwise the very
        // first agent reply would arrive with nothing listening for it.
        const activeTabId = tabs.list.activeId;
        if (activeTabId !== null && fileState.filePath === entry.path) {
          await invoke('tab_activate', { tabId: activeTabId }).catch(logTabIpc('tab_activate'));
        }
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

  const commentWriter = createCommentWriter(writeCommentNow);

  /** Every caller goes through the queue — see `comment-writer.ts`. */
  function writeComment(id: string): Promise<string | null> {
    return commentWriter.write(id);
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
    // The window may have switched documents while the read was in flight;
    // these threads' anchors would then be searched for in the wrong text.
    if (fileState.filePath !== path) return;
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
    save: (cardId, text) => {
      const path = fileState.filePath;
      if (!path) return;
      // A draft's card keeps its draft id until the rebuild that follows its
      // first write; keystrokes in that gap belong to the thread it became.
      const id = commentWriter.idFor(cardId);
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
      void fireCommentCountdown(commentWriter.idFor(id));
    },
    resolve: (cardId) => {
      const path = fileState.filePath;
      if (!path) return;
      const id = commentWriter.idFor(cardId);
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
      //
      // Queued: a draft whose first write is in flight is no longer in
      // `commentDrafts` but has no real id yet either, and resolving it by its
      // draft id is a write the sidecar rejects. Behind that write it runs
      // under the id the file gave the thread — and forgets again under that
      // id, because the start moved the pending entry there.
      void commentWriter
        .run(cardId, async (realId) => {
          forgetCommentPending(realId);
          disarmCommentCountdown(realId);
          // The start failed and put the draft back: still nothing on disk.
          if (commentDrafts.delete(realId)) return;
          await commentResolve(path, realId).catch((err) => reportCommentError(path, err));
        })
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
      // the same whether it came through `couplet edit` or through a comment
      // thread, so it gets the same wash and the same Escape to dismiss —
      // without it, a paragraph the user did not write appears in their
      // document with nothing marking it as not theirs.
      //
      // The agent's text may carry `\r\n`; CM6 would normalize it on insert,
      // and a highlight measured on the raw string would overrun the span.
      const clean = normalizeLineEndings(text);
      view.dispatch({
        changes: { from: at, insert: `\n${clean}\n` },
        effects: setAiHighlights.of([{ from: at + 1, to: at + 1 + clean.length }]),
      });
    },
  };

  /**
   * Put the "here is the document I'm looking at" prompt on the clipboard —
   * the top-left button's whole job (#29).
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

  /** Put the "start watching this document's comments" prompt on the clipboard. */
  function copyWatchCommand(): void {
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
   * The menu item's entry point. Rust delivers a document action to exactly
   * one window (`menu_route.rs`), so there is nothing left to guard against
   * here; the toolbar button calls `startCommentFromSelection` directly.
   */
  function createCommentFromSelection(): void {
    startCommentFromSelection();
  }

  /**
   * Start a comment on the selection, or on the caret's line if nothing is
   * selected — an empty quote would give the thread no anchor to survive on.
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

  // --- AI commands (`couplet show`/`edit`/`ask`, routed opens, `close`) ---
  //
  // Where a command lands, and what it does to a tab in the background, is
  // `lib/tabs/agent-commands.ts`. What stays here is the live view.

  const typingTracker = createTypingTracker({
    now: () => Date.now(),
    focused: () => document.hasFocus(),
    // App-wide (Q10): an agent's command for another window must not bring it forward mid-word.
    report: () => void invoke('note_typing').catch(logTabIpc('note_typing')),
  });

  /** Capture phase on the window: every key, before anything stops it. */
  function noteTyping(e: KeyboardEvent): void {
    typingTracker.note(e);
  }

  /**
   * ⌃1…⌃9: bring window #N forward (spec §3). Registered in `onMount`, before
   * the drawer can add its listener. A human's key: the plain reveal, no
   * typing guard.
   */
  const onWindowDigit = ctrlDigitHandler({
    current: getWindowNumber,
    reveal: (number) => invoke<RevealResult>('window_reveal_number', { number }),
    toast: quietToast,
  });

  /** Show Next / Previous Tab: the menu's ⌘⇧] / ⌘⇧[ and the page's ⌃Tab / ⌃⇧Tab. */
  function cycleTab(delta: 1 | -1): void {
    void tabSourcesReady.then(() => tabs.cycle(delta));
  }

  /**
   * ⌃Tab / ⌃⇧Tab: a Ctrl-only menu accelerator never fires from the keyboard
   * (the webview takes the key), so these are caught here, like ⌃1…⌃9, and
   * registered right after `onWindowDigit`, before the drawer's listener.
   */
  const onWindowCtrlTab = ctrlTabHandler(cycleTab);

  function liveAskShown(): boolean {
    const view = editorHandle?.view;
    return view ? activeAskIds(view.state).length > 0 : false;
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

  function liveShow(payload: AiCommandPayload, keepCaret: boolean): AgentResponse {
    const view = editorHandle?.view;
    if (!view) return { ok: false, error: AGENT_ERRORS.editorNotReady };
    const pos = resolveShowTarget(view.state, { line: payload.line, find: payload.find });
    if (pos === null) return { ok: false, error: AGENT_ERRORS.targetNotFound };
    view.dispatch({
      // Move the caret along with the view: otherwise it stays wherever it
      // was (often position 0 in a fresh window) and the next arrow key
      // snaps the view back there — reads as "cursor jumped to the top".
      // Not while the human types: then neither the caret nor the view moves
      // (D19), and the pulse alone says where to look.
      ...(keepCaret ? {} : { selection: { anchor: pos } }),
      effects: [...(keepCaret ? [] : [EditorView.scrollIntoView(pos, { y: 'center' })]), pulseAiLine.of(pos)],
    });
    schedulePulseCleanup();
    return { ok: true };
  }

  /**
   * A background `show` arriving with its tab. The caret and the view were
   * placed on entry already (`placeCaretNow`), so this only pulses: it never
   * scrolls, and there is nothing for `quiet` to hold back.
   */
  function livePulse(payload: AiCommandPayload): void {
    const view = editorHandle?.view;
    if (!view) return;
    const pos = resolveShowTarget(view.state, { line: payload.line, find: payload.find });
    if (pos === null) return;
    view.dispatch({ effects: pulseAiLine.of(pos) });
    schedulePulseCleanup();
  }

  /** Invariant: synchronous between reading `view.state.doc` (in `buildAiEdit`)
   * and calling `view.dispatch` — no `await` in between. Two AI edit commands
   * delivered back-to-back would otherwise both read the same pre-edit state
   * and diff against it, and whichever dispatches second would clobber the
   * first's change instead of building on top of it. The same edit, CRLF
   * handling and undo step as a background tab's (`buildAiEdit` /
   * `aiEditTransaction`). */
  function liveEdit(payload: AiCommandPayload, keepCaret: boolean): AgentResponse {
    const view = editorHandle?.view;
    if (!view) return { ok: false, error: AGENT_ERRORS.editorNotReady };
    const edit = buildAiEdit(view.state, payload.content ?? '');
    if (!edit) return { ok: true, changed_lines: [] };
    // With `show` the user is being led to the change — the caret and the
    // view go there. Not while they type: the caret stays under their fingers
    // and the view keeps its place (the snapshot, mapped through the edit).
    const lead = payload.show && !keepCaret;
    const scrollEffect = view.scrollSnapshot().map(edit.changes);
    view.dispatch(
      aiEditTransaction(edit, lead, [
        ...(scrollEffect ? [scrollEffect] : []),
        ...(lead ? [EditorView.scrollIntoView(edit.from, { y: 'center' })] : []),
      ])
    );
    // docChanged still fires the update listener (handleChange), which arms
    // dirty state + autosave — no separate call needed here.
    return { ok: true, changed_lines: edit.changedLines };
  }

  function livePlaceAsk(
    payload: AiCommandPayload,
    deadline: number,
    onAnswer: (result: AskResult) => void,
    quiet: boolean
  ): boolean {
    const view = editorHandle?.view;
    if (!view) return false;
    let pos: number;
    if (payload.line === null && payload.find === null) {
      pos = view.state.doc.length;
    } else {
      const resolved = resolveShowTarget(view.state, { line: payload.line, find: payload.find });
      if (resolved === null) return false;
      pos = resolved;
    }
    const askId = payload.id;
    view.dispatch({
      // The caret follows the question's anchor for the same reason as
      // `show` — unless `quiet` (the human is typing): then the widget
      // appears and nothing moves.
      ...(quiet ? {} : { selection: { anchor: pos } }),
      effects: [
        addAiAsk.of({
          spec: {
            id: askId,
            question: payload.question ?? '',
            options: payload.options,
            multi: payload.multi,
            freeText: payload.freeText,
            onAnswer: (answerId, result) => {
              editorHandle?.view?.dispatch({ effects: removeAiAsk.of(answerId) });
              onAnswer(result);
            },
          },
          pos,
        }),
        ...(quiet ? [] : [EditorView.scrollIntoView(pos, { y: 'center' })]),
      ],
    });
    // Rust owns the deadline; this only drops a widget nobody waits on any
    // more. Removing an id the field no longer has is a no-op.
    setTimeout(
      () => {
        editorHandle?.view?.dispatch({ effects: removeAiAsk.of(askId) });
      },
      Math.max(0, deadline - Date.now()) + 2000
    );
    return true;
  }

  const agent = createAgentCommands({
    tabs,
    // Rejects when Rust cannot be asked; the orchestrator answers the agent
    // then instead of guessing either way.
    isPending: (id) => invoke<boolean>('ai_is_pending', { id }),
    respond: (id, response) =>
      invoke<void>('ai_respond', { id, response }).catch((err: unknown) => {
        console.error('Failed to respond to AI command:', err);
      }),
    forward: (payload) => invoke<boolean>('ai_forward', { payload }),
    typing: () => typingTracker.typing(),
    liveAsk: liveAskShown,
    // A failed IPC answers as before the refusal existed: the window was asked to come forward.
    revealWindow: () =>
      invoke<boolean>('reveal_window').catch((err: unknown) => {
        logTabIpc('reveal_window')(err);
        return true;
      }),
    now: () => Date.now(),
    live: {
      show: liveShow,
      edit: liveEdit,
      placeAsk: livePlaceAsk,
      pulse: livePulse,
      askIds: () => {
        const view = editorHandle?.view;
        return view ? activeAskIds(view.state) : [];
      },
    },
  });

  async function handleAiCommand(payload: AiCommandPayload): Promise<void> {
    // Before any of the command's own outcomes: an agent has reached this
    // install for the first time. The command may land in the background, in
    // a window that never comes forward, so this is not a moment the user is
    // sure to be looking — the toast stays until dismissed and is there when
    // they do. Raised even if the command below then fails: the point is to
    // explain what an agent can do here, not what this one did.
    if (payload.firstUse) {
      toasts.push({ kind: 'ai-first-use' });
    }
    await agent.handle(payload);
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
      reportTabs();
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

  // Until the mount-time pending open settles, this window's buffer is not
  // yet what it will be: a report now would describe a restored Untitled
  // window as empty and cost it its sidecar. Set once, by the mount chain.
  let pendingSettled = false;

  /**
   * Every tab of this window — background untitled text included, or a tab
   * left out of one report drops out of the session and its sidecar with it.
   */
  function reportTabs(): void {
    if (!pendingSettled) return;
    const view = editorHandle?.view;
    if (!view) return;
    const { tabs: reported, active } = tabs.report({
      cursor: view.state.selection.main.head,
      topLine: topVisibleLine(),
      content: view.state.doc.toString(),
    });
    invoke('tabs_sync', { tabs: reported, active }).catch(() => {
      // Session tracking is best-effort; never surface it to the user.
    });
  }

  // --- Save on blur ---
  function handleWindowBlur(): void {
    void tabs.windowFocusChanged(false);
    // Same gate as the autosave timer: not over a disk state the conflict
    // dialog is asking about, not over one we could not read.
    if (canAutoSave(saveGate())) {
      performSave();
    }
    // Leaving couplet ends every running comment pause on the spot.
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

  function handleWindowFocus(): void {
    void tabs.windowFocusChanged(true);
  }

  onMount(() => {
    // Настоящее имя сборки в заголовок: у `dev:app` и `build:dev` оно другое,
    // и титлбар — единственное место, где человек видит, дев перед ним или
    // установленный релиз.
    getName()
      .then(setProductName)
      .catch(() => {});

    // Every listener that can deliver a tab — a file, a reopened tab, an
    // agent's command — is in place before `get_window_init`: Rust counts the
    // window as mounted from that call on and sends it events instead of a
    // payload, and an event with no listener yet is lost.
    const unlistenOpenFile = onOpenFile((path) => {
      void openTab(path);
    });
    const unlistenReopenTab = onReopenTab(({ path, cursor, topLine }) => {
      void openTab(path, { cursor, topLine });
    });
    const unlistenAiCommand = onAiCommand((payload) => {
      void tabSourcesReady.then(() => handleAiCommand(payload));
    });
    // Tabs another window moved here. A window built for a move can mount
    // before the move takes the lock: its init is then a blank Untitled, and
    // the tabs come this way (the blank tab gives way to them).
    const unlistenTabsArrive = onTabsArrive((arrived) => {
      void tabSourcesReady
        .then(() => tabs.arrive(arrived))
        .catch((err: unknown) => console.error('Failed to take in tabs moved here:', err));
    });

    const unlistenWindowNumber = onWindowNumber(setWindowNumber);

    // Pull what the backend stored for this window (its tabs, restored or
    // handed over before it mounted) — pulled, so it cannot race the listeners.
    // Retried once: a window that never gets here stays unmounted in Rust, and
    // files meant for it pile up in a payload nobody pulls.
    Promise.all([unlistenOpenFile, unlistenReopenTab, unlistenAiCommand, unlistenTabsArrive, unlistenWindowNumber])
      .then(() => invoke<WindowInit>('get_window_init'))
      .catch((err: unknown) => {
        console.error('get_window_init failed, retrying once:', err);
        return invoke<WindowInit>('get_window_init');
      })
      .then(
        async (init) => {
          // Released even if this throws: held, every file and agent command
          // for this window would wait forever.
          let initialized: Promise<void> | undefined;
          try {
            initialized = tabs.init(init.tabs, init.activeTabId);
            setWindowNumber(init.number);
          } finally {
            releaseTabSources();
          }
          await initialized;
        },
        async (err: unknown) => {
          // No Rust behind the page (`npm run dev` in a browser), or both
          // attempts failed: one local tab.
          console.error('get_window_init failed twice; this window has only a local tab:', err);
          let initialized: Promise<void> | undefined;
          try {
            initialized = tabs.init([], null);
          } finally {
            releaseTabSources();
          }
          await initialized;
        }
      )
      .catch((err: unknown) => {
        console.error('Window init failed:', err);
      })
      // Register this window in the session right away, not 5s later — but only
      // once init has settled. Reported any earlier, a restored Untitled tab
      // still looks empty: Rust drops its `untitled` name, the ticker prunes the
      // restored sidecar within a second, and a quit before the next heartbeat
      // loses that draft for good. `finally`, so a failed init still registers
      // the window. The recovery interval's heartbeat is held back until here
      // too (`pendingSettled`), for an init slower than its first 5 s tick.
      .finally(() => {
        pendingSettled = true;
        reportTabs();
      })
      .then(async () => {
        // Commands queued for this file before its window existed (e.g. an
        // `ai edit` of a file that wasn't open yet triggered this window's
        // creation) — drained once, after init settles.
        const queued = await invoke<AiCommandPayload[]>('ai_pull_pending').catch(() => []);
        for (const command of queued) {
          await handleAiCommand(command);
        }
      });

    // Menu events
    const unlistenMenu = onMenuEvent((action) => {
      if (DRAWER_CLOSING_ACTIONS.has(action)) drawerHandle?.close();
      switch (action) {
        case 'new':
          handleNew();
          break;
        case 'open':
          handleOpen();
          break;
        case 'new_tab':
          void tabSourcesReady.then(() => tabs.newTab());
          break;
        case 'close':
          void tabSourcesReady.then(() => tabs.closeActive());
          break;
        case 'next_tab':
          cycleTab(1);
          break;
        case 'prev_tab':
          cycleTab(-1);
          break;
        case 'toggle_drawer':
          drawerHandle?.toggle();
          break;
        case 'toggle_tabs_compact:on':
          tabsCompact.set(true);
          break;
        case 'toggle_tabs_compact:off':
          tabsCompact.set(false);
          break;
        case 'transient_ignored_keep':
          transientPolicy.set('keep');
          break;
        case 'transient_ignored_close':
          transientPolicy.set('close');
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
        case 'theme_family_paper':
          theme.setFamily('paper');
          break;
        case 'theme_family_ink':
          theme.setFamily('ink');
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
          formatJson(false);
          break;
      }

      const tabDigit = /^select_tab_([1-9])$/.exec(action);
      if (tabDigit) {
        const n = Number(tabDigit[1]);
        // With the drawer open, ⌘n is the card whose hint reads ⌘n — in a
        // filtered view that is not the n-th tab.
        const picked = drawerHandle?.shortcutTarget(n);
        if (picked === undefined) {
          void tabSourcesReady.then(() => tabs.selectIndex(n));
        } else if (picked !== null) {
          drawerHandle?.close();
          void tabs.activate(picked);
        }
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
      if (action.startsWith('toggle_tabs_compact')) {
        syncTabsCompactMenu(tabsCompact.enabled);
      }
      // macOS flips the clicked radio item by itself, so the pair is always
      // re-set — the click that chose the current value included.
      if (action.startsWith('transient_ignored_')) {
        syncTransientMenu(transientPolicy.value);
      }
    });

    const unlistenExternalChange = onFileChangedExternally((path) => {
      handleExternalChange(path);
    });

    // An agent appended a reply to this document's sidecar. Only the comment
    // cards are rebuilt — the document itself did not change, so nothing here
    // touches the buffer, the dirty flag, or autosave.
    const unlistenComments = onCommentsChanged(() => {
      void reloadComments();
    });

    // Drag & drop: every dropped file becomes a tab of this window; the first
    // may take a blank tab's place.
    const unlistenDragDrop = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        for (const path of event.payload.paths as string[]) {
          await openTab(path);
        }
      })
    );


    // Save on window blur
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', noteTyping, true);
    window.addEventListener('keydown', onWindowDigit, true);
    window.addEventListener('keydown', onWindowCtrlTab, true);
    window.addEventListener('focus', handleWindowFocus);

    // Start recovery interval
    startRecoveryInterval();

    // Spec §7: an hour after being seen, an unanswered quick look is kept or
    // closed by the File-menu policy. A minute is fine-grained enough.
    const transientTimer = setInterval(() => {
      void tabs.expireTransients(transientPolicy.value);
    }, 60_000);

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

    // Manual "Check for Updates…" (#82). Routed to exactly one window — see
    // `onCheckUpdatesRequested`'s doc comment — and, unlike the automatic
    // poll above, always answers: found piggybacks on the `update` toast via
    // `report_update`'s `force` flag (handled by `onUpdateAvailable` above,
    // no extra code needed here), already-latest and network-failure get
    // their own toasts since the automatic checker never surfaces those.
    const unlistenCheckUpdatesRequested = onCheckUpdatesRequested(() => {
      void import('./lib/updater').then(async ({ checkForUpdatesManually }) => {
        const result = await checkForUpdatesManually();
        if (result === 'none') toasts.push({ kind: 'update-none' });
        else if (result === 'error') toasts.push({ kind: 'update-check-failed' });
      });
    });

    const unlistenUpdateDismissed = onUpdateDismissed(() => {
      toasts.dismissKind('update');
    });

    // Surfaces a language change that failed to persist (#see finding in
    // i18n code review) — this app already decided silent write failures
    // need a toast (`save-error`, `comment-error`); a language pick that
    // silently does nothing is the same failure shape.
    const unlistenLanguageChangeFailed = onLanguageChangeFailed((message) => {
      toasts.push({ kind: 'language-error', message });
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

    void recentFiles.init();
    const unlistenRecentChanged = onRecentChanged((snapshot) => recentFiles.setList(snapshot));

    return () => {
      if (stopUpdateChecker) stopUpdateChecker();
      unlistenMenu.then((fn) => fn());
      unlistenOpenFile.then((fn) => fn());
      unlistenReopenTab.then((fn) => fn());
      unlistenTabsArrive.then((fn) => fn());
      unlistenWindowNumber.then((fn) => fn());
      unlistenExternalChange.then((fn) => fn());
      unlistenAiCommand.then((fn) => fn());
      unlistenComments.then((fn) => fn());
      unlistenDragDrop.then((fn) => fn());
      unlistenSessionRestored.then((fn) => fn());
      unlistenRecentChanged.then((fn) => fn());
      unlistenUpdateAvailable.then((fn) => fn());
      unlistenCheckUpdatesRequested.then((fn) => fn());
      unlistenUpdateDismissed.then((fn) => fn());
      unlistenLanguageChangeFailed.then((fn) => fn());
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', noteTyping, true);
      window.removeEventListener('keydown', onWindowDigit, true);
      window.removeEventListener('keydown', onWindowCtrlTab, true);
      window.removeEventListener('focus', handleWindowFocus);
      autoSave.cancel();
      if (recoveryInterval !== null) clearInterval(recoveryInterval);
      clearInterval(transientTimer);
      if (reloadRetryTimer !== null) clearTimeout(reloadRetryTimer);
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

  // The Dock follows the committed theme, not a `/theme` preview: a window
  // closed with the picker open never clears its preview. First run is the
  // startup sync, like the menu's.
  $effect(() => {
    syncDockIcon(theme.committed);
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
    syncTabsCompactMenu(tabsCompact.enabled);
  });
  $effect(() => {
    syncTransientMenu(transientPolicy.value);
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

  /** Line glow lives in each state's own compartment: a swapped-in state needs it re-applied. */
  function applyLineGlow(): void {
    const view = editorHandle?.view;
    if (!view) return;
    view.dispatch({
      effects: lineGlowCompartment.reconfigure(lineGlow.enabled ? highlightActiveLine() : []),
    });
  }

  // Reconfigure line glow when toggled
  $effect(() => {
    void lineGlow.enabled;
    void editorHandle?.view;
    applyLineGlow();
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
   * with no flavour facet and no live-render bundle. `applyDocumentConfig`
   * calls `setCodeMode(null)` for every markdown tab, so on a freshly opened
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
  // An effect as well as a call inside `applyDocumentConfig`, because the path also
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
<main data-zoom={zoom.level} class:carousel-on={carouselOn}>
  <Editor
    bind:handle={editorHandle}
    onchange={handleChange}
    onAiHighlightVisibilityChange={handleAiHighlightVisibilityChange}
    onJsonOffer={() => toasts.push({ kind: 'json-offer' })}
    onJsonOfferWithdrawn={() => toasts.dismissKind('json-offer')}
    {themeControl}
  />
</main>

<AiHintBadge visible={showAiHint} />

<AiBindButton onclick={copyBindPrompt} />

<TabDrawer
  bind:handle={drawerHandle}
  list={tabList}
  windowNumber={getWindowNumber()}
  compact={tabsCompact.enabled}
  source={drawerSource}
  onactivate={(tabId) => void tabs.activate(tabId)}
  onclose={(tabIds) => void tabs.closeTabs(tabIds)}
  onreorder={(order) => void tabs.reorder(order)}
  onnewwindows={(tabIds) => void moveTabsToNewWindows(tabIds)}
  {carouselSource}
  onmove={(tabIds, target) => void moveTabs(tabIds, target)}
  oncarousel={(on) => {
    carouselOn = on;
  }}
  onrestorefocus={() => editorHandle?.view?.focus()}
  onrenumber={renumber}
/>

<TransientBar
  visible={activeQuickLook !== null}
  onclose={() => {
    if (activeQuickLook !== null) void tabs.closeTransient(activeQuickLook);
  }}
  onkeep={() => {
    if (activeQuickLook !== null) void tabs.keepTransient(activeQuickLook);
  }}
/>

{#if showRecentFiles}
  <RecentFilesPanel
    files={recentFiles.list}
    onopen={(path) => void openTab(path)}
    onclose={() => { showRecentFiles = false; }}
  />
{/if}

<ToastStack
  store={toasts}
  onFormatJson={() => formatJson(true)}
  onRevealWindow={(label) => {
    invoke('reveal_other_window', { label }).catch(logTabIpc('reveal_other_window'));
  }}
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
    transition: filter 0.28s var(--tabs-ease);
  }

  /* Plan 05: the page behind the window carousel (mockup `.carousel-on .editor`). */
  main.carousel-on {
    filter: blur(9px) saturate(0.85);
  }

  /* D11: no blur and no transition — the scrim alone dims the page. */
  @media (prefers-reduced-motion: reduce) {
    main {
      transition: none;
    }
    main.carousel-on {
      filter: none;
    }
  }
</style>
