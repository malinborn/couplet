import { t } from './i18n';

export interface WindowTitleInput {
  /** File name, or the localized "Untitled". */
  name: string;
  dirty: boolean;
  /** `#N`; `null` before the window knows it, or when all 99 are taken. */
  number: number | null;
  product: string;
}

/**
 * `README.md — #7` (spec §3). A `-dev` build appends its product name: the
 * titlebar is where a human tells it from the installed release.
 */
export function windowTitle({ name, dirty, number, product }: WindowTitleInput): string {
  const mark = dirty ? '● ' : '';
  if (number === null) return `${mark}${t('ui.window_title', { name, product })}`;
  const numbered = t('ui.window_title_numbered', { name, number });
  return `${mark}${product.endsWith('-dev') ? `${numbered} · ${product}` : numbered}`;
}
