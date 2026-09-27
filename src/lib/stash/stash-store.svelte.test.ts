import { afterEach, describe, expect, it, vi } from 'vitest';
import { PULSE_MS, createStashStore, type StashStoreDeps } from './stash-store.svelte';
import type { StashEntry, TabHolder } from './types';

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

  it('a slower, older reload does not overwrite a newer one', async () => {
    const first = deferred<StashEntry[]>();
    const second = deferred<StashEntry[]>();
    const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const s = createStashStore(deps({ list }));
    void s.reload();
    void s.reload();
    second.resolve([entry('b')]);
    await flush();
    first.resolve([entry('a')]);
    await flush();
    expect(s.entries.map((e) => e.id)).toEqual(['b']);
  });

  it('stash-changed while closed refreshes the counts only', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.changed('put-away', ['a']);
    await flush();
    expect(d.counts).toHaveBeenCalledTimes(1);
    expect(d.list).not.toHaveBeenCalled();
  });

  it('stash-changed while open reloads the list and the counts', async () => {
    const d = deps();
    const s = createStashStore(d);
    s.open();
    await flush();
    s.changed('title', ['a']);
    await flush();
    expect(d.list).toHaveBeenCalledTimes(2);
    expect(d.counts).toHaveBeenCalledTimes(2);
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
    await flush();
    expect(s.pulse.has('a')).toBe(true);
    vi.advanceTimersByTime(PULSE_MS);
    expect(s.pulse.has('a')).toBe(false);
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
      await flush();
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
      await flush();
      expect([...s.pulse].sort()).toEqual(['a', 'b']);
    });

    it('one event without ids among them widens the diff to the whole list', async () => {
      const { s } = await raisedBoth();
      s.changed('put-away', ['a']);
      s.changed('external');
      await flush();
      expect([...s.pulse].sort()).toEqual(['a', 'b']);
    });

    it('a load consumes its ids: the next one diffs only what came after', async () => {
      vi.useFakeTimers();
      const { s, raise } = await raisedBoth();
      s.changed('put-away', ['a']);
      await flush();
      vi.advanceTimersByTime(PULSE_MS);
      raise(30);
      s.changed('put-away', ['b']);
      await flush();
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
      await flush();
      expect(s.pulse.size).toBe(0);
      fail = false;
      s.changed('put-away', ['b']);
      await flush();
      expect([...s.pulse].sort()).toEqual(['a', 'b']);
      error.mockRestore();
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
    await flush();
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
    await flush();
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
