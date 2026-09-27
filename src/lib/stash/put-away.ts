/**
 * «Отложить» for tabs of this window, from the drawers (stash stage 04, D8 as
 * amended): each tab goes the way ⌃T goes — `controller.putAwayTabs`, one
 * `tab_close` with `putAway` per tab — so a file keeps its own caret, a note
 * is put away once (by its close), and an untitled tab whose note could not
 * be born keeps its tab. There is no batch answer to read entries from: what
 * the toast needs (captions, which files were already stashed, which tabs
 * were blank) is read from this window BEFORE the tabs close, because the
 * close itself makes every file a stashed one. The cards arrive through
 * `stash-changed {reason: 'put-away', ids}` → the store's reload.
 *
 * Toasts, one kind each: Rust's "not stashed" answers are stage 03's
 * `stash-error` (headline «Не отложено в тайник»), raised once per batch by
 * the controller exactly as ⌃T raises it; a note that could not be born has
 * its own `stash-error` from the birth; a close that threw (IPC) is the
 * drawer's `stash` toast `what: 'error'`; the summary is the `stash` toast
 * `what: 'put-away'`.
 */
import type { PutAwayTabsOutcome, NotStashed } from '../tabs/controller';
import type { TabMeta } from '../tabs/tab-model';
import type { StashToastNote } from './stash-toast';
import type { StashKind } from './types';

export interface PutAwayDeps {
  /** This window's tabs, in order, now. */
  tabs(): readonly TabMeta[];
  /** The tab's caption as its card shows it (`tabCaption(...).name`). */
  caption(tab: TabMeta): string;
  /** The stash mark of an open document's path now (`null`: not in the stash, or not known yet). */
  mark(path: string): StashKind | null;
  /** An untitled tab holding nothing but whitespace: its close keeps nothing. */
  blank(tab: TabMeta): boolean;
  /** `controller.putAwayTabs`. */
  close(ids: string[]): Promise<PutAwayTabsOutcome>;
}

export type PutAwayOutcome =
  | {
      kind: 'done';
      /** Ids whose tab closed. */
      closed: string[];
      /** Closed tabs that went into the stash (files, notes, untitled text made a note). */
      count: number;
      /** Of those, file tabs that were already in the stash (a dedup hit: the card rises). */
      dup: number;
      /** The first of them (tab order), by caption. */
      lead: string | null;
      leadIsNote: boolean;
      /** Blank new tabs that were only closed. */
      closedEmpty: number;
      /** Paths of the stashed tabs that had one before closing — for the repo chip's `hidden`. */
      stashedPaths: string[];
      /** Selected tabs that are still here (their close was refused, with its own toast). */
      kept: string[];
      /** Closed tabs Rust could not stash (already said by `stash-error`). */
      notStashed: NotStashed[];
    }
  | { kind: 'failed'; error: string };

interface Snapshot {
  id: string;
  path: string | null;
  caption: string;
  /** The close keeps something: a file, a note, or untitled text. */
  keeps: boolean;
  isNote: boolean;
  dup: boolean;
}

export async function putAwayTabs(ids: readonly string[], deps: PutAwayDeps): Promise<PutAwayOutcome> {
  const wanted = new Set(ids);
  const chosen: Snapshot[] = deps
    .tabs()
    .filter((tab) => wanted.has(tab.id))
    .map((tab) => {
      const mark = tab.path === null ? null : deps.mark(tab.path);
      return {
        id: tab.id,
        path: tab.path,
        caption: deps.caption(tab),
        keeps: tab.path !== null || !deps.blank(tab),
        isNote: tab.path === null || mark === 'note',
        dup: mark === 'file',
      };
    });
  let answer: PutAwayTabsOutcome = { closed: [], notStashed: [] };
  if (chosen.length > 0) {
    try {
      answer = await deps.close(chosen.map((s) => s.id));
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
  const closed = new Set(answer.closed);
  const refused = new Set(answer.notStashed.map((n) => n.id));
  const stashed = chosen.filter((s) => closed.has(s.id) && s.keeps && !refused.has(s.id));
  const lead = stashed[0] ?? null;
  return {
    kind: 'done',
    closed: chosen.filter((s) => closed.has(s.id)).map((s) => s.id),
    count: stashed.length,
    dup: stashed.filter((s) => s.dup).length,
    lead: lead?.caption ?? null,
    leadIsNote: lead?.isNote ?? false,
    closedEmpty: chosen.filter((s) => closed.has(s.id) && !s.keeps).length,
    stashedPaths: stashed.flatMap((s) => (s.path === null ? [] : [s.path])),
    kept: chosen.filter((s) => !closed.has(s.id)).map((s) => s.id),
    notStashed: answer.notStashed,
  };
}

/**
 * The `stash` toast for a finished put-away; `null` when there is nothing to
 * say here (every tab was refused or not stashed — those have their own
 * toasts). `hidden`: how many of the new cards the repo chip on screen hides,
 * known only after the store reloads — the caller counts it.
 */
export function putAwayNote(outcome: PutAwayOutcome, hidden = 0, hiddenBy: string | null = null): StashToastNote | null {
  if (outcome.kind === 'failed') return { what: 'error', message: outcome.error };
  const { count, closedEmpty } = outcome;
  if (count === 0 && closedEmpty === 0) return null;
  return {
    what: 'put-away',
    count,
    dup: outcome.dup,
    lead: outcome.lead,
    leadIsNote: outcome.leadIsNote,
    hidden,
    hiddenBy: hidden > 0 ? hiddenBy : null,
    onlyEmpty: count === 0 && closedEmpty > 0,
    emptyToo: count > 0 && closedEmpty > 0,
  };
}
