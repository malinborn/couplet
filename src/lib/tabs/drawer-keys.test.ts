import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DRAWER_SORT_KEYS, sortKindForCode } from './drawer-keys';
import { NATIVE_MENU_ACCELERATORS, nativeAccelerator } from '../editor/native-menu-accelerators';

const MENU_RS = fileURLToPath(new URL('../../../src-tauri/src/menu.rs', import.meta.url));

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
});
