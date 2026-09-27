/**
 * The stash's glyphs (mockup `ICONS` in
 * docs/investigations/2026-09-26-stash-mockup/stash-drawers.html, 16×16,
 * stroked): the tray is the stash itself, a note is a sheet couplet owns, a
 * file ref is a sheet with an arrow out, the repo is a folder, the bin is
 * «Удалённые» (stage 06). The one copy of
 * each path — `StashGlyph` (the tray on tab cards and the window title) and
 * `StashIcon` both draw from here. The note's `<rect>` is written as a path so
 * every icon is paths only.
 */
export type StashIconName = 'tray' | 'note' | 'fref' | 'repo' | 'bin';

export const STASH_ICONS: Record<StashIconName, readonly string[]> = {
  tray: ['M2.5 9.5 4.2 3.5h7.6l1.7 6', 'M2.5 9.5v3.2c0 .4.3.8.8.8h9.4c.5 0 .8-.4.8-.8V9.5h-3.3l-.9 1.6H6.7l-.9-1.6z'],
  note: [
    'M4.8 2.5h6.4c.72 0 1.3.58 1.3 1.3v8.4c0 .72-.58 1.3-1.3 1.3H4.8c-.72 0-1.3-.58-1.3-1.3V3.8c0-.72.58-1.3 1.3-1.3z',
    'M6 6h4M6 8.5h4M6 11h2.4',
  ],
  fref: [
    'M8 2.5H4.8c-.7 0-1.3.6-1.3 1.3v8.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V9',
    'M10.5 2.5h3v3M13.5 2.5 8.5 7.5',
  ],
  repo: ['M2.5 4.3c0-.5.4-.8.8-.8h3l1.3 1.5h5.1c.5 0 .8.4.8.8v6.4c0 .5-.3.8-.8.8H3.3c-.4 0-.8-.3-.8-.8z'],
  bin: [
    'M3 4.5h10M6.5 4.5V3h3v1.5',
    'M4.5 4.5l.6 8.3c.05.7.6 1.2 1.3 1.2h3.2c.7 0 1.25-.5 1.3-1.2l.6-8.3',
    'M7 7v4.2M9 7v4.2',
  ],
};
