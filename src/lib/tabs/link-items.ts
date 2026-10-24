import type { TabMeta } from './tab-model';
import type { StashMark } from '../stash/marks';
import type { LinkInsertItem } from '../editor/links/link-drop';

/**
 * Tabs dropped onto the text with ⌥ (file links D7): one link per tab that
 * has a file, in drag order. An untitled tab has nothing to link to. A stash
 * note links under its title — its file name is a date and a hash.
 */
export function linkItemsForTabs(
  ids: readonly string[],
  byId: ReadonlyMap<string, TabMeta>,
  marks: (path: string | null) => StashMark | null
): LinkInsertItem[] {
  const out: LinkInsertItem[] = [];
  for (const id of ids) {
    const tab = byId.get(id);
    if (!tab || tab.path === null) continue;
    const mark = marks(tab.path);
    out.push({ path: tab.path, title: mark?.kind === 'note' ? mark.title : null });
  }
  return out;
}
