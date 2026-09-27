/**
 * Stash stage 04 (D15): the widen and its restore, one at a time. Each edge
 * of the stash drawer (open / closed) queues a step on one promise chain, and
 * every step converges on the LATEST edge rather than on its own: a close
 * while a widen is in flight puts the window back once that widen lands (and
 * says nothing — the stash it was for is gone), a reopen while a restore runs
 * waits for it and widens again, and open → close → open faster than the IPC
 * is a single widen with a single «окно раздвинулось». Without the chain two
 * widens could run side by side, the second reading the first one's 680 px
 * as the size to go back to.
 */
import type { WidenMemo } from './window-widen';

export interface WidenSessionDeps {
  /** `widenForStash`: `null` when nothing was widened (wide enough, fullscreen, the browser, a failure). */
  widen(): Promise<WidenMemo | null>;
  /** `restoreWindow`. */
  restore(memo: WidenMemo): Promise<void>;
  /** The `stash` toast `widened` — once per widen that the open stash keeps. */
  announce(): void;
}

export interface WidenSession {
  /** The stash drawer opened (`true`) or closed (`false`). */
  edge(open: boolean): void;
  /** Settles once every step queued so far has run. */
  idle(): Promise<void>;
}

export function createWidenSession(deps: WidenSessionDeps): WidenSession {
  let open = false;
  let memo: WidenMemo | null = null;
  let tail: Promise<void> = Promise.resolve();

  const step = async (): Promise<void> => {
    if (open && memo === null) {
      const got = await deps.widen();
      if (got === null) return;
      memo = got;
      if (open) deps.announce();
    }
    // Also right after a widen that a close overtook.
    if (!open && memo !== null) {
      const back = memo;
      memo = null;
      await deps.restore(back);
    }
  };

  return {
    edge(next: boolean): void {
      open = next;
      tail = tail.then(step).catch((err: unknown) => console.error('stash: widen step failed', err));
    },
    idle: () => tail,
  };
}
