/**
 * The `stash` toast (stash stage 04): one kind for every drawer notice, so a
 * newer one replaces the last (`toasts.push` replaces a kind). Copy from the
 * mockup's toasts. `stashToastText` is what `ToastStack` renders — plain text,
 * never `{@html}` (titles are user text).
 *
 * Not the `stash-error` kind: that one is stage 03's persistent headline for a
 * note that failed to be born or a put-away the stash refused. `error` here is
 * a drawer IPC call that failed (list, tag, delete, move).
 */
import { plural, t } from '../i18n';

export type StashToastNote =
  | {
      what: 'put-away';
      /**
       * Tabs that went into the stash. A put-away closes each tab the way ⌃T
       * does (`controller.putAwayTabs`, one `tab_close` per tab), so there is no
       * batch answer to count entries from: the caller counts the closed tabs
       * that held something to keep.
       */
      count: number;
      /**
       * File tabs that were already in the stash — read from the stash marks
       * BEFORE the tabs close, because the close itself makes them stashed. A
       * note is always in the stash, so notes never count.
       */
      dup: number;
      /** The first put-away tab's caption, taken by the caller before it closes. */
      lead: string | null;
      leadIsNote: boolean;
      /** How many of them the repo chip hides right now (known after the store reloads). */
      hidden: number;
      hiddenBy: string | null;
      /** Only empty tabs were closed: nothing to keep. */
      onlyEmpty: boolean;
      /** Empty tabs were closed along with the rest. */
      emptyToo: boolean;
    }
  | { what: 'opened'; title: string; isNote: boolean; from: number | null }
  | { what: 'removed'; title: string }
  | { what: 'widened' }
  | { what: 'pull-failed'; number: number | null; label: string }
  | { what: 'error'; message: string };

export interface StashToastText {
  text: string;
  dim: string;
}

function putAwayText(note: Extract<StashToastNote, { what: 'put-away' }>): StashToastText {
  if (note.onlyEmpty) return { text: t('toast.stash.only_empty'), dim: t('toast.stash.only_empty_tail') };
  const title = note.lead ?? '';
  const dims: string[] = [];
  let text: string;
  if (note.count === 1 && note.leadIsNote) {
    text = t('toast.stash.put_note', { title });
    dims.push(t('toast.stash.put_note_tail'));
  } else if (note.count === 1 && note.dup === 1) {
    text = t('toast.stash.put_one', { title });
    dims.push(t('toast.stash.put_dup_tail'));
  } else if (note.count === 1) {
    text = t('toast.stash.put_one', { title });
    dims.push(t('toast.stash.put_one_tail'));
  } else {
    text = t('toast.stash.put_many', { count: note.count });
    if (note.dup > 0) dims.push(t('toast.stash.put_many_dup', { dup: note.dup }));
  }
  if (note.hidden > 0 && note.hiddenBy !== null) {
    dims.push(plural(note.hidden, 'toast.stash.hidden', { repo: note.hiddenBy }));
  }
  if (note.emptyToo) dims.push(t('toast.stash.empty_too'));
  return { text, dim: dims.join(' ') };
}

export function stashToastText(note: StashToastNote): StashToastText {
  switch (note.what) {
    case 'put-away':
      return putAwayText(note);
    case 'opened':
      return {
        text: t(note.isNote ? 'toast.stash.opened_note' : 'toast.stash.opened_file', { title: note.title }),
        dim:
          note.from === null
            ? t('toast.stash.from_stash')
            : t(note.isNote ? 'toast.stash.moved_note' : 'toast.stash.moved_file', { n: note.from }),
      };
    case 'removed':
      return { text: t('toast.stash.removed', { title: note.title }), dim: t('toast.stash.removed_tail') };
    case 'widened':
      return { text: t('toast.stash.widened'), dim: t('toast.stash.widened_tail') };
    case 'pull-failed':
      return { text: t('toast.stash.pull_failed', { n: note.number ?? '?' }), dim: '' };
    case 'error':
      return { text: t('toast.stash.error'), dim: note.message };
  }
}
