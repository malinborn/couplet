export interface LatestOnly {
  /** Start a request; the returned check stays true until a newer `begin` or an `invalidate`. */
  begin: () => () => boolean;
  /** Retire every request started so far. */
  invalidate: () => void;
}

/** "Last one wins" for async work whose result must only apply to the state that asked for it. */
export function latestOnly(): LatestOnly {
  let generation = 0;
  return {
    begin() {
      const mine = ++generation;
      return () => mine === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}
