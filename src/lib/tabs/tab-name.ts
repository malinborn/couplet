import { t } from '../i18n';

/** A tab's caption: its file's name, or the untitled label. */
export function tabName(path: string | null): string {
  if (path === null) return t('ui.untitled');
  return path.split('/').pop() || path;
}

/** Several files' names for one line of text: the first three, then "+N". */
export function tabNames(paths: readonly (string | null)[]): string {
  const shown = paths.slice(0, 3).map(tabName).join(', ');
  return paths.length > 3 ? `${shown} +${paths.length - 3}` : shown;
}
