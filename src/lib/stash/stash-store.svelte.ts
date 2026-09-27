/**
 * One window's stash drawer state (stash stage 04): the reducer state
 * (`stash-state.ts`), the whole live stash with a search index per entry, the
 * counts for the bar, who holds what elsewhere, the window's repo, and the
 * pulse / new-tag marks. Created by `App.svelte`, passed to `TabDrawer`. The
 * list has one load in flight at a time (`reload`); counts and holders are
 * sequence-guarded, so a slower, older answer never overwrites a newer one.
 * Failures are logged and leave the last good data on screen — the drawer is a
 * view of the database, and a failed read changes nothing in it.
 *
 * The store never listens to `stash-changed` itself: App already has the one
 * per-window listener (it also feeds `stash-marks`), and calls `changed()`.
 */
import { indexText, type SearchIndex } from '../tabs/drawer-filter';
import type { StashCounts } from './ipc';
import { STASH_CLOSED, closeStash, openStash, pulses, setRepoChip, type StashState } from './stash-state';
import type { StashEntry, TabHolder } from './types';

/** How long a card pulses (mockup `stPulse` 1.1 s, plus its 260 ms delay). */
export const PULSE_MS = 1400;
/** How long a new tag pops (mockup `tagIn` .9 s). */
export const NEW_TAG_MS = 1000;
/**
 * `stash-changed` events closer together than this share one reload: a
 * put-away of N tabs is N events, and every window reloads on each.
 */
export const RELOAD_COALESCE_MS = 120;

export interface StashStoreDeps {
  /** Every live entry (`listAllEntries`). */
  list(): Promise<StashEntry[]>;
  counts(): Promise<StashCounts>;
  holders(paths: string[]): Promise<(TabHolder | null)[]>;
  /** The window project's directory name (`windowProject().repo`, roadmap A3). */
  windowRepo(): Promise<string | null>;
}

export function createStashStore(deps: StashStoreDeps) {
  let state = $state.raw<StashState>(STASH_CLOSED);
  let entries = $state.raw<readonly StashEntry[]>([]);
  let indexes = $state.raw<ReadonlyMap<string, SearchIndex>>(new Map());
  let counts = $state.raw<StashCounts>({
    total: 0,
    stashedToday: 0,
    deleted: 0,
  });
  let holders = $state.raw<ReadonlyMap<string, TabHolder>>(new Map());
  let repo = $state<string | null>(null);
  let loaded = $state(false);
  let width = $state(0);
  let pulse = $state.raw<ReadonlySet<string>>(new Set());
  let newTags = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  /** Ids the drawer last rendered: only a card on screen can pulse. Nothing renders from it. */
  let shown: ReadonlySet<string> = new Set();
  /**
   * The union of `stash-changed` ids since the last load started, `null` once
   * any of those events came without ids (`pulses`' contract): the next load
   * then diffs the whole list. A load takes it as it starts; a failed one
   * gives it back for the load after.
   */
  let changedIds: Set<string> | null = new Set();
  /** The one list load in flight; a reload asked for meanwhile sets `dirty` and runs once after it. */
  let loading: Promise<void> | null = null;
  let dirty = false;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tabs drawer is open: its stash bar shows the counts (`setTabsOpen`). */
  let tabsOpen = false;
  let countSeq = 0;
  let holdersSeq = 0;

  function setEntries(next: readonly StashEntry[]): void {
    entries = next;
    indexes = new Map(next.map((e) => [e.id, indexText(e.preview)]));
    loaded = true;
  }

  function markPulse(ids: readonly string[]): void {
    if (ids.length === 0) return;
    pulse = new Set([...pulse, ...ids]);
    setTimeout(() => {
      pulse = new Set([...pulse].filter((id) => !ids.includes(id)));
    }, PULSE_MS);
  }

  function markNewTags(id: string, tags: readonly string[]): void {
    if (tags.length === 0) return;
    const next = new Map(newTags);
    next.set(id, tags);
    newTags = next;
    setTimeout(() => {
      if (newTags.get(id) !== tags) return;
      const after = new Map(newTags);
      after.delete(id);
      newTags = after;
    }, NEW_TAG_MS);
  }

  async function refreshCounts(): Promise<void> {
    const mine = ++countSeq;
    try {
      const next = await deps.counts();
      if (mine === countSeq) counts = next;
    } catch (err) {
      console.error('stash: counts failed', err);
    }
  }

  /** The window may have got its project since the last open; a chip that followed the old repo follows the new one. */
  async function refreshRepo(): Promise<void> {
    try {
      const next = await deps.windowRepo();
      if (next === repo) return;
      const followed = state.open && state.repoChip === repo;
      repo = next;
      if (followed) state = setRepoChip(state, next);
    } catch (err) {
      console.error('stash: window repo failed', err);
    }
  }

  async function refreshHolders(list: readonly StashEntry[] = entries): Promise<void> {
    const mine = ++holdersSeq;
    try {
      const found = await deps.holders(list.map((e) => e.path));
      if (mine !== holdersSeq) return;
      holders = new Map(
        list.flatMap((e, i): [string, TabHolder][] => {
          const h = found[i];
          return h ? [[e.path, h]] : [];
        })
      );
    } catch (err) {
      console.error('stash: holders failed', err);
    }
  }

  async function loadOnce(): Promise<void> {
    // Taken as the load starts: an event that lands while it is in flight may
    // postdate the list it reads, so its ids stay for the load after.
    const taken = changedIds;
    changedIds = new Set();
    let list: StashEntry[];
    try {
      list = await deps.list();
    } catch (err) {
      console.error('stash: list failed', err);
      if (taken === null || changedIds === null) changedIds = null;
      else for (const id of taken) changedIds.add(id);
      return;
    }
    const diff = pulses(entries, list, shown, taken === null ? undefined : [...taken]);
    setEntries(list);
    markPulse(diff.pulse);
    for (const [id, tags] of diff.newTags) markNewTags(id, tags);
    await refreshHolders(list);
  }

  /**
   * One load at a time: a reload asked for while one is in flight runs once
   * after it, however many were asked for — each would read the same newer
   * list. The promise settles when the last of them has.
   */
  function reload(): Promise<void> {
    if (loading) {
      dirty = true;
      return loading;
    }
    loading = (async () => {
      try {
        do {
          dirty = false;
          await loadOnce();
        } while (dirty);
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  return {
    get state(): StashState {
      return state;
    },
    get entries(): readonly StashEntry[] {
      return entries;
    },
    get indexes(): ReadonlyMap<string, SearchIndex> {
      return indexes;
    },
    get counts(): StashCounts {
      return counts;
    },
    get holders(): ReadonlyMap<string, TabHolder> {
      return holders;
    },
    get repo(): string | null {
      return repo;
    },
    get loaded(): boolean {
      return loaded;
    },
    /** The stash drawer's width, px, as `TabDrawer` laid it out (the toast stack moves by it). */
    get width(): number {
      return width;
    },
    get pulse(): ReadonlySet<string> {
      return pulse;
    },
    get newTags(): ReadonlyMap<string, readonly string[]> {
      return newTags;
    },
    update(fn: (s: StashState) => StashState): void {
      state = fn(state);
    },
    /** Opens at once with the last known repo; the list, counts and repo arrive after. */
    open(): void {
      const wasOpen = state.open;
      state = openStash(state, repo);
      if (wasOpen) return;
      void refreshRepo();
      void reload();
      void refreshCounts();
    },
    close(): void {
      state = closeStash(state);
    },
    reload,
    refreshCounts,
    /** The tabs drawer opened or closed: its stash bar's counts are read on open and kept fresh only while shown. */
    setTabsOpen(open: boolean): void {
      const opening = open && !tabsOpen;
      tabsOpen = open;
      if (opening) void refreshCounts();
    },
    /**
     * App's `stash-changed` listener: the bar's counts while the tabs drawer
     * is open, the list while the stash is. Events within
     * `RELOAD_COALESCE_MS` of each other share one reload. The ids are
     * collected either way — the next load diffs exactly what changed since
     * the one before. `reason` is not needed yet; it is taken so the call
     * mirrors `stashMarks.changed`.
     */
    changed(reason?: string, ids?: readonly string[]): void {
      if (ids === undefined) changedIds = null;
      else if (changedIds !== null) for (const id of ids) changedIds.add(id);
      if (!tabsOpen && !state.open) return;
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => {
        eventTimer = undefined;
        if (tabsOpen || state.open) void refreshCounts();
        if (state.open) void reload();
      }, RELOAD_COALESCE_MS);
    },
    setShown(ids: readonly string[]): void {
      shown = new Set(ids);
    },
    setWidth(px: number): void {
      width = px;
    },
    /** Entries a tag change returned: shown at once, before `stash-changed`. */
    upsert(list: readonly StashEntry[]): void {
      if (list.length === 0) return;
      const byId = new Map(list.map((e) => [e.id, e]));
      const next = entries.map((e) => byId.get(e.id) ?? e);
      for (const e of list) if (!entries.some((x) => x.id === e.id)) next.push(e);
      setEntries(next);
    },
    remove(id: string): void {
      setEntries(entries.filter((e) => e.id !== id));
    },
    markPulse,
    markNewTags,
  };
}

export type StashStore = ReturnType<typeof createStashStore>;
