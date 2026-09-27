import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSearchRunner,
  toArgs,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
  type SearchRequest,
} from './stash-search';
import { STASH_RENDER_CAP } from './stash-view';
import type { StashSearchArgs, StashSearchResult } from './ipc';
import type { StashEntry } from './types';

function entry(id: string, path = `/n/${id}.md`): StashEntry {
  return {
    id,
    kind: 'note',
    path,
    title: id,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
  };
}

function result(...ids: string[]): StashSearchResult {
  return {
    hits: ids.map((id) => ({ entry: entry(id), snippet: '', ranges: [], score: 1 })),
    total: ids.length,
    nextCursor: null,
  };
}

const req = (query: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({
  query,
  repo: null,
  tag: null,
  deleted: false,
  ...extra,
});

/** A search whose answers the test releases by hand, in any order. */
function manualSearch() {
  const pending: { args: StashSearchArgs; resolve: (r: StashSearchResult) => void; reject: (e: unknown) => void }[] =
    [];
  const search = vi.fn(
    (args: StashSearchArgs) =>
      new Promise<StashSearchResult>((resolve, reject) => pending.push({ args, resolve, reject }))
  );
  return { search, pending };
}

describe('createSearchRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Debounce_TypingFastSendsOnlyTheLastQuery', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('т'));
    runner.request(req('та'));
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].query).toBe('тай');
  });

  it('BlankQuery_ClearsAtOnceWithoutSearching', () => {
    const { search } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    runner.request(req('   '));
    expect(onResult).toHaveBeenCalledWith(null);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(search).not.toHaveBeenCalled();
  });

  it('TagOnlyQuery_ClearsAtOnceWithoutSearching', () => {
    // The drawer filters `#tag` itself (prefix over tags and the repo, stage 04),
    // so a query without text terms has nothing to ask Rust.
    const { search } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('#infra #md'));
    expect(onResult).toHaveBeenCalledWith(null);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    runner.refresh();
    expect(search).not.toHaveBeenCalled();
  });

  it('NewQuery_KeepsThePreviousHitsUntilItsAnswerArrives', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    pending[0].resolve(result('old'));
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenCalledTimes(1);

    runner.request(req('тайник'));
    expect(onResult).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    pending[1].resolve(result('new'));
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls[1][0].hits[0].entry.id).toBe('new');
  });

  it('LatestOnly_AnOlderAnswerArrivingLateIsDropped', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.request(req('тайник'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    pending[1].resolve(result('new'));
    pending[0].resolve(result('old'));
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].hits[0].entry.id).toBe('new');
  });

  it('LatestOnly_AnAnswerArrivingDuringTheNextDebounceIsDropped', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.request(req('тайн'));
    pending[0].resolve(result('old'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('Error_ReportedOnlyForTheCurrentRequest', async () => {
    const { search, pending } = manualSearch();
    const onError = vi.fn();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    pending[0].reject(new Error('index broken'));
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);

    runner.request(req('ключ'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.request(req('ключи'));
    pending[1].reject(new Error('stale'));
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('Error_ASynchronousThrowIsReportedNotRaised', async () => {
    // `invoke` throws synchronously without `__TAURI_INTERNALS__` (`npm run dev`).
    const search = vi.fn((): Promise<StashSearchResult> => {
      throw new TypeError('no ipc');
    });
    const onError = vi.fn();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError });
    runner.request(req('тай'));
    expect(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)).not.toThrow();
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TypeError);
  });

  it('Refresh_RerunsTheActiveQueryNow', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.refresh();
    expect(search).toHaveBeenCalledTimes(2);
    runner.request(req(''));
    runner.refresh();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('Refresh_DuringTheDebounceLeavesItToTheTimer', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('тай'));
    runner.refresh();
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('Refresh_RetiresTheAnswerStillInFlight', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.refresh();
    pending[1].resolve(result('after'));
    pending[0].resolve(result('before'));
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].hits[0].entry.id).toBe('after');
  });

  it('Dispose_APendingSearchNeverRuns', () => {
    const { search } = manualSearch();
    const runner = createSearchRunner({ search, onResult: vi.fn(), onError: vi.fn() });
    runner.request(req('тай'));
    runner.dispose();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(search).not.toHaveBeenCalled();
  });

  it('Dispose_AnAnswerInFlightIsDropped', async () => {
    const { search, pending } = manualSearch();
    const onResult = vi.fn();
    const runner = createSearchRunner({ search, onResult, onError: vi.fn() });
    runner.request(req('тай'));
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    runner.dispose();
    pending[0].resolve(result('late'));
    await vi.runAllTimersAsync();
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('toArgs', () => {
  it('OmitsAbsentFiltersAndAsksForAWholePage', () => {
    expect(toArgs(req('тай'))).toEqual({ query: 'тай', deleted: false, limit: SEARCH_LIMIT });
    expect(toArgs(req('тай', { repo: 'md-mini', tag: 'infra', deleted: true }))).toEqual({
      query: 'тай',
      repo: 'md-mini',
      tag: 'infra',
      deleted: true,
      limit: SEARCH_LIMIT,
    });
  });

  it('SendsOnlyTheTextTerms', () => {
    expect(toArgs(req('  #infra тай   "два  слова" #md ок ')).query).toBe('тай "два  слова" ок');
  });

  it('APageIsWhatTheDrawerRenders', () => {
    expect(SEARCH_LIMIT).toBe(STASH_RENDER_CAP);
  });
});
