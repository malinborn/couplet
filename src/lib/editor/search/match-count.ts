import { StateField, type EditorState } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen, type SearchQuery } from '@codemirror/search';

/**
 * The Find panel's counter: how many matches the query has in the whole
 * document, and which of them the main selection is.
 *
 * CodeMirror only ever looks at the viewport — its highlighter scans the
 * visible ranges plus a margin — so "3 / 17" needs a scan of its own. It is
 * done once per (document, query) pair and kept here as a sorted list of match
 * starts and ends; moving between matches is then a binary search, not a
 * rescan. A document with a pathological number of hits stops at `MATCH_CAP`,
 * which bounds both the time and the memory of the scan.
 */

/** The most matches counted. One more than this shows as `9999+`. */
export const MATCH_CAP = 9999;

export interface MatchList {
  /** Starts of the matches, in document order. */
  readonly from: readonly number[];
  /** Ends, parallel to `from`. */
  readonly to: readonly number[];
  /** True when the document has more than `cap` matches; only the first `cap` are listed. */
  readonly capped: boolean;
}

export const NO_MATCHES: MatchList = { from: [], to: [], capped: false };

/**
 * Every match of `query` in `state`, in order, up to `cap`. Uses the query's
 * own cursor, so case, regexp, whole-word and a custom `test` filter behave
 * exactly as they do for findNext and the highlighter. An invalid query (empty,
 * or a regexp that does not compile) has no matches.
 */
export function collectMatches(state: EditorState, query: SearchQuery, cap: number = MATCH_CAP): MatchList {
  if (!query.valid) return NO_MATCHES;
  const from: number[] = [];
  const to: number[] = [];
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (from.length >= cap) return { from, to, capped: true };
    from.push(step.value.from);
    to.push(step.value.to);
  }
  return { from, to, capped: false };
}

/**
 * Index of the match that is exactly `[from, to)`, or -1. A selection that
 * merely overlaps a match, or a caret, is "not on a match" — the counter shows
 * `– / 17` for it, as in every editor that has one.
 */
export function matchIndexAt(matches: MatchList, from: number, to: number): number {
  const starts = matches.from;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < from) lo = mid + 1;
    else if (starts[mid] > from) hi = mid - 1;
    else {
      // Zero-length regexp matches can share a start with nothing else, but a
      // pattern like `a|ab` cannot produce two matches at one start: the
      // cursor resumes after the end of the previous match. One hit suffices.
      return matches.to[mid] === to ? mid : -1;
    }
  }
  return -1;
}

export type CounterState = 'empty' | 'invalid' | 'none' | 'off' | 'on';

export interface Counter {
  /** What the counter reads; empty for an empty query. */
  readonly text: string;
  /**
   * `empty` — no query; `invalid` — a regexp that does not compile;
   * `none` — a valid query with no hits; `off` — hits, but the selection is
   * not one of them; `on` — the selection is hit number `index + 1`.
   */
  readonly state: CounterState;
  /** 1-based position of the current match, or null. */
  readonly index: number | null;
  /** The total as displayed (`"9999+"` past the cap). */
  readonly total: string;
}

/** Labels the counter needs from the active language. */
export interface CounterLabels {
  readonly none: string;
  readonly invalid: string;
}

/** The counter for a query, its matches and the main selection. Pure. */
export function formatCounter(
  query: SearchQuery,
  matches: MatchList,
  selection: { from: number; to: number },
  labels: CounterLabels
): Counter {
  if (!query.search) return { text: '', state: 'empty', index: null, total: '' };
  if (!query.valid) return { text: labels.invalid, state: 'invalid', index: null, total: '' };
  const count = matches.from.length;
  if (count === 0) return { text: labels.none, state: 'none', index: null, total: '0' };
  const total = matches.capped ? `${count}+` : String(count);
  const at = matchIndexAt(matches, selection.from, selection.to);
  if (at < 0) return { text: `– / ${total}`, state: 'off', index: null, total };
  return { text: `${at + 1} / ${total}`, state: 'on', index: at + 1, total };
}

interface MatchState {
  readonly query: SearchQuery | null;
  readonly matches: MatchList;
}

const CLOSED: MatchState = { query: null, matches: NO_MATCHES };

/**
 * The document-wide match list of the current query, kept only while the
 * search panel is open — a closed panel costs nothing on every keystroke.
 * Recomputed when the query, the document, or the panel's openness changes;
 * selection changes reuse the list.
 */
export const searchMatchesField = StateField.define<MatchState>({
  create(state) {
    return compute(state);
  },
  update(value, tr) {
    if (!searchPanelOpen(tr.state)) return CLOSED;
    const query = getSearchQuery(tr.state);
    if (!tr.docChanged && value.query !== null && value.query.eq(query)) return value;
    return compute(tr.state, query);
  },
});

function compute(state: EditorState, query: SearchQuery | null = null): MatchState {
  if (!searchPanelOpen(state)) return CLOSED;
  const q = query ?? getSearchQuery(state);
  return { query: q, matches: collectMatches(state, q) };
}

/** The match list for the current query (empty while the panel is closed). */
export function searchMatches(state: EditorState): MatchList {
  return state.field(searchMatchesField, false)?.matches ?? NO_MATCHES;
}
