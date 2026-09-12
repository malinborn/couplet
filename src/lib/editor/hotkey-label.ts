/**
 * Rendering a CM6 key spec (`Mod-Shift-x`) as the symbols a macOS user already
 * reads in the menu bar (`⌘⇧X`).
 *
 * It exists so the selection toolbar's tooltips (#56) can be built from the
 * binding table itself — `INLINE_FORMAT_BINDINGS` in `keybindings.ts` — instead
 * of a hand-written second list of captions. A caption list drifts from the
 * real keys the first time a binding changes, and the drift is invisible: the
 * tooltip keeps confidently naming a key that no longer does anything.
 */

/** CM6 modifier name -> macOS glyph. */
const MAC_GLYPH: Record<string, string> = {
  Mod: '⌘',
  Cmd: '⌘',
  Meta: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Shift: '⇧',
  Alt: '⌥',
  Option: '⌥',
};

/** CM6 modifier name -> word, for platforms without the glyph convention. */
const PLAIN_NAME: Record<string, string> = {
  Mod: 'Ctrl',
  Cmd: 'Ctrl',
  Meta: 'Ctrl',
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Option: 'Alt',
};

/**
 * Whether `Mod-` means Command here.
 *
 * Case-insensitive on purpose, and measured rather than assumed: the modern
 * `navigator.userAgentData.platform` answers `"macOS"` — lowercase `m` — so the
 * obvious `/Mac/` test reads a Mac as a PC and captions every button `Ctrl+B`.
 * The legacy `navigator.platform` next to it says `MacIntel`, which is exactly
 * how the mistake stays invisible in any environment that lacks the new API.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Human caption for one CM6 key spec.
 *
 * On macOS the modifiers run together with no separator and no `+`, exactly as
 * the menu bar draws them; elsewhere they are words joined by `+`.
 */
export function hotkeyLabel(key: string, mac: boolean = isMacPlatform()): string {
  const parts = key.split('-');
  // A bare `-` as the key itself (`Mod--`) leaves an empty tail; put it back.
  const last = parts.pop() ?? '';
  const main = last === '' ? '-' : last.length === 1 ? last.toUpperCase() : last;
  const table = mac ? MAC_GLYPH : PLAIN_NAME;
  const mods = parts.filter((m) => m !== '').map((m) => table[m] ?? m);
  return mac ? [...mods, main].join('') : [...mods, main].join('+');
}

/**
 * The same key spec as `aria-keyshortcuts` wants it: modifier *names*, `+` as
 * the separator, and `Meta` rather than CM6's platform-dependent `Mod`.
 */
export function ariaKeyShortcuts(key: string, mac: boolean = isMacPlatform()): string {
  const parts = key.split('-');
  const last = parts.pop() ?? '';
  const main = last === '' ? '-' : last.length === 1 ? last.toUpperCase() : last;
  const mods = parts
    .filter((m) => m !== '')
    .map((m) => (m === 'Mod' ? (mac ? 'Meta' : 'Control') : m === 'Cmd' ? 'Meta' : m === 'Ctrl' ? 'Control' : m === 'Option' ? 'Alt' : m));
  return [...mods, main].join('+');
}
