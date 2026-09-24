import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCommentWriter, adoptStartedDraft } from './comment-writer';

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

  it('RunsAResolveQueuedBehindADraftStartAgainstTheRealId', async () => {
    const first = deferred<string | null>();
    const writer = createCommentWriter(async () => {
      const realId = await first.promise;
      writer.redirect('draft:1', 'c-abc');
      return realId;
    });
    const started = writer.write('draft:1');
    const resolved = writer.run('draft:1', async (id) => `resolved ${id}`);
    first.resolve('c-abc');
    await started;
    await expect(resolved).resolves.toBe('resolved c-abc');
  });

  it('RunsAWholeDocumentStepOnlyAfterTheWritesQueuedBeforeIt', async () => {
    const first = deferred<string | null>();
    const log: string[] = [];
    const writer = createCommentWriter(async (id) => {
      log.push(`write ${id}`);
      return first.promise;
    });
    const write = writer.write('c-1');
    const commit = writer.enqueue(async () => {
      log.push('commit');
      return true;
    });
    await tick();
    expect(log).toEqual(['write c-1']);
    first.resolve('c-1');
    await write;
    await expect(commit).resolves.toBe(true);
    expect(log).toEqual(['write c-1', 'commit']);
  });

  it('MapsADraftIdToItsRealIdOnceRedirected', () => {
    const writer = createCommentWriter(async () => null);
    expect(writer.idFor('draft:1')).toBe('draft:1');
    writer.redirect('draft:1', 'c-abc');
    expect(writer.idFor('draft:1')).toBe('c-abc');
    expect(writer.idFor('c-other')).toBe('c-other');
  });
});

interface Entry {
  text: string;
  saved: string;
}

describe('adoptStartedDraft', () => {
  it('KeepsTextTypedWhileTheStartWasInFlight', () => {
    const entry: Entry = { text: 'hello', saved: '' };
    const pending = new Map<string, Entry>([['draft:1', entry]]);
    entry.text = 'hello world';

    adoptStartedDraft(pending, 'draft:1', 'c-abc', 'hello');

    expect(pending.has('draft:1')).toBe(false);
    expect(pending.get('c-abc')).toEqual({ text: 'hello world', saved: 'hello' });
  });

  it('DoesNotBringBackAnEntryForgottenWhileTheStartWasInFlight', () => {
    const pending = new Map<string, Entry>();
    adoptStartedDraft(pending, 'draft:1', 'c-abc', 'hello');
    expect(pending.size).toBe(0);
  });

  it('SendsTheTextTypedDuringTheStartOnTheNextWrite', async () => {
    // The App-level sequence: the first write creates the thread with what was
    // in the box when it began; a keystroke lands before the file answers; the
    // redirected follow-up write must carry that keystroke to the real id.
    const first = deferred<string>();
    const pending = new Map<string, Entry>([['draft:1', { text: 'hello', saved: '' }]]);
    const replies: Array<[string, string]> = [];
    const writer = createCommentWriter(async (id) => {
      const entry = pending.get(id);
      if (!entry || entry.text === entry.saved) return null;
      const text = entry.text;
      if (id.startsWith('draft:')) {
        const realId = await first.promise;
        writer.redirect(id, realId);
        adoptStartedDraft(pending, id, realId, text);
        return realId;
      }
      replies.push([id, text]);
      entry.saved = text;
      return id;
    });

    const debounced = writer.write('draft:1');
    await tick();
    pending.get('draft:1')!.text = 'hello world';
    const next = writer.write('draft:1');
    first.resolve('c-abc');

    await expect(debounced).resolves.toBe('c-abc');
    await expect(next).resolves.toBe('c-abc');
    expect(replies).toEqual([['c-abc', 'hello world']]);
  });
});
