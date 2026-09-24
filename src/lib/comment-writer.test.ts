import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCommentWriter } from './comment-writer';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createCommentWriter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RunsTwoWritesOfOneThreadOneAfterTheOther', async () => {
    const first = deferred<string | null>();
    const log: string[] = [];
    let calls = 0;
    const writer = createCommentWriter(async (id) => {
      calls += 1;
      const n = calls;
      log.push(`start ${n}`);
      const result = n === 1 ? await first.promise : id;
      log.push(`end ${n}`);
      return result;
    });

    const a = writer.write('c-1');
    const b = writer.write('c-1');
    await tick();
    expect(log).toEqual(['start 1']);

    first.resolve('c-1');
    await Promise.all([a, b]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('SendsALaterWriteForADraftToTheRealId', async () => {
    const seen: string[] = [];
    const writer = createCommentWriter(async (id) => {
      seen.push(id);
      return id;
    });
    writer.redirect('draft:1', 'c-abc');
    await expect(writer.write('draft:1')).resolves.toBe('c-abc');
    expect(seen).toEqual(['c-abc']);
  });

  it('ReportsTheRealIdEvenWhenNothingWasLeftToWrite', async () => {
    // The pause commit follows this id: answering null would make it commit
    // the draft's id, which the sidecar has never heard of.
    const writer = createCommentWriter(async () => null);
    writer.redirect('draft:1', 'c-abc');
    await expect(writer.write('draft:1')).resolves.toBe('c-abc');
  });

  it('FollowsARedirectMadeWhileTheWriteWaited', async () => {
    // The flush race itself: the debounced write creates the thread while the
    // flush's write for the same draft is queued behind it.
    const first = deferred<string | null>();
    const seen: string[] = [];
    const writer = createCommentWriter(async (id) => {
      seen.push(id);
      if (seen.length === 1) {
        const realId = await first.promise;
        writer.redirect('draft:1', 'c-abc');
        return realId;
      }
      return null;
    });
    const debounced = writer.write('draft:1');
    const flushed = writer.write('draft:1');
    first.resolve('c-abc');
    await expect(debounced).resolves.toBe('c-abc');
    await expect(flushed).resolves.toBe('c-abc');
    expect(seen).toEqual(['draft:1', 'c-abc']);
  });

  it('ResolvesNullWhenNothingWasWritten', async () => {
    const writer = createCommentWriter(async () => null);
    await expect(writer.write('c-1')).resolves.toBeNull();
  });

  it('KeepsTheQueueMovingAfterAWriteThrows', async () => {
    const writer = createCommentWriter(async (id) => {
      if (id === 'bad') throw new Error('EACCES');
      return id;
    });
    await expect(writer.write('bad')).resolves.toBeNull();
    await expect(writer.write('c-2')).resolves.toBe('c-2');
  });
});
