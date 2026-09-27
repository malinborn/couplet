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
 * The same goes for search (stage 05): every list load searches the active
 * query again, so a coalesced burst of events is one search, not one each.
 */
import { indexText, type SearchIndex } from '../tabs/drawer-filter';
import type { StashCounts, StashSearchArgs, StashSearchResult } from './ipc';
import { createSearchRunner, type SearchRequest } from './stash-search';
import {
  STASH_CLOSED,
  closeStash,
  openStash,
  pulses,
  setRepoChip,
  showStash,
  showTrash,
  type StashState,
} from './stash-state';
import { sortTrash } from './trash-view';
import type { DeleteOutcome, StashEntry, StashHit, TabHolder } from './types';

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
  /**
   * `stash_search` (stage 05). Absent, the store never searches and the
   * drawer keeps stage 04's local substring filter.
   */
  search?(args: StashSearchArgs): Promise<StashSearchResult>;
  /**
   * The trash (stage 06): `listTrash`, `stash_restore`, `stash_purge`,
   * `stash_delete`. Absent (stage 04's tests), the trash stays empty and every
   * action answers `failed`.
   */
  trash?: StashTrashDeps;
}

export interface StashTrashDeps {
  list(): Promise<StashEntry[]>;
  restore(id: string): Promise<StashEntry>;
  purge(id: string): Promise<void>;
  remove(id: string): Promise<DeleteOutcome>;
}

/**
 * What a card action came to. `busy`: that card already has one in flight,
 * nothing was sent. The store never toasts — App maps these to `stash` notes.
 */
export type TrashActionOutcome =
  | { kind: 'restored'; entry: StashEntry; hiddenBy: string | null }
  | { kind: 'purged' }
  | { kind: 'busy' }
  | { kind: 'failed'; message: string };

export type RemoveOutcome = DeleteOutcome | { kind: 'busy' } | { kind: 'failed'; message: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  /**
   * Per pulsing id: `timer` is the pulse that owns its end (only the latest
   * may end it), `n` counts that card's pulses — its parity picks one of two
   * identical CSS animations, so a repeat restarts rather than runs on.
   */
  let pulseMarks = $state.raw<ReadonlyMap<string, { timer: number; n: number }>>(new Map());
  let pulseSeq = 0;
  let newTags = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  /** The active query's hits in relevance order; `null`: no text, or the search failed. */
  let hits = $state.raw<readonly StashHit[] | null>(null);
  let searchTotal = $state(0);
  const search = deps.search;
  const runner = search
    ? createSearchRunner({
        search: (args) => search(args),
        onResult: (res) => {
          hits = res?.hits ?? null;
          searchTotal = res?.total ?? 0;
        },
        onError: (err) => {
          // `npm run dev` has no IPC, and a broken index must not blank the drawer.
          console.error('stash search failed; using the local filter', err);
          hits = null;
          searchTotal = 0;
        },
      })
    : null;
  /** The trash, newest deletion first; read on every entry into it and on `stash-changed` while shown. */
  let trashEntries = $state.raw<readonly StashEntry[]>([]);
  let trashLoaded = $state(false);
  let trashSeq = 0;
  /** Cards with an action in flight: a second click must not send a second IPC. */
  const busy = new Set<string>();
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
  /**
   * Opened from closed, the stash has no picture on screen to compare a load
   * with: nothing pulses or pops until a load started after the open is in.
   * `openSeq` tells such a load from one still in flight from before.
   */
  let quiet = false;
  let openSeq = 0;

  function setEntries(next: readonly StashEntry[]): void {
    entries = next;
    indexes = new Map(next.map((e) => [e.id, indexText(e.preview)]));
    loaded = true;
  }

  function markPulse(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const timer = ++pulseSeq;
    const marks = new Map(pulseMarks);
    for (const id of ids) marks.set(id, { timer, n: (pulseMarks.get(id)?.n ?? 0) + 1 });
    pulseMarks = marks;
    pulse = new Set([...pulse, ...ids]);
    setTimeout(() => {
      const ending = ids.filter((id) => pulseMarks.get(id)?.timer === timer);
      if (ending.length === 0) return;
      pulse = new Set([...pulse].filter((id) => !ending.includes(id)));
      const after = new Map(pulseMarks);
      for (const id of ending) after.set(id, { timer: 0, n: after.get(id)?.n ?? 0 });
      pulseMarks = after;
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
    const startedAt = openSeq;
    let list: StashEntry[];
    try {
      list = await deps.list();
    } catch (err) {
      console.error('stash: list failed', err);
      if (taken === null || changedIds === null) changedIds = null;
      else for (const id of taken) changedIds.add(id);
      return;
    }
    const silent = quiet;
    if (startedAt === openSeq) quiet = false;
    const diff = pulses(entries, list, shown, taken === null ? undefined : [...taken]);
    setEntries(list);
    if (!silent) {
      markPulse(diff.pulse);
      for (const [id, tags] of diff.newTags) markNewTags(id, tags);
    }
    // What changed the list may have changed what matches (a rebuilt index too).
    runner?.refresh();
    await refreshHolders(list);
  }

  /** Entries a tag change or a restore returned: shown at once, before `stash-changed`. */
  function upsert(list: readonly StashEntry[]): void {
    if (list.length === 0) return;
    const byId = new Map(list.map((e) => [e.id, e]));
    const next = entries.map((e) => byId.get(e.id) ?? e);
    for (const e of list) if (!entries.some((x) => x.id === e.id)) next.push(e);
    setEntries(next);
  }

  /**
   * «Удалённые» (stage 06): the view switches at once, the list is read again.
   * The list left behind is dropped on the way in (review M8): `stash-changed`
   * reloads the trash only while it is shown, so the old cards may name notes
   * restored or purged since — the drawer shows its loading state instead.
   * Here rather than in `leaveTrash`, because closing the stash leaves the
   * trash without it.
   */
  function enterTrash(): void {
    if (!state.open) return;
    if (state.mode !== 'trash') {
      trashEntries = [];
      trashLoaded = false;
    }
    state = showTrash(state);
    void reloadTrash();
  }

  function leaveTrash(): void {
    state = showStash(state);
  }

  /** Latest wins: an older answer that lands after a newer one is dropped. */
  async function reloadTrash(): Promise<void> {
    if (!deps.trash) return;
    const mine = ++trashSeq;
    try {
      const list = await deps.trash.list();
      if (mine !== trashSeq) return;
      trashEntries = sortTrash(list);
      trashLoaded = true;
    } catch (err) {
      console.error('stash: trash list failed', err);
    }
  }

  /** One action per card at a time; a failure keeps the card and answers why. */
  async function act<T>(
    id: string,
    run: (trash: StashTrashDeps) => Promise<T>
  ): Promise<T | { kind: 'busy' } | { kind: 'failed'; message: string }> {
    const trash = deps.trash;
    if (!trash) return { kind: 'failed', message: 'the trash is not available' };
    if (busy.has(id)) return { kind: 'busy' };
    busy.add(id);
    try {
      return await run(trash);
    } catch (err) {
      return { kind: 'failed', message: message(err) };
    } finally {
      busy.delete(id);
    }
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
    get hits(): readonly StashHit[] | null {
      return hits;
    },
    /**
     * How many entries matched in all. The drawer filters the hits further by
     * its repo chip and `#tag`s, so under them this is an upper bound of its rows.
     */
    get searchTotal(): number {
      return searchTotal;
    },
    /** The drawer's query changed: search its text (debounced), or drop the hits. */
    search(req: SearchRequest): void {
      runner?.request(req);
    },
    /** How many times this card has pulsed: `StashCard`'s `pulseKey`. */
    pulseKey(id: string): number {
      return pulseMarks.get(id)?.n ?? 0;
    },
    update(fn: (s: StashState) => StashState): void {
      state = fn(state);
    },
    /** Opens at once with the last known repo; the list, counts and repo arrive after. */
    open(): void {
      const wasOpen = state.open;
      state = openStash(state, repo);
      if (wasOpen) return;
      // What changed while closed was diffed against a picture nobody saw (M8).
      changedIds = new Set();
      quiet = true;
      openSeq++;
      void refreshRepo();
      void reload();
      void refreshCounts();
    },
    close(): void {
      state = closeStash(state);
    },
    enterTrash,
    leaveTrash,
    toggleTrash(): void {
      if (state.mode === 'trash') leaveTrash();
      else enterTrash();
    },
    get trashEntries(): readonly StashEntry[] {
      return trashEntries;
    },
    get trashLoaded(): boolean {
      return trashLoaded;
    },
    /** What the trash bar counts: every trashed note, whatever the repo chip (D13). */
    get trashTotal(): number {
      return counts.deleted;
    },
    /**
     * «удалить» / «убрать из тайника» on a stash card. Can wait ~10 s for
     * another window to let go of the note's tab: App awaits it outside the
     * tab queue. The card leaves the list at once (`stash-changed` confirms).
     */
    removeEntry(entry: StashEntry): Promise<RemoveOutcome> {
      return act(entry.id, async (trash) => {
        const out = await trash.remove(entry.id);
        if (out.kind === 'kept') return out;
        setEntries(entries.filter((e) => e.id !== entry.id));
        if (out.kind === 'trashed' && trashLoaded) {
          trashEntries = sortTrash([out.entry, ...trashEntries.filter((e) => e.id !== entry.id)]);
        }
        return out;
      });
    },
    /** «вернуть»: out of the trash, into the stash on top (`stashedAt` = now), tags kept. */
    restoreEntry(entry: StashEntry): Promise<TrashActionOutcome> {
      return act(entry.id, async (trash): Promise<TrashActionOutcome> => {
        const restored = await trash.restore(entry.id);
        trashEntries = trashEntries.filter((e) => e.id !== entry.id);
        upsert([restored]);
        const chip = state.repoChip;
        return { kind: 'restored', entry: restored, hiddenBy: chip !== null && restored.repo !== chip ? chip : null };
      });
    },
    /** «удалить навсегда»: no confirmation (plan D15). */
    purgeEntry(entry: StashEntry): Promise<TrashActionOutcome> {
      return act(entry.id, async (trash): Promise<TrashActionOutcome> => {
        await trash.purge(entry.id);
        trashEntries = trashEntries.filter((e) => e.id !== entry.id);
        return { kind: 'purged' };
      });
    },
    reload,
    refreshCounts,
    /**
     * «открыта в #N» only (`tab_holders`), not the list: tabs move between
     * windows without a `stash-changed`. App calls it when the window gains
     * focus; a (re)open reads it with the list.
     */
    refreshHolders: (): Promise<void> => refreshHolders(),
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
        if (state.open && state.mode === 'trash') void reloadTrash();
      }, RELOAD_COALESCE_MS);
    },
    setShown(ids: readonly string[]): void {
      shown = new Set(ids);
    },
    setWidth(px: number): void {
      width = px;
    },
    upsert,
    remove(id: string): void {
      setEntries(entries.filter((e) => e.id !== id));
    },
    markPulse,
    markNewTags,
  };
}

export type StashStore = ReturnType<typeof createStashStore>;
