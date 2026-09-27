import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PULSE_MS, RELOAD_COALESCE_MS, createStashStore, type StashStoreDeps } from './stash-store.svelte';
import type { StashSearchArgs, StashSearchResult } from './ipc';
import { SEARCH_DEBOUNCE_MS, type SearchRequest } from './stash-search';
import { closeStash, setStashQuery, showStash } from './stash-state';
import type { DeleteOutcome, StashEntry, StashHit, TabHolder } from './types';

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: 10,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: `# ${id}\nline of ${id}`,
    ...over,
  };
}

function deps(
  over: Omit<Partial<StashStoreDeps>, 'holders'> & {
    entries?: StashEntry[];
    repo?: string | null;
    holders?: (TabHolder | null)[];
  } = {}
) {
  const entries = over.entries ?? [entry('a'), entry('b')];
  return {
    list: over.list ?? vi.fn(async () => entries),
    counts:
      over.counts ??
      vi.fn(async () => ({
        total: entries.length,
        stashedToday: 1,
        deleted: 0,
      })),
    holders: over.holders
      ? vi.fn(async () => over.holders ?? [])
      : vi.fn(async (paths: string[]) => paths.map((): TabHolder | null => null)),
    windowRepo: over.windowRepo ?? vi.fn(async () => over.repo ?? null),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** `stash-changed` events wait `RELOAD_COALESCE_MS` for company, then load. */
async function settleEvents(): Promise<void> {
  vi.advanceTimersByTime(RELOAD_COALESCE_MS);
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('stash store', () => {
  it('opens at once and fills in: entries, indexes, counts, holders, the repo chip', async () => {
    const d = deps({
      repo: 'infra',
      holders: [null, { label: 'editor-2', number: 7 }],
    });
    const s = createStashStore(d);
    s.open();
    expect(s.state.open).toBe(true);
    expect(s.state.focus).toBe('stash');
    await flush();
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(s.indexes.get('b')?.lines).toEqual(['b', 'line of b']);
    expect(s.counts.total).toBe(2);
    expect(s.holders.get('/n/b.md')).toEqual({ label: 'editor-2', number: 7 });
    expect(s.repo).toBe('infra');
    expect(s.state.repoChip).toBe('infra');
    expect(s.loaded).toBe(true);
  });

  it('opening an open stash only refocuses, no second load', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.open();
    await flush();
    s.update((st) => ({ ...st, focus: 'tabs' }));
    s.open();
    expect(s.state.focus).toBe('stash');
    expect(d.list).toHaveBeenCalledTimes(1);
  });

  it('a reload asked for mid-load runs once, after it, and its answer stays', async () => {
    const first = deferred<StashEntry[]>();
    const second = deferred<StashEntry[]>();
    const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const s = createStashStore(deps({ list }));
    void s.reload();
    void s.reload();
    void s.reload();
    expect(list).toHaveBeenCalledTimes(1);
    second.resolve([entry('b')]);
    first.resolve([entry('a')]);
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(s.entries.map((e) => e.id)).toEqual(['b']);
  });

  it('stash-changed with both drawers closed reads nothing', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.changed('put-away', ['a']);
    await settleEvents();
    expect(d.counts).not.toHaveBeenCalled();
    expect(d.list).not.toHaveBeenCalled();
  });

  it('with only the tabs drawer open it refreshes the bar counts, not the list', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.setTabsOpen(true);
    await flush();
    expect(d.counts, 'read as the tabs drawer opens').toHaveBeenCalledTimes(1);
    s.changed('put-away', ['a']);
    await settleEvents();
    expect(d.counts).toHaveBeenCalledTimes(2);
    expect(d.list).not.toHaveBeenCalled();
    s.setTabsOpen(false);
    s.changed('put-away', ['b']);
    await settleEvents();
    expect(d.counts).toHaveBeenCalledTimes(2);
  });

  it('stash-changed while open reloads the list and the counts', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.open();
    await flush();
    s.changed('title', ['a']);
    await settleEvents();
    expect(d.list).toHaveBeenCalledTimes(2);
    expect(d.counts).toHaveBeenCalledTimes(2);
  });

  it('five events in a burst cost one reload, not five', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.open();
    await flush();
    for (const id of ['a', 'b', 'a', 'b', 'a']) s.changed('put-away', [id]);
    await settleEvents();
    expect(d.list).toHaveBeenCalledTimes(2);
    expect(d.counts).toHaveBeenCalledTimes(2);
    expect(d.holders).toHaveBeenCalledTimes(2);
  });

  it('events spread over a slow load cost one more load after it, which diffs their union', async () => {
    let stashed = 10;
    let gate: ReturnType<typeof deferred<void>> | null = null;
    const list = vi.fn(async () => {
      // The database is read as the call goes out, however late the answer comes.
      const at = stashed;
      if (gate) await gate.promise;
      return ['a', 'b', 'c', 'd'].map((id) => entry(id, { stashedAt: at }));
    });
    const s = createStashStore(deps({ list }));
    s.open();
    await flush();
    s.setShown(['a', 'b', 'c', 'd']);
    const slow = deferred<void>();
    gate = slow;
    s.changed('title', ['a']);
    await settleEvents();
    expect(list).toHaveBeenCalledTimes(2);
    // The load is in flight; these land one by one, each past the coalescing window.
    stashed = 20;
    for (const id of ['b', 'c']) {
      s.changed('put-away', [id]);
      await settleEvents();
    }
    s.changed('put-away', ['d']);
    await settleEvents();
    expect(list, 'nothing more while one load is in flight').toHaveBeenCalledTimes(2);
    gate = null;
    slow.resolve();
    await flush();
    expect(list).toHaveBeenCalledTimes(3);
    // The slow load read the list before b, c, d were raised: their ids wait for the follow-up.
    expect([...s.pulse].sort()).toEqual(['b', 'c', 'd']);
  });

  it('a card on screen put away again elsewhere pulses, then stops', async () => {
    vi.useFakeTimers();
    let stashed = 10;
    const d = deps({
      list: vi.fn(async () => [entry('a', { stashedAt: stashed })]),
    });
    const s = createStashStore(d);
    s.open();
    await flush();
    s.setShown(['a']);
    stashed = 20;
    s.changed('put-away');
    await settleEvents();
    expect(s.pulse.has('a')).toBe(true);
    vi.advanceTimersByTime(PULSE_MS);
    expect(s.pulse.has('a')).toBe(false);
  });

  it('«открыта в #N» is re-read alone on request, and again on every reopen (M9)', async () => {
    let held: (TabHolder | null)[] = [null, null];
    const d = deps();
    d.holders.mockImplementation(async () => held);
    const s = createStashStore(d);
    s.open();
    await flush();
    expect(s.holders.size).toBe(0);
    held = [{ label: 'editor-4', number: 4 }, null];
    await s.refreshHolders();
    expect(s.holders.get('/n/a.md')).toEqual({ label: 'editor-4', number: 4 });
    expect(d.list, 'the list is not read again').toHaveBeenCalledTimes(1);
    held = [null, { label: 'editor-5', number: 5 }];
    s.close();
    s.open();
    await flush();
    expect(s.holders.get('/n/a.md')).toBeUndefined();
    expect(s.holders.get('/n/b.md')).toEqual({ label: 'editor-5', number: 5 });
  });

  it('a repeat pulse runs its full length and restarts the animation (M7)', () => {
    const s = createStashStore(deps());
    s.markPulse(['a', 'b']);
    const first = s.pulseKey('a');
    vi.advanceTimersByTime(PULSE_MS - 200);
    s.markPulse(['c']);
    s.markPulse(['a']);
    expect(s.pulseKey('a') % 2, 'the other animation name: the CSS animation starts over').not.toBe(first % 2);
    vi.advanceTimersByTime(200);
    expect(s.pulse.has('a'), 'the first pulse timer does not cut the repeat').toBe(true);
    expect(s.pulse.has('b')).toBe(false);
    vi.advanceTimersByTime(PULSE_MS - 200);
    expect(s.pulse.has('a')).toBe(false);
    expect(s.pulse.has('c')).toBe(false);
  });

  describe('the pulse diff is narrowed by the ids of the events since the previous load (T6)', () => {
    /** Open with `a` and `b` on screen, then raise both: which ones pulse depends only on the events. */
    async function raisedBoth(list?: StashStoreDeps['list']) {
      let stashed = 10;
      const d = deps({
        list: list ?? vi.fn(async () => [entry('a', { stashedAt: stashed }), entry('b', { stashedAt: stashed })]),
      });
      const s = createStashStore(d);
      s.open();
      await flush();
      s.setShown(['a', 'b']);
      stashed = 20;
      return { s, raise: (to: number) => (stashed = to) };
    }

    it('an event naming `a` pulses `a` alone', async () => {
      const { s } = await raisedBoth();
      s.changed('put-away', ['a']);
      await settleEvents();
      expect([...s.pulse]).toEqual(['a']);
    });

    it('events coalesced into one load pulse the union of their ids', async () => {
      const gate = deferred<void>();
      let stashed = 10;
      let calls = 0;
      const list = vi.fn(async () => {
        // The first load (the open) answers at once; the reloads wait so both events are in flight together.
        if (calls++ > 0) await gate.promise;
        return [
          entry('a', { stashedAt: stashed }),
          entry('b', { stashedAt: stashed }),
          entry('c', { stashedAt: stashed }),
        ];
      });
      const s = createStashStore(deps({ list }));
      s.open();
      await flush();
      s.setShown(['a', 'b', 'c']);
      stashed = 20;
      s.changed('put-away', ['a']);
      s.changed('put-away', ['b']);
      gate.resolve();
      await settleEvents();
      expect([...s.pulse].sort()).toEqual(['a', 'b']);
    });

    it('one event without ids among them widens the diff to the whole list', async () => {
      const { s } = await raisedBoth();
      s.changed('put-away', ['a']);
      s.changed('external');
      await settleEvents();
      expect([...s.pulse].sort()).toEqual(['a', 'b']);
    });

    it('a load consumes its ids: the next one diffs only what came after', async () => {
      vi.useFakeTimers();
      const { s, raise } = await raisedBoth();
      s.changed('put-away', ['a']);
      await settleEvents();
      vi.advanceTimersByTime(PULSE_MS);
      raise(30);
      s.changed('put-away', ['b']);
      await settleEvents();
      expect([...s.pulse]).toEqual(['b']);
    });

    it('a failed load keeps its ids for the next one', async () => {
      let stashed = 10;
      let fail = false;
      const list = vi.fn(async () => {
        if (fail) throw new Error('db busy');
        return [entry('a', { stashedAt: stashed }), entry('b', { stashedAt: stashed })];
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const s = createStashStore(deps({ list }));
      s.open();
      await flush();
      s.setShown(['a', 'b']);
      stashed = 20;
      fail = true;
      s.changed('put-away', ['a']);
      await settleEvents();
      expect(s.pulse.size).toBe(0);
      fail = false;
      s.changed('put-away', ['b']);
      await settleEvents();
      expect([...s.pulse].sort()).toEqual(['a', 'b']);
      error.mockRestore();
    });

    it('the first load after a reopen neither pulses nor pops, whatever happened while closed (M8)', async () => {
      let stashed = 10;
      let tags: string[] = [];
      const list = vi.fn(async () => [entry('a', { stashedAt: stashed, tags }), entry('b', { stashedAt: stashed })]);
      const s = createStashStore(deps({ list }));
      s.open();
      await flush();
      s.setShown(['a', 'b']);
      s.close();
      stashed = 20;
      tags = ['idea'];
      s.changed('put-away', ['a']);
      s.changed('external');
      await settleEvents();
      s.open();
      await flush();
      expect(list).toHaveBeenCalledTimes(2);
      expect(s.pulse.size).toBe(0);
      expect(s.newTags.size).toBe(0);
      // From here on the diff runs again, on the fresh basis and only for what comes next.
      stashed = 30;
      s.changed('put-away', ['b']);
      await settleEvents();
      expect([...s.pulse]).toEqual(['b']);
    });

    it('a load still in flight from before the close is quiet too', async () => {
      let stashed = 10;
      const gate = deferred<void>();
      let gated = false;
      const list = vi.fn(async () => {
        const at = stashed;
        if (gated) await gate.promise;
        return [entry('a', { stashedAt: at })];
      });
      const s = createStashStore(deps({ list }));
      s.open();
      await flush();
      s.setShown(['a']);
      gated = true;
      stashed = 20;
      s.changed('put-away', ['a']);
      await settleEvents();
      s.close();
      s.open();
      gated = false;
      gate.resolve();
      await flush();
      expect(s.pulse.size).toBe(0);
    });

    it('opening without any event since the last load pulses nothing', async () => {
      const { s } = await raisedBoth();
      s.close();
      s.open();
      await flush();
      expect(s.pulse.size).toBe(0);
    });
  });

  it('a tag new since the last load pops', async () => {
    let tags: string[] = [];
    const s = createStashStore(deps({ list: vi.fn(async () => [entry('a', { tags })]) }));
    s.open();
    await flush();
    tags = ['idea'];
    s.changed('tagged', ['a']);
    await settleEvents();
    expect(s.newTags.get('a')).toEqual(['idea']);
  });

  it('a window that got its project since the last open moves a following chip to it', async () => {
    let repo: string | null = 'old';
    const s = createStashStore(deps({ windowRepo: vi.fn(async () => repo) }));
    s.open();
    await flush();
    expect(s.state.repoChip).toBe('old');
    s.close();
    repo = 'new';
    s.open();
    // Opens at once with the last known repo, then follows the fresh one.
    expect(s.state.repoChip).toBe('old');
    await flush();
    expect(s.state.repoChip).toBe('new');
  });

  it('a failed read leaves the last good data on screen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    const s = createStashStore(
      deps({
        list: vi.fn(async () => {
          if (fail) throw new Error('db busy');
          return [entry('a')];
        }),
      })
    );
    s.open();
    await flush();
    fail = true;
    s.changed('put-away');
    await settleEvents();
    expect(s.entries.map((e) => e.id)).toEqual(['a']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('upsert replaces or adds; remove drops', () => {
    const s = createStashStore(deps());
    s.upsert([entry('a'), entry('b')]);
    s.upsert([entry('a', { title: 'renamed' }), entry('c')]);
    expect(s.entries.map((e) => `${e.id}:${e.title}`)).toEqual(['a:renamed', 'b:b', 'c:c']);
    s.remove('b');
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(s.indexes.has('b')).toBe(false);
  });

  describe('search (stage 05)', () => {
    const req = (query: string): SearchRequest => ({
      query,
      tag: null,
      deleted: false,
    });
    const hitOf = (e: StashEntry): StashHit => ({ entry: e, snippet: `… ${e.id} …`, ranges: [[2, 3]], score: 1 });

    function searching(answer: () => Promise<StashSearchResult>) {
      const search = vi.fn(async (_args: StashSearchArgs) => answer());
      return { s: createStashStore({ ...deps(), search }), search };
    }

    async function afterDebounce(): Promise<void> {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      await flush();
    }

    it('without a search dep it never searches: the local filter applies', async () => {
      const s = createStashStore(deps());
      s.search(req('plan'));
      await afterDebounce();
      expect(s.hits).toBeNull();
      expect(s.searchTotal).toBe(0);
    });

    it("sends the query's text after the debounce, and holds the hits and the total", async () => {
      const { s, search } = searching(async () => ({ hits: [hitOf(entry('b'))], total: 7, nextCursor: null }));
      s.open();
      await flush();
      s.search(req('plan #ops'));
      expect(search).not.toHaveBeenCalled();
      await afterDebounce();
      expect(search).toHaveBeenCalledWith({ query: 'plan', deleted: false, limit: 200, enrich: false });
      expect(s.hits?.map((h) => h.entry.id)).toEqual(['b']);
      expect(s.searchTotal).toBe(7);
    });

    it('every coalesced reload searches the active query again — no listener of its own', async () => {
      const { s, search } = searching(async () => ({ hits: [], total: 0, nextCursor: null }));
      s.open();
      await flush();
      s.search(req('plan'));
      await afterDebounce();
      expect(search).toHaveBeenCalledTimes(1);
      s.changed('reindexed');
      s.changed('title', ['a']);
      await settleEvents();
      expect(search).toHaveBeenCalledTimes(2);
    });

    it('a reload with no active query asks nothing', async () => {
      const { s, search } = searching(async () => ({ hits: [], total: 0, nextCursor: null }));
      s.open();
      await flush();
      s.changed('put-away');
      await settleEvents();
      expect(search).not.toHaveBeenCalled();
    });

    it('a query without text drops the hits at once, without asking', async () => {
      const { s, search } = searching(async () => ({ hits: [hitOf(entry('a'))], total: 1, nextCursor: null }));
      s.open();
      await flush();
      s.search(req('plan'));
      await afterDebounce();
      expect(s.hits).not.toBeNull();
      s.search(req('#ops'));
      expect(s.hits).toBeNull();
      await afterDebounce();
      expect(search).toHaveBeenCalledTimes(1);
    });

    it('a failed search drops the hits: the local filter applies', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      let fail = false;
      const { s } = searching(async () => {
        if (fail) throw new Error('no IPC');
        return { hits: [hitOf(entry('a'))], total: 1, nextCursor: null };
      });
      s.search(req('plan'));
      await afterDebounce();
      expect(s.hits).toHaveLength(1);
      fail = true;
      s.search(req('plans'));
      await afterDebounce();
      expect(s.hits).toBeNull();
      expect(s.searchTotal).toBe(0);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });

  it('closing keeps the entries for the next open, and the sort', async () => {
    const s = createStashStore(deps());
    s.open();
    await flush();
    s.update((st) => ({ ...st, sort: 'kind' }));
    s.close();
    expect(s.state.open).toBe(false);
    expect(s.state.sort).toBe('kind');
    expect(s.entries).toHaveLength(2);
  });
});

describe('the trash (stage 06)', () => {
  const T0 = 1_790_000_000_000;

  function trashDeps(over: Partial<NonNullable<StashStoreDeps['trash']>> = {}) {
    return {
      list: vi.fn(async () => [entry('t1', { deletedAt: T0 - 1 }), entry('t2', { deletedAt: T0 })]),
      restore: vi.fn(async (id: string) => entry(id, { stashedAt: T0 })),
      purge: vi.fn(async () => {}),
      remove: vi.fn(async (id: string): Promise<DeleteOutcome> => ({
        kind: 'trashed',
        entry: entry(id, { deletedAt: T0 }),
      })),
      ...over,
    };
  }

  async function inTrash(over: Partial<NonNullable<StashStoreDeps['trash']>> = {}, base = deps()) {
    const trash = trashDeps(over);
    const s = createStashStore({ ...base, trash });
    s.open();
    await flush();
    s.enterTrash();
    await flush();
    return { s, trash, base };
  }

  it('entering shows the trash with an empty query and the newest deletion first', async () => {
    const trash = trashDeps();
    const s = createStashStore({ ...deps(), trash });
    s.open();
    await flush();
    s.update((st) => setStashQuery(st, 'vpn'));
    s.enterTrash();
    expect(s.state.mode).toBe('trash');
    expect(s.state.query).toBe('');
    await flush();
    expect(s.trashLoaded).toBe(true);
    expect(s.trashEntries.map((e) => e.id)).toEqual(['t2', 't1']);
  });

  it('every entry reads the trash again, and shows no old cards until it has (review M8)', async () => {
    let next = [entry('t1', { deletedAt: T0 - 1 }), entry('t2', { deletedAt: T0 })];
    const list = vi.fn(async () => next);
    const { s, trash } = await inTrash({ list });
    s.leaveTrash();
    expect(s.state.mode).toBe('stash');
    // Purged elsewhere while the trash was not shown: no reload for a hidden list.
    next = [entry('t2', { deletedAt: T0 })];
    s.toggleTrash();
    expect(s.state.mode).toBe('trash');
    expect(s.trashLoaded).toBe(false);
    expect(s.trashEntries).toEqual([]);
    await flush();
    expect(trash.list).toHaveBeenCalledTimes(2);
    expect(s.trashLoaded).toBe(true);
    expect(s.trashEntries.map((e) => e.id)).toEqual(['t2']);
  });

  it('closing the stash from the trash also forgets the list (review M8)', async () => {
    const { s } = await inTrash();
    s.close();
    s.open();
    await flush();
    s.enterTrash();
    expect(s.trashLoaded).toBe(false);
    expect(s.trashEntries).toEqual([]);
  });

  it('closing the stash, or a put-away, returns to the stash view', async () => {
    const { s } = await inTrash();
    s.close();
    expect(s.state.mode).toBe('stash');
    s.open();
    expect(s.state.mode).toBe('stash');
    s.enterTrash();
    s.update(showStash);
    expect(s.state.mode).toBe('stash');
  });

  it('the trash cannot be entered while the stash is closed', () => {
    const trash = trashDeps();
    const s = createStashStore({ ...deps(), trash });
    s.enterTrash();
    expect(s.state).toEqual(closeStash(s.state));
    expect(s.state.mode).toBe('stash');
    expect(trash.list).not.toHaveBeenCalled();
  });

  it('stash-changed reloads the trash too — only while it is shown, on the same coalesced timer', async () => {
    const { s, trash, base } = await inTrash();
    s.changed('purged', ['t1']);
    s.changed('deleted', ['x']);
    await settleEvents();
    expect(trash.list).toHaveBeenCalledTimes(2);
    expect(base.list).toHaveBeenCalledTimes(2);
    s.leaveTrash();
    s.changed('purged', ['t2']);
    await settleEvents();
    expect(trash.list).toHaveBeenCalledTimes(2);
  });

  it('an older trash answer never overwrites a newer one', async () => {
    const slow = deferred<StashEntry[]>();
    let n = 0;
    const list = vi.fn(async () => (n++ === 0 ? slow.promise : [entry('new', { deletedAt: T0 })]));
    const { s } = await inTrash({ list });
    s.leaveTrash();
    s.enterTrash();
    await flush();
    slow.resolve([entry('old', { deletedAt: T0 })]);
    await flush();
    expect(s.trashEntries.map((e) => e.id)).toEqual(['new']);
  });

  it('the trash bar reads counts.deleted', async () => {
    const s = createStashStore({
      ...deps({ counts: vi.fn(async () => ({ total: 14, stashedToday: 3, deleted: 3 })) }),
    });
    s.open();
    await flush();
    expect(s.trashTotal).toBe(3);
  });

  it('restore takes the card out of the trash, puts the entry in the stash and says whether the chip hides it', async () => {
    const { s, trash } = await inTrash({}, deps({ repo: 'shelf-design' }));
    const out = await s.restoreEntry(s.trashEntries[0]);
    expect(trash.restore).toHaveBeenCalledWith('t2');
    expect(out).toEqual({ kind: 'restored', entry: entry('t2', { stashedAt: T0 }), hiddenBy: 'shelf-design' });
    expect(s.trashEntries.map((e) => e.id)).toEqual(['t1']);
    expect(s.entries.some((e) => e.id === 't2')).toBe(true);
  });

  it("a restored note of the chip's own repo is not hidden", async () => {
    const list = vi.fn(async () => [entry('t1', { deletedAt: T0, repo: 'infra' })]);
    const restore = vi.fn(async (id: string) => entry(id, { repo: 'infra' }));
    const { s } = await inTrash({ list, restore }, deps({ repo: 'infra' }));
    const out = await s.restoreEntry(s.trashEntries[0]);
    expect(out).toMatchObject({ kind: 'restored', hiddenBy: null });
  });

  it('purge takes the card out', async () => {
    const { s, trash } = await inTrash();
    expect(await s.purgeEntry(s.trashEntries[1])).toEqual({ kind: 'purged' });
    expect(trash.purge).toHaveBeenCalledWith('t1');
    expect(s.trashEntries.map((e) => e.id)).toEqual(['t2']);
  });

  it('a failed action keeps the card and says why', async () => {
    const { s } = await inTrash({
      purge: vi.fn(async () => {
        throw 'outside the note trash';
      }),
    });
    expect(await s.purgeEntry(s.trashEntries[0])).toEqual({ kind: 'failed', message: 'outside the note trash' });
    expect(s.trashEntries).toHaveLength(2);
  });

  it('a second click on a card already on its way out sends nothing', async () => {
    const gate = deferred<StashEntry>();
    const { s, trash } = await inTrash({ restore: vi.fn(() => gate.promise) });
    const card = s.trashEntries[0];
    const first = s.restoreEntry(card);
    expect(await s.restoreEntry(card)).toEqual({ kind: 'busy' });
    expect(await s.purgeEntry(card)).toEqual({ kind: 'busy' });
    gate.resolve(entry(card.id));
    await first;
    expect(trash.restore).toHaveBeenCalledTimes(1);
    expect(trash.purge).not.toHaveBeenCalled();
  });

  describe('delete from the stash', () => {
    async function open(over: Partial<NonNullable<StashStoreDeps['trash']>> = {}) {
      const trash = trashDeps(over);
      const s = createStashStore({ ...deps(), trash });
      s.open();
      await flush();
      return { s, trash };
    }

    it('a note goes to the trash: off the stash list at once', async () => {
      const { s, trash } = await open();
      const out = await s.removeEntry(s.entries[0]);
      expect(trash.remove).toHaveBeenCalledWith('a');
      expect(out).toEqual({ kind: 'trashed', entry: entry('a', { deletedAt: T0 }) });
      expect(s.entries.map((e) => e.id)).toEqual(['b']);
    });

    it('a file reference goes the same way', async () => {
      const { s } = await open({ remove: vi.fn(async (): Promise<DeleteOutcome> => ({ kind: 'removed' })) });
      expect(await s.removeEntry(s.entries[1])).toEqual({ kind: 'removed' });
      expect(s.entries.map((e) => e.id)).toEqual(['a']);
    });

    it('a note another window could not let go of stays on the list', async () => {
      const kept: DeleteOutcome = { kind: 'kept', reason: 'unsaved', label: 'editor-2', number: 2 };
      const { s } = await open({ remove: vi.fn(async () => kept) });
      expect(await s.removeEntry(s.entries[0])).toEqual(kept);
      expect(s.entries.map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('a failed delete stays on the list and says why', async () => {
      const { s } = await open({
        remove: vi.fn(async () => {
          throw new Error('no such entry');
        }),
      });
      expect(await s.removeEntry(s.entries[0])).toEqual({ kind: 'failed', message: 'no such entry' });
      expect(s.entries).toHaveLength(2);
    });

    it('a trashed note joins a trash list already read, in its place', async () => {
      const { s } = await open();
      s.enterTrash();
      await flush();
      s.leaveTrash();
      await s.removeEntry(s.entries[0]);
      expect(s.trashEntries.map((e) => e.id)).toEqual(['a', 't2', 't1']);
    });

    it('without trash deps the store says so instead of pretending', async () => {
      const s = createStashStore(deps());
      s.open();
      await flush();
      expect(await s.removeEntry(s.entries[0])).toMatchObject({ kind: 'failed' });
      expect(s.entries).toHaveLength(2);
    });
  });
});
