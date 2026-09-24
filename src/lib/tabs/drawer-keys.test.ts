import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DRAWER_MOVE_KEY, DRAWER_SORT_KEYS, sortKindForCode } from './drawer-keys';
import { NATIVE_MENU_ACCELERATORS, nativeAccelerator } from '../editor/native-menu-accelerators';

const MENU_RS = fileURLToPath(new URL('../../../src-tauri/src/menu.rs', import.meta.url));
const LIB_RS = fileURLToPath(new URL('../../../src-tauri/src/lib.rs', import.meta.url));

describe('drawer sort keys', () => {
  it('NeverCollideWithANativeMenuAccelerator', () => {
    // A native accelerator is resolved before the webview sees the key: the
    // drawer's handler would silently stop firing.
    const native = new Set(NATIVE_MENU_ACCELERATORS.map((a) => a.accelerator));
    for (const key of DRAWER_SORT_KEYS) expect(native.has(key.accelerator)).toBe(false);
  });

  it('AreNotClaimedByMenuRsEither', () => {
    // The mirror above can lag menu.rs until its own drift test runs; this
    // reads the Rust directly so the collision is reported here, by name.
    const claimed = new Set(
      [...readFileSync(MENU_RS, 'utf8').matchAll(/\.accelerator\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
    );
    expect(claimed.size).toBeGreaterThan(5);
    for (const key of DRAWER_SORT_KEYS) expect(claimed.has(key.accelerator)).toBe(false);
  });

  it('EachCodeNamesTheLetterOfItsAccelerator', () => {
    for (const key of DRAWER_SORT_KEYS) {
      expect(key.code).toMatch(/^Key[A-Z]$/);
      expect(key.accelerator).toBe(`CmdOrCtrl+${key.code.slice(3)}`);
    }
  });

  it('MapsCodesToSorts', () => {
    expect(sortKindForCode('KeyL')).toBe('opened');
    expect(sortKindForCode('KeyR')).toBe('viewed');
    expect(sortKindForCode('KeyU')).toBe('ai');
    expect(sortKindForCode('KeyJ')).toBeUndefined();
  });

  it('TheDrawerItselfOpensFromTheNativeMenu', () => {
    expect(nativeAccelerator('toggle_drawer')).toBe('CmdOrCtrl+J');
  });

  it('TheMoveKeyIsNobodysEither', () => {
    // ⌘G is «В окно…» only while the drawer is open (plan 05, D10, Q11);
    // outside it, CodeMirror's findNext. A menu item would take it in both.
    expect(DRAWER_MOVE_KEY.accelerator).toBe('CmdOrCtrl+G');
    const native = new Set(NATIVE_MENU_ACCELERATORS.map((a) => a.accelerator));
    expect(native.has(DRAWER_MOVE_KEY.accelerator)).toBe(false);
    const claimed = [...readFileSync(MENU_RS, 'utf8').matchAll(/\.accelerator\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    expect(claimed).not.toContain(DRAWER_MOVE_KEY.accelerator);
    expect(DRAWER_MOVE_KEY.accelerator).toBe(`CmdOrCtrl+${DRAWER_MOVE_KEY.code.slice(3)}`);
  });

  it('CmdMIsMacOSMinimize_TheWindowMenuHasIt_AndTheDrawerLeavesIt', () => {
    // A predefined Minimize carries ⌘M without an `.accelerator("…")` string,
    // so the mirror above cannot see it: pin the item itself (Q11).
    expect(readFileSync(MENU_RS, 'utf8')).toMatch(/\.minimize(?:_with_text)?\s*\(|PredefinedMenuItem::minimize/);
    expect(DRAWER_MOVE_KEY.code).not.toBe('KeyM');
    for (const key of DRAWER_SORT_KEYS) expect(key.code).not.toBe('KeyM');
    // Tauri's default menu would add a second Window (and Edit) menu beside ours.
    for (const file of [MENU_RS, LIB_RS]) expect(readFileSync(file, 'utf8')).not.toMatch(/Menu::default\s*\(/);
  });
});
