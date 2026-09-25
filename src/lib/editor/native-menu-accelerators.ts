/**
 * The accelerators declared by the native macOS menu, mirrored for the UI.
 *
 * Some commands have both a menu item and an on-screen affordance — today the
 * 💬 button in the selection toolbar, whose key is `ai_comment`'s. The toolbar
 * builds its captions from the keymap on purpose (`INLINE_FORMAT_BINDINGS`,
 * see `keybindings.ts`), and an action whose key is declared in Rust never
 * enters that array, so it rendered caption-only: "Comment", no key, for a
 * command that has one (#59).
 *
 * This is the mirror, not a second source: `menu.rs` still owns the keys, and
 * `native-menu-accelerators.test.ts` parses that file and fails if this array
 * and it disagree in either direction — a missing entry, a stale one, or a
 * changed accelerator. A mirror without that test drifts back within a month,
 * silently, because nothing in a running app ever compares a tooltip against a
 * menu.
 *
 * Strings are verbatim Tauri accelerator syntax so the comparison can be exact.
 */

export interface NativeMenuAccelerator {
  /** Menu item id — the `menu-event` payload the frontend switches on. */
  id: string;
  /** Tauri accelerator, exactly as written in `src-tauri/src/menu.rs`. */
  accelerator: string;
}

export const NATIVE_MENU_ACCELERATORS: readonly NativeMenuAccelerator[] = [
  { id: 'new', accelerator: 'CmdOrCtrl+N' },
  { id: 'new_tab', accelerator: 'CmdOrCtrl+T' },
  { id: 'open', accelerator: 'CmdOrCtrl+O' },
  { id: 'save', accelerator: 'CmdOrCtrl+S' },
  { id: 'save_as', accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'close', accelerator: 'CmdOrCtrl+W' },
  { id: 'reopen_closed', accelerator: 'CmdOrCtrl+Shift+T' },
  { id: 'select_all', accelerator: 'CmdOrCtrl+A' },
  { id: 'find', accelerator: 'CmdOrCtrl+F' },
  { id: 'format_json', accelerator: 'CmdOrCtrl+Shift+J' },
  { id: 'toggle_mode', accelerator: 'CmdOrCtrl+E' },
  { id: 'zoom_in', accelerator: 'CmdOrCtrl+Equal' },
  { id: 'zoom_out', accelerator: 'CmdOrCtrl+Minus' },
  { id: 'zoom_reset', accelerator: 'CmdOrCtrl+0' },
  { id: 'ai_comment', accelerator: 'CmdOrCtrl+Shift+M' },
  { id: 'next_tab', accelerator: 'CmdOrCtrl+Shift+BracketRight' },
  { id: 'prev_tab', accelerator: 'CmdOrCtrl+Shift+BracketLeft' },
  { id: 'toggle_drawer', accelerator: 'CmdOrCtrl+J' },
  { id: 'select_tab_1', accelerator: 'CmdOrCtrl+1' },
  { id: 'select_tab_2', accelerator: 'CmdOrCtrl+2' },
  { id: 'select_tab_3', accelerator: 'CmdOrCtrl+3' },
  { id: 'select_tab_4', accelerator: 'CmdOrCtrl+4' },
  { id: 'select_tab_5', accelerator: 'CmdOrCtrl+5' },
  { id: 'select_tab_6', accelerator: 'CmdOrCtrl+6' },
  { id: 'select_tab_7', accelerator: 'CmdOrCtrl+7' },
  { id: 'select_tab_8', accelerator: 'CmdOrCtrl+8' },
  { id: 'select_tab_9', accelerator: 'CmdOrCtrl+9' },
];

/** The accelerator for a menu item id, or `undefined` if it carries none. */
export function nativeAccelerator(id: string): string | undefined {
  return NATIVE_MENU_ACCELERATORS.find((entry) => entry.id === id)?.accelerator;
}
