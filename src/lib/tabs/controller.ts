import type { EditorState, StateEffect } from '@codemirror/state';
import { createSerialQueue } from '../serial-queue';
import { decideLeave, decideOpenAction, type TabOwner } from '../switch-document';
import { decideEnter } from './tab-cache';
import {
  activeTab,
  emptyTabList,
  expiredTransients,
  findById,
  findByPath,
  insertAfterActive,
  insertAt,
  neighbour,
  removeTab,
  removeTabs,
  reorderTabs,
  replaceTab,
  setActive,
  tabByIndex,
  updateTab,
  type TabListState,
  type TabMeta,
} from './tab-model';
import type { InboxItem } from './agent-inbox';
import type { MoveTarget } from './carousel';

/** Flush attempts before a still-dirty file tab refuses to be left. */
export const FLUSH_ATTEMPTS = 3;

/** Spec §7: a quick look seen and unanswered this long is "ignored". */
export const TRANSIENT_IGNORED_AFTER_MS = 60 * 60 * 1000;

/** File → «Короткие показы без ответа через час». */
export type TransientPolicy = 'keep' | 'close';

/**
 * Where a quick look came from: the agent's command itself created the tab —
 * the only tab a `show(transient)` may make one (D17). Typed so that a
 * `shown`/`existing` answer cannot be passed. `opened`: the `opened` answer
 * of `openPathNow` / `openBackgroundNow`. `fresh`: Rust built a window for
 * this very command, and the tab was born with it.
 */
export type QuickLookOrigin = { kind: 'opened'; tabId: string } | { kind: 'fresh'; tabId: string };

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
  /** A quick look carried by a move between windows (plan 05); absent for every other tab. */
  transient?: boolean;
  transientSeenAt?: number;
  /** What waited for the tab in its old window's agent inbox (plan 05). */
  inbox?: readonly InboxItem[];
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

/** One tab as it leaves for another window — the shape `tab_move` takes (Rust `MovedTab`). */
export interface MovedTab {
  tabId: string;
  /** An untitled tab's text; `null` for a file tab — the target reads its file. */
  content: string | null;
  cursor: number;
  topLine: number;
  openedAt: number;
  viewedAt: number;
  unviewed: boolean;
  transient: boolean;
  transientSeenAt: number;
  inbox: InboxItem[];
}

/** `tab_move`'s answer: where the tabs are now. */
export interface MoveDone {
  label: string;
  number: number | null;
}

export type MoveOutcome =
  | { kind: 'moved'; label: string; number: number | null; count: number }
  /** The active tab may not be left (its save has not landed, or a save error stands); the toast says why. */
  | { kind: 'refused' }
  /** Rust refused or could not be asked; the tabs are back where they stood. */
  | { kind: 'failed'; error: string };

export interface NewWindowsOutcome {
  moved: MoveDone[];
  stranded: Stranded[];
}

/**
 * What `tab_open` answers. `path` on `created`: the file as the registry
 * spells it (normalized), which the new tab takes — agents name it that way.
 */
export type OpenAnswer =
  | { kind: 'created'; tabId: string; path?: string | null }
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
     * The controller is leaving `tabId`, which stays open in the background:
     * the agents' live questions on it wait for its return (spec §5). Called
     * synchronously before the state is stripped of its ask widgets. `true`
     * when something was parked — the tab then shimmers.
     */
    leave(tabId: string): boolean;
    /** `tabId` was just shown and Rust knows it is active: deliver what waited for it. */
    enter(tabId: string): Promise<void>;
    /**
     * `tabId` left this window for good: drop what waited for it. Rust answers
     * its agents — `tab closed`, `tab released`, `window closed`.
     */
    forget(tabId: string): void;
    /** `tabId` leaves for another window: what waits for it, taken out (`agent.carry`). */
    carry(tabId: string): InboxItem[];
    /** `tabId` arrived with what waited for it in its old window (`agent.adopt`). */
    adopt(tabId: string, items: readonly InboxItem[]): void;
    hasLiveAsk(): boolean;
  };
  disk: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    /** Save a background tab's text — an agent's edit there. Rejects on failure. */
    write(path: string, content: string): Promise<void>;
  };
  rust: {
    owner(path: string): Promise<TabOwner>;
    open(path: string | null): Promise<OpenAnswer>;
    release(tabId: string): Promise<void>;
    activate(tabId: string): Promise<void>;
    close(tabId: string, position: Position): Promise<void>;
    focusElsewhere(path: string): Promise<void>;
    closeWindow(): Promise<void>;
    /** Move tabs of this window to `target` (Rust `tab_move`, atomic). Rejects when Rust refused. */
    move(tabs: MovedTab[], target: MoveTarget): Promise<MoveDone>;
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
  /** Where to put the caret when the tab is next shown — an agent's background `show`/`edit`. */
  enterAt: Position | null;
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

/** A tab «В новые окна» left in this window: its move was refused, or failed. */
export interface Stranded {
  path: string | null;
  /** Why it failed; `null`: refused here — the active tab could not be left, and the toast says why. */
  error: string | null;
}

type Loadable =
  | { working: TabListState; failed: string[]; tab: TabMeta; ready: Ready }
  | { working: TabListState; failed: string[]; tab: null; ready: null };

/** What `openBackgroundNow` did. `text`: the file as read, for resolving a target in it. */
export type BackgroundOpen =
  | { kind: 'opened'; tabId: string; text: string }
  | { kind: 'existing'; tabId: string }
  | { kind: 'other-window'; label: string }
  | { kind: 'failed' };

/**
 * What `openPathNow` did. `opened`: this call created the tab — the only tab a
 * `show` may make a quick look (D17). Rust's `fresh` cannot say so when the
 * tab landed in an existing window. `shown`: a tab this window already had is
 * active now. `elsewhere`: another window holds the file. `refused`: the
 * active tab may not be left (its save has not landed).
 */
export type OpenPathResult =
  | { kind: 'opened'; tabId: string }
  | { kind: 'shown'; tabId: string }
  | { kind: 'elsewhere' }
  | { kind: 'refused' }
  | { kind: 'failed' };

export type ApplyResult<T> =
  | { kind: 'applied'; result: T }
  | { kind: 'unchanged' }
  | { kind: 'failed'; error: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fromActivate(tabId: string, result: ActivateResult): OpenPathResult {
  if (result === 'ok' || result === 'noop') return { kind: 'shown', tabId };
  return result === 'failed' ? { kind: 'failed' } : { kind: 'refused' };
}

export function createTabController(deps: TabControllerDeps) {
  const queue = createSerialQueue();
  const cache = new Map<string, TabCache>();
  let list: TabListState = emptyTabList();

  /**
   * An AI command holds the queue (`runExclusive`). Every agent-driven change
   * to a tab runs only then — a stamp from outside could interleave with a
   * switch and mark the tab the human has just activated (D9).
   */
  let exclusive = false;

  function requireExclusive(what: string): boolean {
    if (!exclusive) console.error(`${what} called outside runExclusive; ignored`);
    return exclusive;
  }

  function publish(next: TabListState): void {
    list = next;
    deps.changed(list);
  }

  function newMeta(id: string, path: string | null): TabMeta {
    return { id, path, dirty: false, openedAt: deps.now(), viewedAt: 0, unviewed: false };
  }

  function cacheFromInit(t: InitTab): TabCache {
    return {
      state: null,
      content: t.content,
      cursor: t.cursor,
      topLine: t.topLine,
      scroll: null,
      baseline: null,
      enterAt: null,
    };
  }

  function metaFromInit(t: InitTab, now: number): TabMeta {
    return {
      id: t.tabId,
      path: t.path,
      dirty: t.path === null && (t.content ?? '') !== '',
      openedAt: t.openedAt || now,
      viewedAt: t.viewedAt ?? 0,
      unviewed: t.unviewed ?? false,
      ...(t.transient ? { transient: true, transientSeenAt: t.transientSeenAt ?? 0 } : {}),
    };
  }

  /** What waited for tabs that moved here, back into this window's inbox. */
  function adoptInboxes(tabs: readonly InitTab[]): void {
    for (const t of tabs) {
      if (t.inbox && t.inbox.length > 0) deps.ai.adopt(t.tabId, t.inbox);
    }
  }

  /**
   * `id` is in front of the human: viewed now, no longer unviewed. A quick
   * look's hour starts — and starts again when an agent landed on it since
   * (it was unviewed): the human has only now seen what it put there.
   */
  function markSeen(id: string): void {
    const tab = findById(list, id);
    if (!tab) return;
    const now = deps.now();
    publish(
      updateTab(list, id, {
        viewedAt: now,
        unviewed: false,
        ...(tab.transient && (!tab.transientSeenAt || tab.unviewed) ? { transientSeenAt: now } : {}),
      })
    );
  }

  /** An ordinary tab from now on. */
  function keepNow(tabId: string): void {
    if (findById(list, tabId)?.transient) {
      publish(updateTab(list, tabId, { transient: false, transientSeenAt: 0 }));
    }
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

  /**
   * Step 1 of leaving: nothing has been handed over yet. `quiet`: an agent
   * asked — its refusal lands in the background (D5) and shows no toast.
   */
  async function mayLeave(quiet = false): Promise<boolean> {
    deps.editor.commitCellEdit();
    await flushWithRetries();
    const verdict = decideLeave({
      activePath: deps.doc.path(),
      activeIsDirty: deps.doc.dirty(),
      saveErrorPending: deps.saveErrorPending(),
    });
    if (verdict.kind === 'refuse-unsaved' && !quiet) deps.reportUnsaved();
    return verdict.kind === 'ok';
  }

  /**
   * Step 3: hand the active document over. Comment text first — a pause
   * committed before its text is written would give an agent stale text, and
   * a failed write stops everything before anything is irreversible. An
   * agent's questions are not cancelled: `stashActive` parks them. A file tab
   * typed into during these awaits stays, and its cards are rebuilt.
   */
  async function handOver(quiet = false): Promise<boolean> {
    const path = deps.doc.path();
    if (path !== null) {
      if (!(await deps.comments.flush(path))) return false;
      await deps.comments.commitPauses(path);
    }
    await flushWithRetries();
    if (path !== null && deps.doc.dirty()) {
      void deps.comments.reload();
      if (!quiet) deps.reportUnsaved();
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
    // Before the strip clears them: the agents' live questions wait for the tab.
    const parked = deps.ai.leave(tab.id);
    deps.editor.stripForBackground();
    cache.set(tab.id, {
      state: deps.editor.current(),
      content: null,
      cursor,
      topLine,
      scroll,
      baseline,
      enterAt: null,
    });
    if (tab.path !== null) deps.comments.forget(tab.path);
    publish(
      updateTab(list, tab.id, {
        dirty,
        ...(deps.windowFocused() ? { viewedAt: deps.now() } : {}),
        // A question now waits there: it shimmers until the human goes back.
        ...(parked ? { unviewed: true } : {}),
      })
    );
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
      deps.ai.forget(id);
      await deps.rust.release(id);
    }
  }

  /** What entering `tab` will swap in. Builds a state, changes nothing. */
  function build(tab: TabMeta, ready: Ready, position: Position | null): Entry {
    const cached = cache.get(tab.id);
    // A position asked for now, else one an agent placed while it was away.
    const at = position ?? cached?.enterAt ?? null;
    if (ready.kind === 'cached') {
      return {
        state: ready.state,
        swap: { blur: false, scroll: !at && cached?.scroll ? cached.scroll : 'top' },
        dirty: tab.dirty,
        baseline: ready.baseline,
        restore: at,
      };
    }
    const restore = at ?? (cached ? { cursor: cached.cursor, topLine: cached.topLine } : null);
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
    // After `activate`: an answer from here comes from the window Rust sees showing it.
    // A failed delivery must not leave the switch unsettled.
    try {
      await deps.ai.enter(tab.id);
    } catch (err) {
      console.error('Failed to deliver what waited for the tab:', err);
    }
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
    for (const t of tabs) cache.set(t.tabId, cacheFromInit(t));
    const now = deps.now();
    const metas: TabMeta[] = tabs.map((t) => metaFromInit(t, now));
    // A window built for a move (plan 05) is born with them.
    adoptInboxes(tabs);
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

  /**
   * Tabs another window moved here (plan 05, D4). Rust registered them to this
   * window already: never `tab_open`ed. They go right after the active tab, in
   * order; the first one is shown unless the active tab may not be left — then
   * they wait in the background, and no toast says so: the human is in the
   * other window. A blank Untitled gives way, as it does for an agent's open —
   * among them the one a window built for the move shows when it mounted
   * before `tab_move` took the lock (its tabs then come by event, not init).
   */
  async function arriveNow(tabs: readonly InitTab[]): Promise<void> {
    const fresh = tabs.filter((t) => !findById(list, t.tabId));
    if (fresh.length === 0) return;
    const blank = isEmptyUntitled() ? list.activeId : null;
    const now = deps.now();
    const at = list.tabs.findIndex((t) => t.id === list.activeId);
    let next = list;
    fresh.forEach((t, k) => {
      cache.set(t.tabId, cacheFromInit(t));
      next = insertAt(next, at === -1 ? next.tabs.length : at + 1 + k, metaFromInit(t, now));
    });
    publish(next);
    adoptInboxes(fresh);
    const shown = await activateNow(fresh[0].tabId, { quiet: true });
    if (shown === 'ok' && blank !== null && blank !== fresh[0].tabId && findById(list, blank)) {
      await closeNow(blank, 'release');
      return;
    }
    if (shown !== 'ok') deps.settled();
  }

  async function activateNow(
    tabId: string,
    opts: { byAgent?: boolean; quiet?: boolean; position?: Position } = {}
  ): Promise<ActivateResult> {
    // An agent's switch is refused without a toast (`mayLeave`).
    const quiet = opts.byAgent === true || opts.quiet === true;
    const target = findById(list, tabId);
    if (!target) return 'failed';
    if (tabId === list.activeId) {
      if (opts.position) await deps.editor.applyPosition(opts.position);
      return 'noop';
    }
    // An agent never takes the view away from another agent's live question.
    if (opts.byAgent && deps.ai.hasLiveAsk()) return 'busy';
    if (!(await mayLeave(quiet))) return 'refused';
    const ready = await prepare(target);
    if (ready.kind === 'failed') return 'failed';
    if (!(await handOver(quiet))) return 'refused';
    stashActive();
    await enter(target, ready, opts.position ?? null, false);
    return 'ok';
  }

  async function openInNewTab(
    path: string,
    position: Position | null,
    replace: boolean,
    quiet: boolean
  ): Promise<OpenPathResult> {
    let content = '';
    let exists = false;
    try {
      exists = await deps.disk.exists(path);
      content = exists ? await deps.disk.read(path) : '';
    } catch (err) {
      console.error('Failed to open file:', err);
      return { kind: 'failed' };
    }
    let answer = await deps.rust.open(path);
    if (answer.kind === 'this-window' && !findById(list, answer.tabId)) {
      // A claim this window's list does not know is left over from an
      // operation that failed after claiming; nothing here shows it.
      await deps.rust.release(answer.tabId);
      answer = await deps.rust.open(path);
    }
    // A tab dedup cannot see would let the same file open a second time.
    if (answer.kind === 'failed') return { kind: 'failed' };
    if (answer.kind === 'other-window') {
      await deps.rust.focusElsewhere(path);
      return { kind: 'elsewhere' };
    }
    if (answer.kind === 'this-window') {
      if (findById(list, answer.tabId)) {
        return fromActivate(answer.tabId, await activateNow(answer.tabId, { position: position ?? undefined, quiet }));
      }
      console.error('tab_open keeps answering with a tab this window does not have:', path);
      await deps.rust.release(answer.tabId);
      return { kind: 'failed' };
    }
    const tab = newMeta(answer.tabId, answer.path ?? path);
    const shown = await showClaimed(tab, { kind: 'fresh', content, exists }, position, quiet, () => {
      const previous = activeTab(list);
      // Re-checked here, after the last await: text typed into the blank tab
      // while the file was read makes it a tab worth keeping.
      if (replace && previous && isEmptyUntitled()) {
        deps.editor.stripForBackground();
        cache.delete(previous.id);
        deps.ai.forget(previous.id);
        publish(replaceTab(list, previous.id, tab));
        return previous.id;
      }
      stashActive();
      publish(insertAfterActive(list, tab));
      return null;
    });
    if (!shown) return { kind: 'refused' };
    await settle(tab, shown.entry.restore, true);
    if (shown.placed !== null) await deps.rust.release(shown.placed);
    return { kind: 'opened', tabId: tab.id };
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
    quiet: boolean,
    place: () => T
  ): Promise<{ entry: Entry; placed: T } | null> {
    let shown = false;
    try {
      const entry = build(tab, ready, position);
      if (!(await handOver(quiet))) return null;
      const placed = place();
      show(tab, entry);
      shown = true;
      return { entry, placed };
    } finally {
      if (!shown) await deps.rust.release(tab.id);
    }
  }

  /** `quiet`: an agent's open (`openPathNow`) — a refusal shows no toast (D5). */
  async function openNow(path: string, position: Position | null, quiet = false): Promise<OpenPathResult> {
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
        return list.activeId === null ? { kind: 'failed' } : { kind: 'shown', tabId: list.activeId };
      case 'refuse-save-error':
        // The standing `save-error` toast already says why.
        return { kind: 'refused' };
      case 'refuse-unsaved':
        if (!quiet) deps.reportUnsaved();
        return { kind: 'refused' };
      case 'focus-other-window':
        await deps.rust.focusElsewhere(path);
        return { kind: 'elsewhere' };
      case 'activate-tab':
        return fromActivate(action.tabId, await activateNow(action.tabId, { position: position ?? undefined, quiet }));
      case 'replace-active':
      case 'open-new-tab':
        return openInNewTab(path, position, action.kind === 'replace-active', quiet);
    }
  }

  async function newTabNow(): Promise<void> {
    if (!(await mayLeave())) return;
    const answer = await deps.rust.open(null);
    if (answer.kind !== 'created') return;
    const tab = newMeta(answer.tabId, null);
    const shown = await showClaimed(tab, { kind: 'fresh', content: '', exists: false }, null, false, () => {
      stashActive();
      publish(insertAfterActive(list, tab));
    });
    if (shown) await settle(tab, shown.entry.restore, true);
  }

  /**
   * Take `tabId` out of this window. `'close'` records it for ⌘⇧T and fails
   * its agents (Rust `tab_close`); `'release'` gives the claim back without a
   * closed-stack entry (Rust `tab_release`) — a blank Untitled that gave way
   * to arrivals — so a release never closes this one. `true` when the tab is gone from the list.
   * `onLastTab` runs when closing it is about to close the window — an agent's
   * `close` answers there, before its window is gone. `quiet`: an agent's
   * close — its refusal is the agent's answer, not a toast (D5).
   */
  async function closeNow(
    tabId: string,
    how: 'close' | 'release' = 'close',
    onLastTab?: () => Promise<void>,
    quiet = false
  ): Promise<boolean> {
    if (!findById(list, tabId)) return false;
    const finish = (position: Position) =>
      how === 'close' ? deps.rust.close(tabId, position) : deps.rust.release(tabId);

    if (tabId !== list.activeId) {
      // A background tab is clean by construction and was handed over when
      // it was left; there is nothing to flush.
      const cached = cache.get(tabId);
      cache.delete(tabId);
      deps.ai.forget(tabId);
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
    if (verdict.kind === 'refuse-unsaved' && !quiet) deps.reportUnsaved();
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
      if (!quiet) deps.reportUnsaved();
      return false;
    }

    // From the dirty check above to the swap, nothing awaits.
    if (path !== null) deps.comments.forget(path);
    deps.editor.stripForBackground();
    cache.delete(tabId);
    deps.ai.forget(tabId);
    for (const id of next.failed) cache.delete(id);
    publish(next.working);
    if (next.tab === null) {
      await finish(position);
      await releaseAll(next.failed);
      deps.settled();
      if (onLastTab) await onLastTab();
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

  /** One tab as it leaves: what the target needs to show it as it was here (D2). */
  function outgoing(tab: TabMeta): MovedTab {
    const c = cache.get(tab.id);
    // Where an agent asked the caret to be on the next showing wins over where it was.
    const at = c?.enterAt ?? null;
    return {
      tabId: tab.id,
      content: tab.path === null ? (c?.state?.doc.toString() ?? c?.content ?? '') : null,
      cursor: at?.cursor ?? c?.cursor ?? 0,
      topLine: at?.topLine ?? c?.topLine ?? 1,
      openedAt: tab.openedAt,
      viewedAt: tab.viewedAt,
      unviewed: tab.unviewed,
      transient: tab.transient === true,
      transientSeenAt: tab.transientSeenAt ?? 0,
      inbox: deps.ai.carry(tab.id),
    };
  }

  /** Rust refused the move: the tabs come back where they stood, in the background, with what waited for them. */
  function putBack(before: TabListState, gone: readonly MovedTab[]): void {
    const ids = new Set(gone.map((g) => g.tabId));
    let back = list;
    for (const [index, tab] of before.tabs.entries()) {
      if (ids.has(tab.id) && !findById(back, tab.id)) back = insertAt(back, index, tab);
    }
    publish(back);
    for (const g of gone) {
      if (g.inbox.length > 0) deps.ai.adopt(g.tabId, g.inbox);
    }
  }

  /**
   * Move `ids` to another window (plan 05, D3): check → prepare → hand over →
   * swap → the one `await`, `tab_move` → settle. Nothing awaits between the
   * last dirty check and the swap, and the IPC comes after the swap: a key
   * typed meanwhile lands in the neighbour (or in a blank scratch state when
   * the window empties), never in a tab that is leaving. A move is neither a
   * close nor a release (D13): no `tab_close`/`tab_release`, and `ai.forget`
   * is not called — `outgoing` carries the inbox instead. Whatever Rust
   * answers, the window ends with `tab_activate` for the tab it shows (or
   * closes): Rust stops a watcher whose file moved.
   */
  async function moveNow(ids: readonly string[], target: MoveTarget): Promise<MoveOutcome> {
    const wanted = new Set(ids);
    // This window's order, not the caller's: a group lands as it stood here (D7).
    const moving = list.tabs.filter((t) => wanted.has(t.id)).map((t) => t.id);
    if (moving.length === 0) return { kind: 'failed', error: 'no such tab' };
    const activeMoves = list.activeId !== null && wanted.has(list.activeId);
    let next: Loadable | null = null;
    if (activeMoves) {
      if (!(await mayLeave())) return { kind: 'refused' };
      next = await prepareLoadable(removeTabs(list, moving).state);
      if (!(await handOver())) return { kind: 'refused' };
      // The swap starts here; nothing awaits until the IPC below.
      stashActive();
    }
    const before = list;
    const leaving = moving.flatMap((id) => {
      const tab = findById(list, id);
      return tab ? [outgoing(tab)] : [];
    });
    const failed = next?.failed ?? [];
    for (const id of failed) cache.delete(id);
    publish(next ? next.working : removeTabs(list, moving).state);
    let entry: Entry | null = null;
    if (next?.tab) {
      entry = build(next.tab, next.ready, null);
      show(next.tab, entry);
    } else if (activeMoves) {
      // The window empties: nothing of the leaving tabs stays in the live view.
      deps.editor.swap(deps.editor.createState('', null), { blur: true, scroll: 'top' });
      deps.doc.setActive(null, false, null);
    }
    let done: MoveDone | null = null;
    let error = '';
    try {
      done = await deps.rust.move(leaving, target);
    } catch (err) {
      error = message(err);
    }
    await releaseAll(failed);
    if (done === null) {
      putBack(before, leaving);
      if (next?.tab && entry) await settle(next.tab, entry.restore, false);
      else if (list.activeId === null) {
        if (before.activeId !== null) await activateNow(before.activeId, { quiet: true });
      } else {
        await deps.rust.activate(list.activeId);
      }
      deps.settled();
      return { kind: 'failed', error };
    }
    for (const id of moving) cache.delete(id);
    if (next?.tab && entry) await settle(next.tab, entry.restore, false);
    else deps.settled();
    // D6: an emptied window closes — after Rust holds its tabs elsewhere.
    if (list.tabs.length === 0) await deps.rust.closeWindow();
    return { kind: 'moved', label: done.label, number: done.number, count: leaving.length };
  }

  /** An agent opens `path` without switching to it (spec §5). The tab shimmers. */
  async function openBackgroundNow(path: string): Promise<BackgroundOpen> {
    if (!requireExclusive('openBackgroundNow')) return { kind: 'failed' };
    const local = findByPath(list, path);
    if (local) return { kind: 'existing', tabId: local.id };
    let text = '';
    try {
      text = (await deps.disk.exists(path)) ? await deps.disk.read(path) : '';
    } catch (err) {
      console.error('Failed to open file:', err);
      return { kind: 'failed' };
    }
    let answer = await deps.rust.open(path);
    if (answer.kind === 'this-window' && !findById(list, answer.tabId)) {
      // Left over from an operation that failed after claiming.
      await deps.rust.release(answer.tabId);
      answer = await deps.rust.open(path);
    }
    if (answer.kind === 'other-window') return { kind: 'other-window', label: answer.label };
    if (answer.kind === 'this-window') {
      if (findById(list, answer.tabId)) return { kind: 'existing', tabId: answer.tabId };
      await deps.rust.release(answer.tabId);
      return { kind: 'failed' };
    }
    if (answer.kind !== 'created') return { kind: 'failed' };
    cache.set(answer.tabId, {
      state: null,
      content: null,
      cursor: 0,
      topLine: 1,
      scroll: null,
      baseline: null,
      enterAt: null,
    });
    publish(insertAfterActive(list, { ...newMeta(answer.tabId, answer.path ?? path), unviewed: true }));
    deps.settled();
    return { kind: 'opened', tabId: answer.tabId, text };
  }

  /** Where a background tab opens next time it is shown. `false`: not a background tab. */
  function placeCaretNow(tabId: string, position: Position): boolean {
    if (!requireExclusive('placeCaretNow')) return false;
    if (tabId === list.activeId || !findById(list, tabId)) return false;
    const cached = cache.get(tabId);
    const state = cached?.state
      ? cached.state.update({ selection: { anchor: Math.min(position.cursor, cached.state.doc.length) } }).state
      : null;
    cache.set(tabId, {
      state,
      content: cached?.content ?? null,
      cursor: position.cursor,
      topLine: position.topLine,
      scroll: null,
      baseline: cached?.baseline ?? null,
      enterAt: position,
    });
    return true;
  }

  /**
   * An agent's change to a background file tab (spec §5): applied to its
   * cached state — or one built from disk when it was never shown or the
   * disk moved on — and written at once, so the tab stays clean (a
   * background tab has no autosave). Undo and highlights live in the state
   * and are there when the tab is shown; the new baseline makes return reuse
   * it. A failed write changes nothing.
   */
  async function applyToTabNow<T>(
    tabId: string,
    edit: (state: EditorState) => { state: EditorState; result: T } | null
  ): Promise<ApplyResult<T>> {
    if (!requireExclusive('applyToTabNow')) return { kind: 'failed', error: 'not inside runExclusive' };
    const tab = findById(list, tabId);
    if (!tab || tab.path === null || tab.id === list.activeId) {
      return { kind: 'failed', error: 'not a background file tab' };
    }
    const cached = cache.get(tabId);
    let base: EditorState;
    try {
      const exists = await deps.disk.exists(tab.path);
      const disk = exists ? await deps.disk.read(tab.path) : '';
      // As `prepare`: a file deleted while in the background keeps its
      // buffer — an empty base would write over the last copy of the text.
      base =
        cached?.state &&
        (!exists || decideEnter({ baseline: cached.baseline, disk }) === 'use-cache')
          ? cached.state
          : deps.editor.createState(disk, cached?.cursor ?? 0);
    } catch (err) {
      return { kind: 'failed', error: message(err) };
    }
    const out = edit(base);
    if (!out) return { kind: 'unchanged' };
    const text = out.state.doc.toString();
    try {
      await deps.disk.write(tab.path, text);
    } catch (err) {
      return { kind: 'failed', error: message(err) };
    }
    cache.set(tabId, {
      state: out.state,
      content: null,
      cursor: out.state.selection.main.head,
      topLine: cached?.topLine ?? 1,
      scroll: cached?.scroll ?? null,
      baseline: text,
      enterAt: cached?.enterAt ?? null,
    });
    return { kind: 'applied', result: out.result };
  }

  /**
   * The text a tab shows or will show when entered: the live view, an
   * untitled tab's own text, a file tab's disk (what entering it reads).
   * `null`: no such tab, or the file cannot be read.
   */
  async function textForAgentNow(tabId: string): Promise<string | null> {
    if (tabId === list.activeId) return deps.editor.current()?.doc.toString() ?? null;
    const tab = findById(list, tabId);
    if (!tab) return null;
    const cached = cache.get(tabId);
    if (tab.path === null) return cached?.state?.doc.toString() ?? cached?.content ?? '';
    try {
      if (!(await deps.disk.exists(tab.path))) return cached?.state?.doc.toString() ?? '';
      return await deps.disk.read(tab.path);
    } catch {
      return null;
    }
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
    openPath: (path: string, position?: Position) =>
      queue.run(async () => {
        await openNow(path, position ?? null);
      }),
    activate: (tabId: string) => queue.run(() => activateNow(tabId)),
    newTab: () => queue.run(newTabNow),
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
     * the `*Now` methods: a queued method awaited from here waits for this
     * very slot and never runs. Agent-driven stamps are accepted only here.
     */
    runExclusive: <T>(fn: () => Promise<T>) =>
      queue.run(async () => {
        exclusive = true;
        try {
          return await fn();
        } finally {
          exclusive = false;
        }
      }),
    activateNow,
    /** `openPath` for an AI command, inside `runExclusive`. Says whether it opened the tab. */
    openPathNow: async (path: string, position?: Position): Promise<OpenPathResult> =>
      requireExclusive('openPathNow') ? openNow(path, position ?? null, true) : { kind: 'failed' },
    openBackgroundNow,
    placeCaretNow,
    applyToTabNow,
    textForAgentNow,
    /**
     * ⌘W for an agent's `close`, inside `runExclusive` (see `closeNow`'s
     * `onLastTab`). File tabs only: an agent never closes an untitled tab (spec §8).
     */
    closeTabNow: async (tabId: string, onLastTab?: () => Promise<void>): Promise<boolean> => {
      if (!requireExclusive('closeTabNow')) return false;
      if (findById(list, tabId)?.path == null) return false;
      return closeNow(tabId, 'close', onLastTab, true);
    },
    findByPath: (path: string) => findByPath(list, path),
    /** The active tab is an untitled one with no text — the tab an open replaces. */
    activeIsEmptyUntitled: isEmptyUntitled,
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
     * An agent's command landed on `tabId` and nobody is looking at it: it
     * stays unviewed until it is active in a focused window. Only the active
     * tab of a focused window is "being looked at". Inside `runExclusive` only.
     */
    markUnviewedNow(tabId: string): void {
      if (!requireExclusive('markUnviewedNow') || !findById(list, tabId)) return;
      if (tabId === list.activeId && deps.windowFocused()) return;
      publish(updateTab(list, tabId, { unviewed: true }));
      deps.settled();
    },
    /**
     * `show(transient)` opened a tab: it becomes a quick look (spec §7). Only
     * with the typed origin saying the command itself opened it (D17) — a tab
     * the human already had never becomes one. File tabs only; a tab that
     * already is one keeps its clock. Seen at once when it is in front of the
     * human. Inside `runExclusive` only.
     */
    markTransientNow(origin: QuickLookOrigin): void {
      if (!requireExclusive('markTransientNow')) return;
      const tab = findById(list, origin.tabId);
      if (!tab || tab.path === null || tab.transient) return;
      const seen = tab.id === list.activeId && deps.windowFocused();
      publish(updateTab(list, tab.id, { transient: true, transientSeenAt: seen ? deps.now() : 0 }));
    },
    /** «Оставить»: an ordinary tab from now on. */
    keepTransient: (tabId: string) => queue.run(async () => keepNow(tabId)),
    /**
     * The human changed the live document — any way at all: a key, ⌘V, ⌘X,
     * ⌘B, a checkbox, a drop, the hover menu. Editing a quick look is
     * «Оставить» (D17). Synchronous and unqueued, so an EditorView update
     * listener can call it, even while an agent command holds the queue: the
     * live view always shows the active tab (a swap runs no update listeners),
     * so the edited tab is the active one.
     */
    humanEdited(): void {
      if (list.activeId !== null) keepNow(list.activeId);
    },
    /** «Закрыть»: the ⌘W way — ⌘⇧T brings it back. An ordinary tab is left alone. */
    closeTransient: (tabId: string) =>
      queue.run(async () => {
        if (findById(list, tabId)?.transient) await closeNow(tabId, 'close');
      }),
    /**
     * Spec §7: ignored quick looks, by the File-menu policy. Called on a
     * timer. The active tab never expires, whether its window has focus or
     * not (team-lead decision on the Task 10 review, reversible): md-mini
     * usually sits unfocused beside the agent's terminal while the human
     * reads it, and closing that document — failing a live ask there with
     * `tab closed` — is worse than a quick look that stays while it is in
     * front. It expires once it is in the background. So every close here is
     * of a background tab, clean by construction, and goes the ⌘W way.
     */
    expireTransients: (policy: TransientPolicy) =>
      queue.run(async () => {
        const ids = expiredTransients(list, deps.now(), TRANSIENT_IGNORED_AFTER_MS, list.activeId);
        if (ids.length === 0) return;
        for (const id of ids) {
          if (policy === 'close') await closeNow(id, 'close');
          else keepNow(id);
        }
        deps.settled();
      }),
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
    /** Move `ids` (in this window's order) to another window or a new one (plan 05). */
    moveTabs: (ids: readonly string[], target: MoveTarget) => queue.run(() => moveNow(ids, target)),
    /** Tabs another window moved here (`tabs-arrive`). */
    arrive: (tabs: readonly InitTab[]) => queue.run(() => arriveNow(tabs)),
    /**
     * «В новые окна» (spec §6, D7): each selected tab, in this window's order,
     * into a window of its own — the one move every move is, never a release:
     * agents keep waiting, and stamps, caret and quick look go with the tab. A
     * tab whose move was refused or failed stays here and is reported.
     */
    moveToNewWindows: (ids: readonly string[]) =>
      queue.run(async (): Promise<NewWindowsOutcome> => {
        const moved: MoveDone[] = [];
        const stranded: Stranded[] = [];
        for (const tab of list.tabs.filter((t) => ids.includes(t.id))) {
          const outcome = await moveNow([tab.id], { kind: 'new-window' });
          if (outcome.kind === 'moved') moved.push({ label: outcome.label, number: outcome.number });
          else stranded.push({ path: tab.path, error: outcome.kind === 'failed' ? outcome.error : null });
        }
        return { moved, stranded };
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
