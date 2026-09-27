import { describe, expect, it, vi } from 'vitest';
import { createStashMarks } from './stash-marks.svelte';
import type { StashEntry } from './types';

function entry(path: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id: 's1',
    kind: 'note',
    path,
    title: 'T',
    repo: null,
    branch: null,
    tags: [],
    createdAt: 1,
    modifiedAt: 1,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

type Lookup = (path: string) => Promise<StashEntry | null>;

describe('stash marks', () => {
  it('asks once per path and remembers the answer', async () => {
    const lookup = vi.fn(async (p: string) => (p === '/n.md' ? entry(p) : null));
    const marks = createStashMarks(lookup);
    marks.ensure(['/n.md', '/f.md', null, '/n.md']);
    await flush();
    marks.ensure(['/n.md', '/f.md']);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(marks.get('/n.md')).toEqual({ kind: 'note', title: 'T', repo: null });
    expect(marks.get('/f.md')).toBeNull();
    expect(marks.get(null)).toBeNull();
  });

  it('a trashed entry has no mark', async () => {
    const marks = createStashMarks(async (p) => entry(p, { deletedAt: 5 }));
    marks.ensure(['/n.md']);
    await flush();
    expect(marks.get('/n.md')).toBeNull();
  });

  it('what it learns wins over an answer still in flight', async () => {
    const d = deferred<StashEntry | null>();
    const marks = createStashMarks(() => d.promise);
    marks.ensure(['/n.md']);
    marks.learn(entry('/n.md', { title: 'Born' }));
    d.resolve(null);
    await flush();
    expect(marks.get('/n.md')?.title).toBe('Born');
  });

  it('a failed lookup is asked again next time', async () => {
    const lookup = vi
      .fn<Lookup>()
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce(entry('/n.md'));
    const marks = createStashMarks(lookup);
    marks.ensure(['/n.md']);
    await flush();
    marks.ensure(['/n.md']);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(marks.get('/n.md')?.kind).toBe('note');
  });

  it('refresh asks again', async () => {
    const lookup = vi
      .fn<Lookup>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(entry('/f.md', { kind: 'file' }));
    const marks = createStashMarks(lookup);
    marks.ensure(['/f.md']);
    await flush();
    await marks.refresh(['/f.md']);
    expect(marks.get('/f.md')?.kind).toBe('file');
  });

  it('a stash change drops the marks of deleted entries at once', async () => {
    const d = deferred<StashEntry | null>();
    const lookup = vi.fn<Lookup>().mockResolvedValueOnce(entry('/n.md', { id: 'gone' })).mockReturnValueOnce(d.promise);
    const marks = createStashMarks(lookup);
    marks.ensure(['/n.md']);
    await flush();
    expect(marks.get('/n.md')?.kind).toBe('note');
    const done = marks.changed('deleted', ['gone'], ['/n.md']);
    // Before the lookup answers: a discarded note is not in the stash any more.
    expect(marks.get('/n.md')).toBeNull();
    d.resolve(null);
    await done;
    expect(marks.get('/n.md')).toBeNull();
  });

  it('a learned entry is dropped by its id too', () => {
    const marks = createStashMarks(() => new Promise<StashEntry | null>(() => {}));
    marks.learn(entry('/n.md', { id: 'born' }));
    void marks.changed('deleted', ['born'], []);
    expect(marks.get('/n.md')).toBeNull();
  });

  it('a stash change for other entries keeps the mark until the lookup answers', async () => {
    const d = deferred<StashEntry | null>();
    const lookup = vi.fn<Lookup>().mockResolvedValueOnce(entry('/n.md', { id: 'kept' })).mockReturnValueOnce(d.promise);
    const marks = createStashMarks(lookup);
    marks.ensure(['/n.md']);
    await flush();
    const done = marks.changed('deleted', ['other'], ['/n.md']);
    expect(marks.get('/n.md')?.kind).toBe('note');
    d.resolve(entry('/n.md', { id: 'kept', title: 'Renamed' }));
    await done;
    expect(marks.get('/n.md')?.title).toBe('Renamed');
  });

  it('every stash change asks again for every open path, one that failed before included', async () => {
    const lookup = vi
      .fn<Lookup>()
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(entry('/a.md', { kind: 'file' }));
    const marks = createStashMarks(lookup);
    marks.ensure(['/a.md', '/b.md']);
    await flush();
    await marks.changed('put-away', undefined, ['/a.md', '/b.md']);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(['/a.md', '/b.md', '/a.md', '/b.md']);
    expect(marks.get('/a.md')?.kind).toBe('file');
  });

  it('retain forgets paths that are no longer open', async () => {
    const lookup = vi.fn(async (p: string) => entry(p));
    const marks = createStashMarks(lookup);
    marks.ensure(['/a.md', '/b.md']);
    await flush();
    marks.retain(['/a.md']);
    expect(marks.get('/a.md')?.kind).toBe('note');
    expect(marks.get('/b.md')).toBeNull();
    // Opened again: asked again, not served from a stale cache.
    marks.ensure(['/a.md', '/b.md']);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(marks.get('/b.md')?.kind).toBe('note');
  });

  it('an answer for a path forgotten meanwhile is dropped', async () => {
    const d = deferred<StashEntry | null>();
    const marks = createStashMarks(() => d.promise);
    marks.ensure(['/b.md']);
    marks.retain([]);
    d.resolve(entry('/b.md'));
    await flush();
    expect(marks.get('/b.md')).toBeNull();
  });
});
