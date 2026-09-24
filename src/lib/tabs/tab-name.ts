import { t } from '../i18n';

/** A tab's caption: its file's name, or the untitled label. */
export function tabName(path: string | null): string {
  if (path === null) return t('ui.untitled');
  return path.split('/').pop() || path;
}
