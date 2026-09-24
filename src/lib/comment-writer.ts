import { createSerialQueue } from './serial-queue';

/**
 * Every write to a document's comment sidecar, one at a time.
 *
 * Two writes of one thread used to overlap — the debounce timer fires one and
 * a tab switch's flush fires another before the first resolves. For a draft
 * that lost the comment: the first write had already turned the draft into a
 * thread, so the second sent the draft id to the sidecar, which rejected it.
 * Queued, the second write runs after the first and is sent to the id the
 * file gave the thread (`redirect`).
 */
export interface CommentWriter {
  /**
   * Write thread `id` after any write already in progress. Resolves to the id
   * the text is now under — the real id for a redirected draft, even when
   * there was nothing left to write — or `null` when nothing was written.
   */
  write(id: string): Promise<string | null>;
  /**
   * Any other sidecar operation on thread `id` (resolve), in the same queue
   * and against the id it has by the time it runs. Resolves to `undefined` if
   * `fn` threw.
   */
  run<T>(id: string, fn: (id: string) => Promise<T>): Promise<T | undefined>;
  /** The id `id` currently stands for — the real one once a draft has been started. */
  idFor(id: string): string;
  /** A draft became a real thread: every later write for `draftId` goes to `realId`. */
  redirect(draftId: string, realId: string): void;
}

export function createCommentWriter(
  writeNow: (id: string) => Promise<string | null>
): CommentWriter {
  const queue = createSerialQueue();
  const redirects = new Map<string, string>();
  const idFor = (id: string): string => redirects.get(id) ?? id;
  // Looked up when the task runs, not when it was queued: the redirect that
  // matters is usually made by the write this one waited for.
  const run = <T>(id: string, fn: (id: string) => Promise<T>): Promise<T | undefined> =>
    queue.run(() => fn(idFor(id)));

  return {
    async write(id: string): Promise<string | null> {
      const written = await run(id, writeNow);
      return written ?? redirects.get(id) ?? null;
    },
    run,
    idFor,
    redirect(draftId: string, realId: string): void {
      redirects.set(draftId, realId);
    },
  };
}

/**
 * Move a draft's pending entry to the id the file just gave it.
 *
 * The same entry object moves, not a copy made from `written`: keystrokes that
 * landed while the start was in flight updated it, and rebuilding it from the
 * text the start sent would mark them as saved — the next write would then
 * find nothing to do and they would be gone. `saved` becomes what the start
 * actually wrote, so that next write sends the rest.
 *
 * An entry that is no longer there was forgotten meanwhile (the thread is
 * being resolved) and is not brought back.
 */
export function adoptStartedDraft<E extends { saved: string }>(
  pending: Map<string, E>,
  draftId: string,
  realId: string,
  written: string
): void {
  const entry = pending.get(draftId);
  if (!entry) return;
  pending.delete(draftId);
  entry.saved = written;
  pending.set(realId, entry);
}
