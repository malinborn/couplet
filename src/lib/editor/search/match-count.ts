import { StateEffect, StateField, type ChangeSet, type EditorState, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
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

/**
 * Same matches for the same document. `SearchQuery.eq` also compares the
 * replacement, and every keystroke in the replace field would then throw the
 * list away, rescan the document and redraw everything that reads it.
 */
export function sameMatchSpec(a: SearchQuery, b: SearchQuery): boolean {
  return (
    a.search === b.search &&
    a.caseSensitive === b.caseSensitive &&
    a.regexp === b.regexp &&
    a.wholeWord === b.wholeWord &&
    a.literal === b.literal &&
    a.test === b.test
  );
}

/**
 * Whether a match of `query` can be found again by rescanning only the lines
 * around an edit. A regexp CodeMirror runs line by line can — one that may
 * cross lines (`\n`, `\s`, `[^…]`, … — the same test `RegExpCursor` uses to
 * pick its multi-line cursor) cannot be bounded that way.
 */
function rescannableLocally(query: SearchQuery): boolean {
  return !query.regexp || !/\\[sWDnr]|\n|\r|\[\^/.test(query.search);
}

/**
 * The match list after an edit, without scanning the whole document.
 *
 * Matches no change touches (adjacency counts: an insertion right after a
 * whole-word match can unmake it) are mapped through the changes. The text
 * around each change — whole lines, widened by the query's length so a string
 * match that crosses a line or straddles the change is caught — is scanned
 * again, and the two lists merged in document order. Where a rescanned match
 * overlaps a kept one, the earlier start wins, as in the cursor's own
 * non-overlapping scan.
 *
 * Returns null when this cannot be exact: a regexp that may span lines, or a
 * capped list (matches past the cap were never listed, so there is nothing to
 * map them from). The caller rescans everything then.
 */
export function mapMatches(
  matches: MatchList,
  query: SearchQuery,
  changes: ChangeSet,
  state: EditorState,
  cap: number = MATCH_CAP
): MatchList | null {
  if (!query.valid) return NO_MATCHES;
  if (matches.capped || !rescannableLocally(query)) return null;
  const doc = state.doc;
  const margin = query.regexp ? 0 : query.search.length + 4;

  const windows: [number, number][] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = Math.max(0, doc.lineAt(fromB).from - margin);
    const to = Math.min(doc.length, doc.lineAt(toB).to + margin);
    const last = windows[windows.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  });

  const found: { from: number; to: number }[] = [];
  for (let i = 0; i < matches.from.length; i++) {
    const from = matches.from[i];
    const to = matches.to[i];
    if (changes.touchesRange(from, to)) continue;
    found.push({ from: changes.mapPos(from, 1), to: changes.mapPos(to, -1) });
  }
  for (const [from, to] of windows) {
    const cursor = query.getCursor(state, from, to);
    for (let step = cursor.next(); !step.done; step = cursor.next()) found.push({ from: step.value.from, to: step.value.to });
  }
  found.sort((a, b) => a.from - b.from || a.to - b.to);

  const outFrom: number[] = [];
  const outTo: number[] = [];
  let end = -1;
  for (const m of found) {
    // A duplicate (kept and rescanned) or an overlap: the earlier one stands.
    if (outFrom.length > 0 && (m.from < end || (m.from === outFrom[outFrom.length - 1] && m.to === end))) continue;
    if (outFrom.length >= cap) return { from: outFrom, to: outTo, capped: true };
    outFrom.push(m.from);
    outTo.push(m.to);
    end = m.to;
  }
  return { from: outFrom, to: outTo, capped: false };
}

interface MatchState {
  readonly query: SearchQuery | null;
  readonly matches: MatchList;
  /**
   * The list was mapped through an edit it could not be rescanned around
   * (see `mapMatches`): positions are right, matches the edit made or unmade
   * are not. `matchRescan` schedules the full scan that replaces it.
   */
  readonly stale: boolean;
}

const CLOSED: MatchState = { query: null, matches: NO_MATCHES, stale: false };

/** Replace a stale list with a full scan. Dispatched by `matchRescan`. */
const rescanMatches = StateEffect.define<null>();

/**
 * The document-wide match list of the current query, kept only while the
 * search panel is open — a closed panel costs nothing on every keystroke.
 *
 * A changed query (what is searched, not the replacement) or the panel
 * opening scans the document. An edit only rescans the lines it touched
 * (`mapMatches`) — a full scan of a 2 MB document is ~70 ms, which on every
 * keystroke would be felt. Where a local rescan cannot be exact the list is
 * mapped, marked stale, and fully rescanned once typing pauses.
 */
export const searchMatchesField = StateField.define<MatchState>({
  create(state) {
    return compute(state);
  },
  update(value, tr) {
    if (!searchPanelOpen(tr.state)) return CLOSED;
    const query = getSearchQuery(tr.state);
    if (value.query === null || !sameMatchSpec(value.query, query) || tr.effects.some((e) => e.is(rescanMatches))) {
      return compute(tr.state, query);
    }
    if (!tr.docChanged) return value;
    const mapped = value.stale ? null : mapMatches(value.matches, query, tr.changes, tr.state);
    if (mapped) return { query, matches: mapped, stale: false };
    return { query, matches: mapStale(value.matches, tr.changes), stale: true };
  },
});

/** Positions carried through the edit; matches it touched are dropped until the rescan. */
function mapStale(matches: MatchList, changes: ChangeSet): MatchList {
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < matches.from.length; i++) {
    if (changes.touchesRange(matches.from[i], matches.to[i])) continue;
    from.push(changes.mapPos(matches.from[i], 1));
    to.push(changes.mapPos(matches.to[i], -1));
  }
  return { from, to, capped: matches.capped };
}

function compute(state: EditorState, query: SearchQuery | null = null): MatchState {
  if (!searchPanelOpen(state)) return CLOSED;
  const q = query ?? getSearchQuery(state);
  return { query: q, matches: collectMatches(state, q), stale: false };
}

/** How long typing has to pause before a stale list is rescanned. */
const RESCAN_DELAY_MS = 200;

/** Schedules the full rescan of a stale list, once per pause in typing. */
const matchRescan = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      const field = update.state.field(searchMatchesField, false);
      if (!field?.stale) return;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.view.state.field(searchMatchesField, false)?.stale) {
          this.view.dispatch({ effects: rescanMatches.of(null) });
        }
      }, RESCAN_DELAY_MS);
    }

    destroy(): void {
      if (this.timer !== null) clearTimeout(this.timer);
    }
  }
);

/** The match list and its deferred rescan. */
export const searchMatchesExtension: Extension = [searchMatchesField, matchRescan];

/** The match list for the current query (empty while the panel is closed). */
export function searchMatches(state: EditorState): MatchList {
  return state.field(searchMatchesField, false)?.matches ?? NO_MATCHES;
}
