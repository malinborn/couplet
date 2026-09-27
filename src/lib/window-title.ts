import { t } from './i18n';

/**
 * The stash glyph in the native title bar (D14): a text character — the
 * title bar cannot draw the drawer's SVG tray. U+2294 SQUARE CUP reads as a
 * tray. The owner may pick another; change it here only.
 */
export const STASH_TITLE_GLYPH = '⊔';

export interface WindowTitleInput {
  /** File name, a note's title, or «Новая заметка». */
  name: string;
  dirty: boolean;
  /** `#N`; `null` before the window knows it, or when all 99 are taken. */
  number: number | null;
  product: string;
  /** The document is a stash note: the glyph goes before its name. */
  stashed?: boolean;
}

/**
 * `README.md — #7` (spec §3). A `-dev` build appends its product name: the
 * titlebar is where a human tells it from the installed release.
 */
export function windowTitle({ name, dirty, number, product, stashed = false }: WindowTitleInput): string {
  const mark = dirty ? '● ' : '';
  const shown = stashed ? `${STASH_TITLE_GLYPH} ${name}` : name;
  if (number === null) return `${mark}${t('ui.window_title', { name: shown, product })}`;
  const numbered = t('ui.window_title_numbered', { name: shown, number });
  return `${mark}${product.endsWith('-dev') ? `${numbered} · ${product}` : numbered}`;
}
