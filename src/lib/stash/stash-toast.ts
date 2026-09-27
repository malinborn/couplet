/**
 * The `stash` toast (stash stage 04): one kind for every drawer report, so a
 * newer one replaces the last (`toasts.push` replaces a kind). A note that
 * stands until closed — a failure, a refusal — is `stash-standing` instead
 * (`isStandingStashNote`, review M3): under the shared kind the next quiet
 * report replaced it and went by itself, unread. Copy from the mockup's toasts. `stashToastText` is what `ToastStack` renders — plain text,
 * never `{@html}` (titles are user text).
 *
 * Not the `stash-error` kind: that one is stage 03's persistent headline for a
 * note that failed to be born or a put-away the stash refused. `error` here is
 * a drawer IPC call that failed (list, tag, delete, move).
 */
import { plural, t } from '../i18n';
import { TRASH_DAYS, TRASH_HELD_ERROR } from './trash-view';
import type { KeptReason } from './types';

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
  | { what: 'error'; message: string }
  /** Stage 06: a note went to the trash («удалить»). */
  | { what: 'trashed'; title: string }
  /** «вернуть»; `hiddenBy`: the repo chip that hides it in the stash now. */
  | { what: 'restored'; title: string; hiddenBy: string | null }
  | { what: 'purged'; title: string }
  /**
   * A delete that did not happen: a tab in window `label` still holds the
   * note. Stands until dismissed; «Перейти» shows that window.
   */
  | { what: 'kept'; reason: KeptReason; title: string; label: string; number: number | null }
  /**
   * «вернуть» / «удалить навсегда» refused: a tab holds the trashed note
   * (`TRASH_HELD_ERROR`). Stands until dismissed: the human has to close it.
   */
  | { what: 'held'; action: TrashAction; title: string };

/** The two actions on a trash card. */
export type TrashAction = 'restore' | 'purge';

/** The notes that stand until dismissed: something failed or was refused, and the human has to act. */
export type StandingStashNote = Extract<StashToastNote, { what: 'error' | 'kept' | 'pull-failed' | 'held' }>;

export function isStandingStashNote(note: StashToastNote): note is StandingStashNote {
  return note.what === 'error' || note.what === 'kept' || note.what === 'pull-failed' || note.what === 'held';
}

/**
 * A trash card's action failed: Rust's «a tab holds it» refusal becomes words
 * the human can act on; anything else stays the plain error with its message.
 */
export function trashFailureNote(action: TrashAction, title: string, message: string): StashToastNote {
  return message === TRASH_HELD_ERROR ? { what: 'held', action, title } : { what: 'error', message };
}

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
    case 'trashed':
      return {
        text: t('toast.stash.trashed', { title: note.title }),
        dim: t('toast.stash.trashed_tail', { days: TRASH_DAYS }),
      };
    case 'restored': {
      const tail = t('toast.stash.restored_tail');
      return {
        text: t('toast.stash.restored', { title: note.title }),
        dim: note.hiddenBy === null ? tail : `${tail} ${t('toast.stash.restored_hidden', { repo: note.hiddenBy })}`,
      };
    }
    case 'purged':
      return { text: t('toast.stash.purged', { title: note.title }), dim: '' };
    case 'kept':
      return { text: t(`toast.stash.kept_${note.reason}`, { title: note.title, number: note.number ?? '?' }), dim: '' };
    case 'held':
      return { text: t(`toast.stash.held_${note.action}`, { title: note.title }), dim: '' };
  }
}
