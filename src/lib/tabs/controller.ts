import type { EditorState, StateEffect } from '@codemirror/state';
import { createSerialQueue } from '../serial-queue';
import { decideLeave, decideOpenAction, type TabOwner } from '../switch-document';
import { decideEnter } from './tab-cache';
import {
  activeTab,
  emptyTabList,
  findById,
  findByPath,
  insertAfterActive,
  neighbour,
  removeTab,
  replaceTab,
  setActive,
  tabByIndex,
  updateTab,
  type TabListState,
  type TabMeta,
} from './tab-model';

/** Flush attempts before a still-dirty file tab refuses to be left. */
export const FLUSH_ATTEMPTS = 3;

export interface Position {
  cursor: number;
  topLine: number;
}

/** A tab a window opens with — the shape of `PendingTab` from Rust. */
export interface InitTab {
  tabId: string;
  path: string | null;
  content: string | null;
  cursor: number;
  topLine: number;
}

/** One tab on the heartbeat — the shape `tabs_sync` takes. */
export interface TabReport {
  tabId: string;
  path: string | null;
  cursor: number;
  topLine: number;
  content: string | null;
}

/** What `tab_open` answers. */
export type OpenAnswer =
  | { kind: 'created'; tabId: string }
  | { kind: 'this-window'; tabId: string }
  | { kind: 'other-window'; label: string };

export type ActivateResult = 'ok' | 'noop' | 'refused' | 'busy' | 'failed';

/** What `EditorHandle.swapState` takes, always spelled out by the controller. */
export interface SwapOptions {
  /** A just-built state: blur it like a file load always did. */
  blur: boolean;
  /** `'top'` for a fresh state; a cached one gets the snapshot taken when it was left. */
  scroll: 'top' | StateEffect<unknown>;
}

export interface TabControllerDeps {
  /** The one live editor view. */
  editor: {
    current(): EditorState | null;
    /** Caret at `cursor`, or at the end when `null`. */
    createState(doc: string, cursor: number | null): EditorState;
    swap(state: EditorState, opts: SwapOptions): void;
    /**
     * Re-apply the window's configuration for `path` to the state just
     * swapped in — language / preview mode, preview config, line glow, the
     * document path, and the code-file class on the view. Runs after every
     * swap, cached ones included: a cached state may hold a stale language
     * (a load dropped when it was left), and the class lives on the view.
     * Runs after `doc.setActive`, whose singletons it reads.
     */
    applyDocumentConfig(path: string | null): void;
    /** Clean the live state for the background and close window overlays. */
    stripForBackground(): void;
    scrollSnapshot(): StateEffect<unknown> | null;
    applyPosition(position: Position): Promise<void>;
    topLine(): number;
    commitCellEdit(): void;
  };
  /** The active document's singletons in App.svelte. */
  doc: {
    path(): string | null;
    dirty(): boolean;
    baseline(): string | null;
    setActive(path: string | null, dirty: boolean, baseline: string | null): void;
  };
  autosave: {
    flush(): Promise<void>;
    /** The conflict dialog holds saves back; retrying a flush is pointless. */
    holdsBack(): boolean;
  };
  saveErrorPending(): boolean;
  reportUnsaved(): void;
  comments: {
    /** Whether everything typed for `path` is now on disk. */
    flush(path: string): Promise<boolean>;
    commitPauses(path: string): Promise<void>;
    forget(path: string): void;
    reload(): Promise<void>;
  };
  ai: {
    /**
     * Fail every agent waiting on `path` in this window — the pending asks
     * AND the commands still queued for it (Rust `cancel_for_tab`, reached
     * through `cancel_ai_ask`). A queued payload left behind would be
     * delivered into whatever tab is active next.
     */
    cancel(path: string): Promise<void>;
    hasLiveAsk(): boolean;
    clearAsks(): void;
  };
  disk: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
  };
  rust: {
    owner(path: string): Promise<TabOwner>;
    open(path: string | null): Promise<OpenAnswer>;
    release(tabId: string): Promise<void>;
    activate(tabId: string): Promise<void>;
    close(tabId: string, position: Position): Promise<void>;
    focusElsewhere(path: string): Promise<void>;
    closeWindow(): Promise<void>;
  };
  /** A tab became active (`opened`: it was just opened, not switched to). */
  entered(path: string | null, opened: boolean): void;
  /** The list changed — for the UI. */
  changed(list: TabListState): void;
  /** An operation finished — report the tabs. */
  settled(): void;
}

/** What a background tab keeps. `state` is null until the tab was first shown. */
interface TabCache {
  state: EditorState | null;
  /** An untitled tab's text restored from the session, used while `state` is null. */
  content: string | null;
  cursor: number;
  topLine: number;
  scroll: StateEffect<unknown> | null;
  /** Disk content as of leaving; `null` when the file did not exist. */
  baseline: string | null;
}

type Ready =
  | { kind: 'cached'; state: EditorState }
  | { kind: 'fresh'; content: string; exists: boolean };

type Loadable =
  | { working: TabListState; failed: string[]; tab: TabMeta; ready: Ready }
  | { working: TabListState; failed: string[]; tab: null; ready: null };

export function createTabController(deps: TabControllerDeps) {
  const queue = createSerialQueue();
  const cache = new Map<string, TabCache>();
  let list: TabListState = emptyTabList();

  function publish(next: TabListState): void {
    list = next;
    deps.changed(list);
  }

  function isEmptyUntitled(): boolean {
    return deps.doc.path() === null && (deps.editor.current()?.doc.length ?? 0) === 0;
  }

  /**
   * A keystroke that landed during a write is not covered by it; another
   * flush picks it up. Bounded, and never after a failure or while the
   * conflict dialog holds saves back — those would only repeat a write that
   * cannot happen.
   */
  async function flushWithRetries(): Promise<void> {
    await deps.autosave.flush();
    for (
      let attempt = 1;
      attempt < FLUSH_ATTEMPTS &&
      deps.doc.path() !== null &&
      deps.doc.dirty() &&
      !deps.autosave.holdsBack() &&
      !deps.saveErrorPending();
      attempt++
    ) {
      await deps.autosave.flush();
    }
  }

  /** Step 1 of leaving: nothing has been handed over yet. */
  async function mayLeave(): Promise<boolean> {
    deps.editor.commitCellEdit();
    await flushWithRetries();
    const verdict = decideLeave({
      activePath: deps.doc.path(),
      activeIsDirty: deps.doc.dirty(),
      saveErrorPending: deps.saveErrorPending(),
    });
    if (verdict.kind === 'refuse-unsaved') deps.reportUnsaved();
    return verdict.kind === 'ok';
  }

  /**
   * Step 3: hand the active document over. Comment text first — a pause
   * committed before its text is written would give an agent stale text, and
   * a failed write stops everything before anything is irreversible. Then
   * pauses and asks, whose agents learn at once. A file tab typed into during
   * these awaits stays: its asks are already answered, so their widgets go,
   * and its cards are rebuilt from the file.
   */
  async function handOver(): Promise<boolean> {
    const path = deps.doc.path();
    if (path !== null) {
      if (!(await deps.comments.flush(path))) return false;
      await deps.comments.commitPauses(path);
      await deps.ai.cancel(path);
    }
    await deps.autosave.flush();
    if (path !== null && deps.doc.dirty()) {
      deps.ai.clearAsks();
      void deps.comments.reload();
      deps.reportUnsaved();
      return false;
    }
    return true;
  }

  /** Step 4a: put the active tab in the background. Synchronous. */
  function stashActive(): void {
    const tab = activeTab(list);
    const state = deps.editor.current();
    if (!tab || !state) return;
    const cursor = state.selection.main.head;
    const topLine = deps.editor.topLine();
    const scroll = deps.editor.scrollSnapshot();
    const dirty = deps.doc.dirty();
    const baseline = deps.doc.baseline();
    deps.editor.stripForBackground();
    cache.set(tab.id, {
      state: deps.editor.current(),
      content: null,
      cursor,
      topLine,
      scroll,
      baseline,
    });
    if (tab.path !== null) deps.comments.forget(tab.path);
    publish(updateTab(list, tab.id, { dirty }));
  }

  /** Step 2: what entering `tab` will show. Nothing changes here. */
  async function prepare(tab: TabMeta): Promise<Ready | { kind: 'failed' }> {
    const cached = cache.get(tab.id);
    if (tab.path === null) {
      return cached?.state
        ? { kind: 'cached', state: cached.state }
        : { kind: 'fresh', content: cached?.content ?? '', exists: false };
    }
    try {
      const exists = await deps.disk.exists(tab.path);
      const content = exists ? await deps.disk.read(tab.path) : '';
      if (
        cached?.state &&
        decideEnter({ baseline: cached.baseline, disk: exists ? content : null }) === 'use-cache'
      ) {
        return { kind: 'cached', state: cached.state };
      }
      return { kind: 'fresh', content, exists };
    } catch (err) {
      console.error('Failed to open file:', err);
      return { kind: 'failed' };
    }
  }

  /**
   * The first tab from `working`'s active one onwards that can be shown. A tab
   * whose file can no longer be read is set aside rather than shown empty — an
   * empty buffer bound to a real path would be autosaved over that file.
   */
  async function prepareLoadable(working: TabListState): Promise<Loadable> {
    const failed: string[] = [];
    let current = working;
    for (;;) {
      const tab = current.activeId === null ? undefined : findById(current, current.activeId);
      if (!tab) return { working: current, failed, tab: null, ready: null };
      const ready = await prepare(tab);
      if (ready.kind !== 'failed') return { working: current, failed, tab, ready };
      failed.push(tab.id);
      current = removeTab(current, tab.id).state;
    }
  }

  async function releaseAll(ids: string[]): Promise<void> {
    for (const id of ids) {
      cache.delete(id);
      await deps.rust.release(id);
    }
  }

  /** Steps 4b and 5: show `tab`. Everything up to the swap is synchronous. */
  async function enter(
    tab: TabMeta,
    ready: Ready,
    position: Position | null,
    opened: boolean
  ): Promise<void> {
    const cached = cache.get(tab.id);
    let restore = position;
    if (ready.kind === 'cached') {
      const scroll = !position && cached?.scroll ? cached.scroll : 'top';
      deps.editor.swap(ready.state, { blur: false, scroll });
      deps.doc.setActive(tab.path, tab.dirty, cached?.baseline ?? null);
    } else {
      restore = position ?? (cached ? { cursor: cached.cursor, topLine: cached.topLine } : null);
      deps.editor.swap(deps.editor.createState(ready.content, restore ? restore.cursor : null), {
        blur: true,
        scroll: 'top',
      });
      deps.doc.setActive(
        tab.path,
        tab.path === null && ready.content.length > 0,
        ready.exists ? ready.content : null
      );
    }
    deps.editor.applyDocumentConfig(tab.path);
    // The live view holds this tab now; its cache entry is rebuilt on leave.
    cache.delete(tab.id);
    publish(setActive(updateTab(list, tab.id, { dirty: deps.doc.dirty() }), tab.id));
    if (restore) await deps.editor.applyPosition(restore);
    await deps.rust.activate(tab.id);
    void deps.comments.reload();
    deps.entered(tab.path, opened);
    deps.settled();
  }

  async function initNow(tabs: readonly InitTab[], activeTabId: string | null): Promise<void> {
    for (const t of tabs) {
      cache.set(t.tabId, {
        state: null,
        content: t.content,
        cursor: t.cursor,
        topLine: t.topLine,
        scroll: null,
        baseline: null,
      });
    }
    const metas: TabMeta[] = tabs.map((t) => ({
      id: t.tabId,
      path: t.path,
      dirty: t.path === null && (t.content ?? '') !== '',
    }));
    const start = metas.some((m) => m.id === activeTabId) ? activeTabId : (metas[0]?.id ?? null);
    const found = await prepareLoadable({ tabs: metas, activeId: start });
    await releaseAll(found.failed);
    if (found.tab !== null) {
      publish(found.working);
      await enter(found.tab, found.ready, null, true);
      return;
    }
    // A window always shows a tab.
    const answer = await deps.rust.open(null);
    if (answer.kind !== 'created') return;
    const tab: TabMeta = { id: answer.tabId, path: null, dirty: false };
    publish(insertAfterActive(found.working, tab));
    await enter(tab, { kind: 'fresh', content: '', exists: false }, null, false);
  }

  async function activateNow(
    tabId: string,
    opts: { byAgent?: boolean; position?: Position } = {}
  ): Promise<ActivateResult> {
    const target = findById(list, tabId);
    if (!target) return 'failed';
    if (tabId === list.activeId) {
      if (opts.position) await deps.editor.applyPosition(opts.position);
      return 'noop';
    }
    // An agent never takes the view away from another agent's live question.
    if (opts.byAgent && deps.ai.hasLiveAsk()) return 'busy';
    if (!(await mayLeave())) return 'refused';
    const ready = await prepare(target);
    if (ready.kind === 'failed') return 'failed';
    if (!(await handOver())) return 'refused';
    stashActive();
    await enter(target, ready, opts.position ?? null, false);
    return 'ok';
  }

  async function openInNewTab(path: string, position: Position | null, replace: boolean): Promise<void> {
    let content = '';
    let exists = false;
    try {
      exists = await deps.disk.exists(path);
      content = exists ? await deps.disk.read(path) : '';
    } catch (err) {
      console.error('Failed to open file:', err);
      return;
    }
    const answer = await deps.rust.open(path);
    if (answer.kind === 'other-window') {
      await deps.rust.focusElsewhere(path);
      return;
    }
    if (answer.kind === 'this-window') {
      await activateNow(answer.tabId, { position: position ?? undefined });
      return;
    }
    if (!(await handOver())) {
      await deps.rust.release(answer.tabId);
      return;
    }
    const tab: TabMeta = { id: answer.tabId, path, dirty: false };
    const previous = activeTab(list);
    // Re-checked here, after the last await: text typed into the blank tab
    // while the file was read makes it a tab worth keeping.
    if (replace && previous && isEmptyUntitled()) {
      cache.delete(previous.id);
      publish(replaceTab(list, previous.id, tab));
      await enter(tab, { kind: 'fresh', content, exists }, position, true);
      await deps.rust.release(previous.id);
      return;
    }
    stashActive();
    publish(insertAfterActive(list, tab));
    await enter(tab, { kind: 'fresh', content, exists }, position, true);
  }

  async function openNow(path: string, position: Position | null): Promise<void> {
    deps.editor.commitCellEdit();
    await flushWithRetries();
    const local = findByPath(list, path);
    const owner: TabOwner = local ? { kind: 'this-window', tabId: local.id } : await deps.rust.owner(path);
    const action = decideOpenAction({
      targetPath: path,
      activeTabId: list.activeId,
      activePath: deps.doc.path(),
      activeIsDirty: deps.doc.dirty(),
      activeIsEmptyUntitled: isEmptyUntitled(),
      saveErrorPending: deps.saveErrorPending(),
      owner,
    });
    switch (action.kind) {
      case 'noop':
        if (position) await deps.editor.applyPosition(position);
        return;
      case 'refuse-save-error':
        // The standing `save-error` toast already says why.
        return;
      case 'refuse-unsaved':
        deps.reportUnsaved();
        return;
      case 'focus-other-window':
        await deps.rust.focusElsewhere(path);
        return;
      case 'activate-tab':
        await activateNow(action.tabId, { position: position ?? undefined });
        return;
      case 'replace-active':
      case 'open-new-tab':
        await openInNewTab(path, position, action.kind === 'replace-active');
        return;
    }
  }

  async function newTabNow(): Promise<void> {
    if (!(await mayLeave())) return;
    const answer = await deps.rust.open(null);
    if (answer.kind !== 'created') return;
    if (!(await handOver())) {
      await deps.rust.release(answer.tabId);
      return;
    }
    stashActive();
    const tab: TabMeta = { id: answer.tabId, path: null, dirty: false };
    publish(insertAfterActive(list, tab));
    await enter(tab, { kind: 'fresh', content: '', exists: false }, null, true);
  }

  async function closeNow(tabId: string): Promise<void> {
    if (!findById(list, tabId)) return;

    if (tabId !== list.activeId) {
      // A background tab is clean by construction and was handed over when
      // it was left; there is nothing to flush.
      const cached = cache.get(tabId);
      cache.delete(tabId);
      publish(removeTab(list, tabId).state);
      await deps.rust.close(tabId, { cursor: cached?.cursor ?? 0, topLine: cached?.topLine ?? 1 });
      deps.settled();
      return;
    }

    deps.editor.commitCellEdit();
    await flushWithRetries();
    const path = deps.doc.path();
    // An untitled tab's text is not a reason to refuse: ⌘W on untitled
    // discards it by design (spec §8).
    const verdict = decideLeave({
      activePath: path,
      activeIsDirty: deps.doc.dirty(),
      saveErrorPending: deps.saveErrorPending(),
    });
    if (verdict.kind === 'refuse-unsaved') deps.reportUnsaved();
    if (verdict.kind !== 'ok') return;
    if (path !== null) {
      if (!(await deps.comments.flush(path))) return;
      await deps.comments.commitPauses(path);
    }
    const state = deps.editor.current();
    const position: Position = {
      cursor: state?.selection.main.head ?? 0,
      topLine: deps.editor.topLine(),
    };

    const next = await prepareLoadable(removeTab(list, tabId).state);
    await deps.autosave.flush();
    if (path !== null && deps.doc.dirty()) {
      // Typed into during the awaits: the tab stays, its cards come back.
      void deps.comments.reload();
      deps.reportUnsaved();
      return;
    }

    if (path !== null) deps.comments.forget(path);
    deps.editor.stripForBackground();
    cache.delete(tabId);
    await releaseAll(next.failed);
    publish(next.working);
    if (next.tab === null) {
      await deps.rust.close(tabId, position);
      deps.settled();
      await deps.rust.closeWindow();
      return;
    }
    await enter(next.tab, next.ready, null, false);
    // After the swap: its Rust side fails the closed document's agents and
    // records it for ⌘⇧T; the watcher has already moved on.
    await deps.rust.close(tabId, position);
  }

  function report(live: { cursor: number; topLine: number; content: string }): {
    tabs: TabReport[];
    active: string | null;
  } {
    return {
      active: list.activeId,
      tabs: list.tabs.map((tab): TabReport => {
        if (tab.id === list.activeId) {
          return {
            tabId: tab.id,
            path: tab.path,
            cursor: live.cursor,
            topLine: live.topLine,
            content: tab.path === null ? live.content : null,
          };
        }
        const c = cache.get(tab.id);
        return {
          tabId: tab.id,
          path: tab.path,
          cursor: c?.cursor ?? 0,
          topLine: c?.topLine ?? 1,
          content: tab.path === null ? (c?.state?.doc.toString() ?? c?.content ?? '') : null,
        };
      }),
    };
  }

  return {
    get list(): TabListState {
      return list;
    },
    init: (tabs: readonly InitTab[], activeTabId: string | null) =>
      queue.run(() => initNow(tabs, activeTabId)),
    openPath: (path: string, position?: Position) => queue.run(() => openNow(path, position ?? null)),
    activate: (tabId: string) => queue.run(() => activateNow(tabId)),
    newTab: () => queue.run(newTabNow),
    closeTab: (tabId: string) => queue.run(() => closeNow(tabId)),
    closeActive: () =>
      queue.run(async () => {
        if (list.activeId !== null) await closeNow(list.activeId);
      }),
    selectIndex: (n: number) =>
      queue.run(async () => {
        const tab = tabByIndex(list, n);
        if (tab) await activateNow(tab.id);
      }),
    cycle: (delta: 1 | -1) =>
      queue.run(async () => {
        const tab = neighbour(list, delta);
        if (tab) await activateNow(tab.id);
      }),
    /**
     * Run `fn` between tab operations — for AI commands. Inside it call only
     * `activateNow`: a queued method awaited from here waits for this very
     * slot and never runs.
     */
    runExclusive: <T>(fn: () => Promise<T>) => queue.run(fn),
    activateNow,
    findByPath: (path: string) => findByPath(list, path),
    /** Save As gave the active tab a new path. */
    renameActive(path: string): void {
      if (list.activeId !== null) publish(updateTab(list, list.activeId, { path }));
    },
    report,
  };
}

export type TabController = ReturnType<typeof createTabController>;
