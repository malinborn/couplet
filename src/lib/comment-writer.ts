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
  /** A draft became a real thread: every later write for `draftId` goes to `realId`. */
  redirect(draftId: string, realId: string): void;
}

export function createCommentWriter(
  writeNow: (id: string) => Promise<string | null>
): CommentWriter {
  const queue = createSerialQueue();
  const redirects = new Map<string, string>();

  return {
    async write(id: string): Promise<string | null> {
      // Looked up when the write runs, not when it was queued: the redirect
      // that matters is usually made by the write this one waited for.
      const written = await queue.run(() => writeNow(redirects.get(id) ?? id));
      return written ?? redirects.get(id) ?? null;
    },
    redirect(draftId: string, realId: string): void {
      redirects.set(draftId, realId);
    },
  };
}
