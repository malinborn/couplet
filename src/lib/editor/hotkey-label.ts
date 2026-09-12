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

/**
 * Modifier name -> macOS glyph.
 *
 * Covers CM6 key specs (`Mod`, `Cmd`) and Tauri accelerators (`CmdOrCtrl`,
 * `Super`) in one table, so the two notations cannot render differently.
 */
const MAC_GLYPH: Record<string, string> = {
  Mod: '⌘',
  Cmd: '⌘',
  CmdOrCtrl: '⌘',
  Command: '⌘',
  Super: '⌘',
  Meta: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Shift: '⇧',
  Alt: '⌥',
  Option: '⌥',
};

/** Modifier name -> word, for platforms without the glyph convention. */
const PLAIN_NAME: Record<string, string> = {
  Mod: 'Ctrl',
  Cmd: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Command: 'Ctrl',
  Super: 'Win',
  Meta: 'Ctrl',
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Option: 'Alt',
};

/**
 * Tauri spells two keys as words where a menu draws the character. Everything
 * else is either a single character or already a name (`Enter`, `Space`).
 */
const KEY_CHARACTER: Record<string, string> = {
  Plus: '+',
  Minus: '-',
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

/**
 * Caption for one **Tauri** accelerator (`CmdOrCtrl+Shift+M` -> `⌘⇧M`).
 *
 * The native menu's own notation, not CM6's — see
 * `native-menu-accelerators.ts` for why the two coexist. Rendering shares the
 * glyph tables above so a key declared in Rust and a key declared in the
 * keymap read identically in a tooltip.
 */
export function acceleratorLabel(accelerator: string, mac: boolean = isMacPlatform()): string {
  const parts = accelerator.split('+').filter((p) => p !== '');
  const last = parts.pop() ?? '';
  const main = KEY_CHARACTER[last] ?? (last.length === 1 ? last.toUpperCase() : last);
  const table = mac ? MAC_GLYPH : PLAIN_NAME;
  const mods = parts.map((m) => table[m] ?? m);
  return mac ? [...mods, main].join('') : [...mods, main].join('+');
}

/** The same Tauri accelerator as `aria-keyshortcuts` wants it. */
export function acceleratorAriaKeyShortcuts(
  accelerator: string,
  mac: boolean = isMacPlatform()
): string {
  const parts = accelerator.split('+').filter((p) => p !== '');
  const last = parts.pop() ?? '';
  const main = KEY_CHARACTER[last] ?? (last.length === 1 ? last.toUpperCase() : last);
  const mods = parts.map((m) =>
    m === 'CmdOrCtrl' || m === 'Cmd' || m === 'Command' || m === 'Super'
      ? mac
        ? 'Meta'
        : 'Control'
      : m === 'Ctrl'
        ? 'Control'
        : m === 'Option'
          ? 'Alt'
          : m
  );
  return [...mods, main].join('+');
}
