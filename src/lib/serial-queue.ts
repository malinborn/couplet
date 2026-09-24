/**
 * Runs async tasks one at a time, in the order they were submitted.
 *
 * Built for `switchDocument`: a Cmd+O arriving while an `open-file` switch is
 * still in its awaits must not interleave with it — two handovers of one
 * document, and the first one's cleanup running while the second is still
 * mid-switch.
 *
 * A failing task never poisons the queue: the next one runs regardless. And
 * the promise `run` returns never rejects — a failure is logged here and it
 * resolves to `undefined` instead. Callers fire these from event handlers with
 * `void`, where a rejection would otherwise surface as an unhandled one.
 */
export interface SerialQueue {
  /** Resolves with `fn`'s result, or `undefined` if `fn` threw or rejected. */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      const result = tail.then(fn).catch((err: unknown) => {
        console.error('Queued task failed:', err);
        return undefined;
      });
      tail = result;
      return result;
    },
  };
}
