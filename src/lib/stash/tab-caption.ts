import { t } from '../i18n';
import type { StashMark } from './marks';

/** What a tab card shows about the stash (mockup `cardHTML`). */
export type CardStash = { kind: 'note'; repo: string | null } | { kind: 'in-stash' } | { kind: 'blank' };

export interface Caption {
  name: string;
  stash: CardStash | null;
}

export interface CaptionInput {
  path: string | null;
  /** `noteTitle` of the text the tab holds; `undefined` when the text is not known. */
  title: string | null | undefined;
  /** The tab holds nothing but whitespace. */
  blank: boolean;
  mark: StashMark | null;
}

/**
 * A tab's caption (stash spec «Отметка тайника»): a blank untitled tab is a
 * new note; a note shows its live title (its stored one while the text is
 * unknown) with the stash glyph; a file keeps its name, with the small glyph
 * when it is in the stash. No «в тайнике» text anywhere.
 */
export function tabCaption({ path, title, blank, mark }: CaptionInput): Caption {
  if (path === null) {
    return blank
      ? { name: t('stash.new_note'), stash: { kind: 'blank' } }
      : { name: title ?? t('stash.new_note'), stash: null };
  }
  if (mark?.kind === 'note') {
    const name = title === undefined ? (mark.title ?? t('stash.untitled')) : (title ?? t('stash.untitled'));
    return { name, stash: { kind: 'note', repo: mark.repo } };
  }
  return {
    name: path.split('/').pop() || path,
    stash: mark?.kind === 'file' ? { kind: 'in-stash' } : null,
  };
}

/**
 * A repo as the card shows it. Rust stores a directory name already (roadmap
 * A3); the last component is taken anyway, so a value from an older build that
 * still holds a path renders as a name too.
 */
export function repoLabel(repo: string | null): string {
  if (!repo) return '';
  return repo.split('/').filter(Boolean).pop() ?? repo;
}
