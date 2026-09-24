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
  insertAt,
  neighbour,
  removeTab,
  reorderTabs,
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
  /** Drawer stamps from the session; `0` or absent: unknown — stamped now. */
  openedAt?: number;
  viewedAt?: number;
  unviewed?: boolean;
}

/** One tab on the heartbeat — the shape `tabs_sync` takes. */
export interface TabReport {
  tabId: string;
  path: string | null;
  cursor: number;
  topLine: number;
  content: string | null;
  openedAt: number;
  viewedAt: number;
  unviewed: boolean;
}

/** What `tab_open` answers. */
export type OpenAnswer =
  | { kind: 'created'; tabId: string }
  | { kind: 'this-window'; tabId: string }
  | { kind: 'other-window'; label: string }
  /** Rust could not be asked; no tab was registered, so none may be shown. */
  | { kind: 'failed' };

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
    /** A window of its own for `path` (Rust `open_file_window_cmd`). Rejects when none opened. */
    openWindow(path: string): Promise<void>;
  };
  /** A tab became active (`opened`: it was just opened, not switched to). */
  entered(path: string | null, opened: boolean): void;
  /** The list changed — for the UI. */
  changed(list: TabListState): void;
  /** An operation finished — report the tabs. */
  settled(): void;
  /** Wall clock, ms since the epoch — the drawer's stamps. */
  now(): number;
  /**
   * The human is looking at this window: it has keyboard focus. What makes an
   * activation a *view* (spec §2) — an agent activates tabs too.
   */
  windowFocused(): boolean;
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
  | { kind: 'cached'; state: EditorState; baseline: string | null }
  | { kind: 'fresh'; content: string; exists: boolean };

/** A state ready to be swapped in, built before anything is handed over. */
interface Entry {
  state: EditorState;
  swap: SwapOptions;
  dirty: boolean;
  baseline: string | null;
  restore: Position | null;
}

/** A file tab taken out of this window, as it was — to put back if its new window never opens. */
interface Detached {
  meta: TabMeta;
  path: string;
  /** Its index just before it left. */
  index: number;
  position: Position;
}

/** A tab "to new windows" left in this window: its window did not open. */
export interface Stranded {
  path: string;
  error: string;
}

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

  function newMeta(id: string, path: string | null): TabMeta {
    return { id, path, dirty: false, openedAt: deps.now(), viewedAt: 0, unviewed: false };
  }

  /** `id` is in front of the human: viewed now, no longer unviewed. */
  function markSeen(id: string): void {
    if (findById(list, id)) publish(updateTab(list, id, { viewedAt: deps.now(), unviewed: false }));
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
    await flushWithRetries();
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
    publish(updateTab(list, tab.id, deps.windowFocused() ? { dirty, viewedAt: deps.now() } : { dirty }));
  }

  /** Step 2: what entering `tab` will show. Nothing changes here. */
  async function prepare(tab: TabMeta): Promise<Ready | { kind: 'failed' }> {
    const cached = cache.get(tab.id);
    if (tab.path === null) {
      return cached?.state
        ? { kind: 'cached', state: cached.state, baseline: null }
        : { kind: 'fresh', content: cached?.content ?? '', exists: false };
    }
    try {
      const exists = await deps.disk.exists(tab.path);
      // A file deleted while its tab was in the background keeps its buffer,
      // as the active tab does: an empty state on that path would drop the
      // last copy of the text. No baseline, so the next save recreates it.
      if (!exists && cached?.state) return { kind: 'cached', state: cached.state, baseline: null };
      const content = exists ? await deps.disk.read(tab.path) : '';
      if (
        cached?.state &&
        decideEnter({ baseline: cached.baseline, disk: exists ? content : null }) === 'use-cache'
      ) {
        return { kind: 'cached', state: cached.state, baseline: cached.baseline };
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

  /** What entering `tab` will swap in. Builds a state, changes nothing. */
  function build(tab: TabMeta, ready: Ready, position: Position | null): Entry {
    const cached = cache.get(tab.id);
    if (ready.kind === 'cached') {
      return {
        state: ready.state,
        swap: { blur: false, scroll: !position && cached?.scroll ? cached.scroll : 'top' },
        dirty: tab.dirty,
        baseline: ready.baseline,
        restore: position,
      };
    }
    const restore =
      position ?? (cached ? { cursor: cached.cursor, topLine: cached.topLine } : null);
    return {
      state: deps.editor.createState(ready.content, restore ? restore.cursor : null),
      swap: { blur: true, scroll: 'top' },
      dirty: tab.path === null && ready.content.length > 0,
      baseline: ready.exists ? ready.content : null,
      restore,
    };
  }

  /** Step 4b: swap `tab` in. Synchronous; `tab` must already be in `list`. */
  function show(tab: TabMeta, entry: Entry): void {
    deps.editor.swap(entry.state, entry.swap);
    deps.doc.setActive(tab.path, entry.dirty, entry.baseline);
    deps.editor.applyDocumentConfig(tab.path);
    // The live view holds this tab now; its cache entry is rebuilt on leave.
    cache.delete(tab.id);
    publish(setActive(updateTab(list, tab.id, { dirty: deps.doc.dirty() }), tab.id));
  }

  /** Step 5: everything that follows the swap. */
  async function settle(tab: TabMeta, restore: Position | null, opened: boolean): Promise<void> {
    if (restore) await deps.editor.applyPosition(restore);
    await deps.rust.activate(tab.id);
    if (deps.windowFocused()) markSeen(tab.id);
    void deps.comments.reload();
    deps.entered(tab.path, opened);
    deps.settled();
  }

  async function enter(
    tab: TabMeta,
    ready: Ready,
    position: Position | null,
    opened: boolean
  ): Promise<void> {
    const entry = build(tab, ready, position);
    show(tab, entry);
    await settle(tab, entry.restore, opened);
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
    const now = deps.now();
    const metas: TabMeta[] = tabs.map((t) => ({
      id: t.tabId,
      path: t.path,
      dirty: t.path === null && (t.content ?? '') !== '',
      openedAt: t.openedAt || now,
      viewedAt: t.viewedAt ?? 0,
      unviewed: t.unviewed ?? false,
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
    const tab = newMeta(answer.tabId, null);
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
    let answer = await deps.rust.open(path);
    if (answer.kind === 'this-window' && !findById(list, answer.tabId)) {
      // A claim this window's list does not know is left over from an
      // operation that failed after claiming; nothing here shows it.
      await deps.rust.release(answer.tabId);
      answer = await deps.rust.open(path);
    }
    // A tab dedup cannot see would let the same file open a second time.
    if (answer.kind === 'failed') return;
    if (answer.kind === 'other-window') {
      await deps.rust.focusElsewhere(path);
      return;
    }
    if (answer.kind === 'this-window') {
      if (findById(list, answer.tabId)) {
        await activateNow(answer.tabId, { position: position ?? undefined });
      } else {
        console.error('tab_open keeps answering with a tab this window does not have:', path);
        await deps.rust.release(answer.tabId);
      }
      return;
    }
    const tab = newMeta(answer.tabId, path);
    const shown = await showClaimed(tab, { kind: 'fresh', content, exists }, position, () => {
      const previous = activeTab(list);
      // Re-checked here, after the last await: text typed into the blank tab
      // while the file was read makes it a tab worth keeping.
      if (replace && previous && isEmptyUntitled()) {
        deps.editor.stripForBackground();
        cache.delete(previous.id);
        publish(replaceTab(list, previous.id, tab));
        return previous.id;
      }
      stashActive();
      publish(insertAfterActive(list, tab));
      return null;
    });
    if (!shown) return;
    await settle(tab, shown.entry.restore, true);
    if (shown.placed !== null) await deps.rust.release(shown.placed);
  }

  /**
   * Hand the active document over and swap in `tab`, which Rust has just
   * claimed for this window; `place` puts it into the list, synchronously.
   * Until the swap the claim is ours to give back — on a refusal and on a
   * throw alike — or Rust keeps reporting a tab that nothing shows.
   */
  async function showClaimed<T>(
    tab: TabMeta,
    ready: Ready,
    position: Position | null,
    place: () => T
  ): Promise<{ entry: Entry; placed: T } | null> {
    let shown = false;
    try {
      const entry = build(tab, ready, position);
      if (!(await handOver())) return null;
      const placed = place();
      show(tab, entry);
      shown = true;
      return { entry, placed };
    } finally {
      if (!shown) await deps.rust.release(tab.id);
    }
  }

  async function openNow(path: string, position: Position | null): Promise<void> {
    deps.editor.commitCellEdit();
    await flushWithRetries();
    const local = findByPath(list, path);
    let owner: TabOwner = local ? { kind: 'this-window', tabId: local.id } : await deps.rust.owner(path);
    if (owner.kind === 'this-window' && !findById(list, owner.tabId)) {
      // Left over from an operation that failed after claiming.
      await deps.rust.release(owner.tabId);
      owner = { kind: 'none' };
    }
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
    const tab = newMeta(answer.tabId, null);
    const shown = await showClaimed(tab, { kind: 'fresh', content: '', exists: false }, null, () => {
      stashActive();
      publish(insertAfterActive(list, tab));
    });
    if (shown) await settle(tab, shown.entry.restore, true);
  }

  /**
   * Take `tabId` out of this window. `'close'` records it for ⌘⇧T and fails
   * its agents (Rust `tab_close`); `'release'` gives the claim back without a
   * closed-stack entry (Rust `tab_release`) — the tab moves to another window,
   * so a release never closes this one. `true` when the tab is gone from the list.
   */
  async function closeNow(tabId: string, how: 'close' | 'release' = 'close'): Promise<boolean> {
    if (!findById(list, tabId)) return false;
    const finish = (position: Position) =>
      how === 'close' ? deps.rust.close(tabId, position) : deps.rust.release(tabId);

    if (tabId !== list.activeId) {
      // A background tab is clean by construction and was handed over when
      // it was left; there is nothing to flush.
      const cached = cache.get(tabId);
      cache.delete(tabId);
      publish(removeTab(list, tabId).state);
      await finish({ cursor: cached?.cursor ?? 0, topLine: cached?.topLine ?? 1 });
      deps.settled();
      return true;
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
    if (verdict.kind !== 'ok') return false;
    // Nothing else here can be shown: releasing would close the window. Asked
    // before anything is handed over — the lookup only reads.
    const early = how === 'release' ? await prepareLoadable(removeTab(list, tabId).state) : null;
    if (early !== null && early.tab === null) return false;
    if (path !== null) {
      if (!(await deps.comments.flush(path))) return false;
      await deps.comments.commitPauses(path);
    }
    const state = deps.editor.current();
    const position: Position = {
      cursor: state?.selection.main.head ?? 0,
      topLine: deps.editor.topLine(),
    };

    const next = early ?? (await prepareLoadable(removeTab(list, tabId).state));
    await flushWithRetries();
    if (path !== null && deps.doc.dirty()) {
      // Typed into during the awaits: the tab stays, its cards come back.
      void deps.comments.reload();
      deps.reportUnsaved();
      return false;
    }

    // From the dirty check above to the swap, nothing awaits.
    if (path !== null) deps.comments.forget(path);
    deps.editor.stripForBackground();
    cache.delete(tabId);
    for (const id of next.failed) cache.delete(id);
    publish(next.working);
    if (next.tab === null) {
      await finish(position);
      await releaseAll(next.failed);
      deps.settled();
      await deps.rust.closeWindow();
      return true;
    }
    await enter(next.tab, next.ready, null, false);
    // After the swap: its Rust side fails the document's agents (and, for a
    // close, records it for ⌘⇧T); the watcher has already moved on.
    await finish(position);
    await releaseAll(next.failed);
    return true;
  }

  /** Background tabs first, the active one last: at most one swap for a group. */
  function backgroundFirst(ids: readonly string[]): string[] {
    const active = list.activeId;
    return [...ids.filter((id) => id !== active), ...ids.filter((id) => id === active)];
  }

  function positionOf(tabId: string): Position {
    if (tabId === list.activeId) {
      return { cursor: deps.editor.current()?.selection.main.head ?? 0, topLine: deps.editor.topLine() };
    }
    const c = cache.get(tabId);
    return { cursor: c?.cursor ?? 0, topLine: c?.topLine ?? 1 };
  }

  /**
   * Release file tabs for new windows of their own. Untitled tabs stay (a new
   * window opens by path), and the window is never emptied — its last tab
   * stays. Each released tab needs its window whatever happens next.
   */
  async function detachNow(ids: readonly string[]): Promise<Detached[]> {
    const out: Detached[] = [];
    for (const id of backgroundFirst(ids)) {
      const meta = findById(list, id);
      if (!meta || meta.path === null || list.tabs.length <= 1) continue;
      const detached = { meta, path: meta.path, index: list.tabs.indexOf(meta), position: positionOf(id) };
      try {
        if (await closeNow(id, 'release')) out.push(detached);
      } catch (err) {
        console.error('Failed to detach tab:', err);
      }
    }
    return out;
  }

  /**
   * A detached tab whose window never opened comes back where it was, in the
   * background: released and windowless it would be in no window at all. Its
   * text is on disk (only a clean tab can be detached), so it is re-registered
   * and read when next shown. Nothing is added when another window has it now.
   */
  async function adoptNow(d: Detached): Promise<void> {
    if (findByPath(list, d.path)) return;
    const answer = await deps.rust.open(d.path);
    if (answer.kind !== 'created' && answer.kind !== 'this-window') return;
    if (findById(list, answer.tabId)) return;
    cache.set(answer.tabId, {
      state: null,
      content: null,
      cursor: d.position.cursor,
      topLine: d.position.topLine,
      scroll: null,
      baseline: null,
    });
    publish(insertAt(list, d.index, { ...d.meta, id: answer.tabId, dirty: false }));
  }

  function report(live: { cursor: number; topLine: number; content: string }): {
    tabs: TabReport[];
    active: string | null;
  } {
    return {
      active: list.activeId,
      tabs: list.tabs.map((tab): TabReport => {
        const stamps = { openedAt: tab.openedAt, viewedAt: tab.viewedAt, unviewed: tab.unviewed };
        if (tab.id === list.activeId) {
          return {
            tabId: tab.id,
            path: tab.path,
            cursor: live.cursor,
            topLine: live.topLine,
            content: tab.path === null ? live.content : null,
            ...stamps,
          };
        }
        const c = cache.get(tab.id);
        return {
          tabId: tab.id,
          path: tab.path,
          cursor: c?.cursor ?? 0,
          topLine: c?.topLine ?? 1,
          content: tab.path === null ? (c?.state?.doc.toString() ?? c?.content ?? '') : null,
          ...stamps,
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
    /** The window gained or lost keyboard focus (spec §2: what counts as viewed). */
    windowFocusChanged: (focused: boolean) =>
      queue.run(async () => {
        const id = list.activeId;
        if (id === null) return;
        if (focused) markSeen(id);
        else publish(updateTab(list, id, { viewedAt: deps.now() }));
        deps.settled();
      }),
    /**
     * An agent's command landed on `tabId` while nobody was looking: it stays
     * unviewed until it is active in a focused window. Synchronous — call it
     * inside `runExclusive`, where the AI command already holds the queue.
     */
    markUnviewedNow(tabId: string): void {
      if (deps.windowFocused() || !findById(list, tabId)) return;
      publish(updateTab(list, tabId, { unviewed: true }));
      deps.settled();
    },
    /** The drawer's order — drag and sorts. A stale order is ignored. */
    reorder: (order: readonly string[]) =>
      queue.run(async () => {
        const next = reorderTabs(list, order);
        if (next === list) return;
        publish(next);
        deps.settled();
      }),
    /** Close a ⇧-selection (spec §6). Each goes the way ⌘W goes. */
    closeTabs: (ids: readonly string[]) =>
      queue.run(async () => {
        for (const id of backgroundFirst(ids)) await closeNow(id, 'close');
      }),
    /**
     * "To new windows" (spec §6): each selected file tab is released from this
     * window and opened in a window of its own, `open_file_window` cascading
     * them. Released first — a window opened while this one still held the
     * file would only focus this one. A tab whose window did not open comes
     * back here; resolves to those.
     */
    moveToNewWindows: (ids: readonly string[]) =>
      queue.run(async (): Promise<Stranded[]> => {
        const stranded: (Detached & { error: string })[] = [];
        for (const d of await detachNow(ids)) {
          try {
            await deps.rust.openWindow(d.path);
          } catch (err) {
            console.error('open_file_window_cmd failed:', err);
            stranded.push({ ...d, error: err instanceof Error ? err.message : String(err) });
          }
        }
        // In reverse: each goes back to the index it had just before it left.
        for (const d of [...stranded].reverse()) {
          try {
            await adoptNow(d);
          } catch (err) {
            console.error('Failed to bring a tab back:', err);
          }
        }
        if (stranded.length > 0) deps.settled();
        return stranded.map(({ path, error }) => ({ path, error }));
      }),
    /**
     * A tab's text without I/O: the live view for the active tab, the cached
     * state (or restored untitled text) for a background one, `null` for a
     * tab never shown since launch — the drawer reads that one from disk.
     */
    textOf(tabId: string): string | null {
      if (tabId === list.activeId) return deps.editor.current()?.doc.toString() ?? null;
      const c = cache.get(tabId);
      return c?.state?.doc.toString() ?? c?.content ?? null;
    },
    report,
  };
}

export type TabController = ReturnType<typeof createTabController>;
