// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCtrlT, stashKeysHandler } from './stash-keys';
import { ctrlTab } from '../tabs/tab-cycle-keys';
import { ctrlDigit } from '../tabs/window-number';
import { NATIVE_MENU_ACCELERATORS } from '../editor/native-menu-accelerators';
// `?raw`, not `node:fs` + `import.meta.url`: under jsdom that URL is not a
// `file:` URL, so `fileURLToPath` throws before a single test runs.
import menu from '../../../src-tauri/src/menu.rs?raw';

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...init });
}

describe('isCtrlT', () => {
  it('is ⌃T by the physical key, and nothing else', () => {
    expect(isCtrlT(key('KeyT', { ctrlKey: true }))).toBe(true);
    expect(isCtrlT(new KeyboardEvent('keydown', { code: 'KeyT', key: 'е', ctrlKey: true }))).toBe(true);
    expect(isCtrlT(key('KeyT'))).toBe(false);
    expect(isCtrlT(key('KeyT', { metaKey: true }))).toBe(false); // ⌘T is New Tab
    expect(isCtrlT(key('KeyT', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCtrlT(key('KeyT', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCtrlT(key('KeyT', { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(isCtrlT(key('KeyS', { ctrlKey: true }))).toBe(false); // ⌃S is stage 04
  });

  it('never overlaps ⌃Tab or ⌃1…⌃9', () => {
    const e = key('KeyT', { ctrlKey: true });
    expect(ctrlTab(e)).toBeNull();
    expect(ctrlDigit(e)).toBeNull();
  });
});

describe('stashKeysHandler', () => {
  const installed: Array<(e: KeyboardEvent) => void> = [];
  function listen(fn: (e: KeyboardEvent) => void): void {
    window.addEventListener('keydown', fn, true);
    installed.push(fn);
  }
  afterEach(() => {
    for (const fn of installed.splice(0)) window.removeEventListener('keydown', fn, true);
  });

  it('takes ⌃T from everyone after it and puts away once', () => {
    const putAway = vi.fn();
    const later = vi.fn();
    listen(stashKeysHandler({ putAway }));
    listen(later);
    const e = key('KeyT', { ctrlKey: true });
    document.body.dispatchEvent(e);
    expect(putAway).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('swallows a held ⌃T without putting away tab after tab', () => {
    const putAway = vi.fn();
    const handler = stashKeysHandler({ putAway });
    const e = key('KeyT', { ctrlKey: true, repeat: true });
    handler(e);
    expect(putAway).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves the key to an IME that is composing, still out of CodeMirror', () => {
    const putAway = vi.fn();
    const e = key('KeyT', { ctrlKey: true, isComposing: true });
    stashKeysHandler({ putAway })(e);
    expect(putAway).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves every other key alone', () => {
    const putAway = vi.fn();
    const later = vi.fn();
    listen(stashKeysHandler({ putAway }));
    listen(later);
    for (const e of [
      key('KeyT'),
      key('KeyT', { metaKey: true }),
      key('KeyS', { ctrlKey: true }),
      key('Tab', { ctrlKey: true }),
      key('Digit1', { ctrlKey: true }),
    ]) {
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, e.code).toBe(false);
    }
    expect(putAway).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(5);
  });
});

/**
 * `Ctrl+T` / `Ctrl+S` in any Tauri spelling (`Control`, lower case, `KeyT`),
 * with ⌃ as the only modifier. `CmdOrCtrl+T` is ⌘T on macOS and is not one.
 */
function isCtrlOnlyTOrS(accelerator: string): boolean {
  const parts = accelerator.split('+').map((p) => p.trim().toLowerCase());
  const last = parts.pop() ?? '';
  const letter = last.startsWith('key') ? last.slice(3) : last;
  if (letter !== 't' && letter !== 's') return false;
  return parts.length > 0 && parts.every((m) => m === 'ctrl' || m === 'control');
}

describe('the native menu', () => {
  const claimed = [...menu.matchAll(/\.accelerator\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);

  it('the guard below recognises ⌃T and ⌃S however Tauri spells them', () => {
    for (const a of ['Ctrl+T', 'Control+T', 'ctrl+t', 'Ctrl+KeyT', 'Ctrl+S', 'Control+s']) {
      expect(isCtrlOnlyTOrS(a), a).toBe(true);
    }
    for (const a of ['CmdOrCtrl+T', 'CmdOrCtrl+S', 'Ctrl+Shift+T', 'Ctrl+Tab', 'Ctrl+1', 'T']) {
      expect(isCtrlOnlyTOrS(a), a).toBe(false);
    }
  });

  it('never declares ⌃T or ⌃S — a Ctrl-only accelerator never fires from the keyboard', () => {
    // Read menu.rs directly: the mirror can lag it until its own drift test runs.
    expect(claimed.length).toBeGreaterThan(5);
    for (const a of claimed) expect(isCtrlOnlyTOrS(a), a).toBe(false);
    for (const a of NATIVE_MENU_ACCELERATORS) expect(isCtrlOnlyTOrS(a.accelerator), a.id).toBe(false);
  });

  it('has «Отложить в тайник» without a key', () => {
    const item = /MenuItemBuilder::with_id\("stash_put_away"[\s\S]*?\.build\(app\)/.exec(menu)?.[0];
    expect(item).toBeDefined();
    expect(item).not.toMatch(/\.accelerator\(/);
  });

  it('has «Тайник» (View → Tabs) without a key — ⌃S is a page key', () => {
    const item = /MenuItemBuilder::with_id\("toggle_stash"[\s\S]*?\.build\(app\)/.exec(menu)?.[0];
    expect(item).toBeDefined();
    expect(item).toContain('t("menu.view.toggle_stash")');
    expect(item).not.toMatch(/\.accelerator\(/);
  });
});
