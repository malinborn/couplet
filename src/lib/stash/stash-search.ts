/**
 * The stash drawer's search (spec «Поиск»: «фильтр по мере набора»; plan 05
 * D11). Typing is debounced; every new keystroke retires the answers still in
 * flight, so a slow answer to «тай» can never overwrite the one for «тайник»,
 * and the previous hits stay on screen until the new ones arrive (no flicker).
 *
 * Only the query's text terms reach Rust (`searchText`): the drawer keeps stage
 * 04's `#tag` rule — a prefix over the entry's tags and its repo — on the
 * client, where Rust's `#tag` is an exact stored tag. A query with no text
 * terms asks nothing and answers `null`: stage 04's local list applies.
 */
import { latestOnly } from '../editor/latest-only';
import type { StashSearchArgs, StashSearchResult } from './ipc';
import { searchText } from './stash-query';
// A value import: `stash-view` must not import this module's values back, or
// whichever loads second meets the other's constants uninitialised.
import { STASH_RENDER_CAP } from './stash-view';

export const SEARCH_DEBOUNCE_MS = 120;
/** One page is what the drawer renders; Rust caps `limit` at 200 too. */
export const SEARCH_LIMIT = STASH_RENDER_CAP;

export interface SearchRequest {
  /** The drawer's whole query; `toArgs` keeps only its text terms. */
  query: string;
  repo: string | null;
  /** Stage 06's trash filter; the drawer passes `null`. */
  tag: string | null;
  deleted: boolean;
}

export interface SearchRunner {
  request(r: SearchRequest): void;
  /** Search the active query again now (the stash changed underneath). */
  refresh(): void;
  dispose(): void;
}

export function toArgs(r: SearchRequest): StashSearchArgs {
  const args: StashSearchArgs = { query: searchText(r.query), deleted: r.deleted, limit: SEARCH_LIMIT };
  if (r.repo) args.repo = r.repo;
  if (r.tag) args.tag = r.tag;
  return args;
}

export function createSearchRunner(deps: {
  search: (args: StashSearchArgs) => Promise<StashSearchResult>;
  /** `null`: no text to search — show stage 04's list. */
  onResult: (result: StashSearchResult | null) => void;
  /** The caller drops its hits (`null`) so stage 04's substring filter applies. */
  onError: (error: unknown) => void;
}): SearchRunner {
  const latest = latestOnly();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: StashSearchArgs | null = null;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function run(args: StashSearchArgs): void {
    const current = latest.begin();
    let answer: Promise<StashSearchResult>;
    // `invoke` throws synchronously when there is no Tauri (`npm run dev`); that
    // is a failed search like any other, not an exception out of a timer.
    try {
      answer = deps.search(args);
    } catch (error: unknown) {
      answer = Promise.reject(error);
    }
    answer.then(
      (res) => {
        if (current()) deps.onResult(res);
      },
      (error: unknown) => {
        if (current()) deps.onError(error);
      }
    );
  }

  return {
    request(r) {
      const args = toArgs(r);
      cancelTimer();
      latest.invalidate();
      if (args.query === '') {
        last = null;
        deps.onResult(null);
        return;
      }
      last = args;
      timer = setTimeout(() => {
        timer = null;
        run(args);
      }, SEARCH_DEBOUNCE_MS);
    },
    refresh() {
      // A pending debounce searches the newest state anyway.
      if (last !== null && timer === null) run(last);
    },
    dispose() {
      cancelTimer();
      latest.invalidate();
      last = null;
    },
  };
}
