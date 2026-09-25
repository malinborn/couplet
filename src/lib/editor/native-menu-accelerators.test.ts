import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_MENU_ACCELERATORS,
  nativeAccelerator,
  type NativeMenuAccelerator,
} from './native-menu-accelerators';

/**
 * The drift test #59 asks for.
 *
 * `menu.rs` owns the native accelerators; `native-menu-accelerators.ts` mirrors
 * them so the UI can print a key it did not declare. A mirror kept in step by
 * hand is wrong within a month and wrong *silently* — nothing in a running app
 * compares a tooltip against a menu, so the only symptom is a user pressing a
 * key the tooltip named and nothing happening, or a button that never mentions
 * the key it has.
 *
 * So this parses the Rust and asserts set equality, which fails in both
 * directions: an accelerator added in `menu.rs` and not mirrored, an entry left
 * behind after the Rust one was removed, and a key changed on either side.
 */

const MENU_RS = fileURLToPath(new URL('../../../src-tauri/src/menu.rs', import.meta.url));

/**
 * Every `with_id(...)` builder chain in `menu.rs`, and the accelerator it
 * declares if any.
 *
 * Chunking on `with_id(` rather than matching one big regex is what makes this
 * survive the file's two call shapes — the one-line `with_id("new", "New")` and
 * the multi-line one that computes its label (`restore_session`). Each chunk
 * runs to the next item, so an `.accelerator(...)` can only be attributed to
 * the item it is chained onto.
 */
function parseMenuAccelerators(source: string): NativeMenuAccelerator[] {
  // Whole-line comments only: `//` inside a string literal must survive.
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  const chunks = code.split('with_id(').slice(1);
  const found: NativeMenuAccelerator[] = [];

  for (const chunk of chunks) {
    const id = /^\s*"([^"]+)"/.exec(chunk)?.[1];
    if (!id) continue;
    const accelerator = /\.accelerator\("([^"]+)"\)/.exec(chunk)?.[1];
    if (accelerator) found.push({ id, accelerator });
  }

  return found;
}

const byId = (entries: readonly NativeMenuAccelerator[]): NativeMenuAccelerator[] =>
  [...entries].sort((a, b) => a.id.localeCompare(b.id));

describe('native menu accelerator mirror', () => {
  const source = readFileSync(MENU_RS, 'utf8');

  it('parses the accelerators out of menu.rs at all', () => {
    // A guard on the parser itself: if the Rust is reformatted into a shape
    // this regex misses, every assertion below would pass vacuously by finding
    // nothing on both sides.
    const parsed = parseMenuAccelerators(source);
    expect(parsed.length).toBeGreaterThan(5);
    expect(parsed).toContainEqual({ id: 'ai_comment', accelerator: 'CmdOrCtrl+Shift+M' });
  });

  it('matches menu.rs exactly, in both directions', () => {
    expect(byId(NATIVE_MENU_ACCELERATORS)).toEqual(byId(parseMenuAccelerators(source)));
  });

  it('does not list an id that menu.rs does not define', () => {
    const ids = new Set([...source.matchAll(/with_id\(\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const entry of NATIVE_MENU_ACCELERATORS) {
      expect(ids.has(entry.id)).toBe(true);
    }
  });

  it('has no duplicate ids', () => {
    const ids = NATIVE_MENU_ACCELERATORS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks up by id', () => {
    expect(nativeAccelerator('ai_comment')).toBe('CmdOrCtrl+Shift+M');
    // Items with no accelerator must answer undefined, not an empty string —
    // the caller uses that to decide whether to render a key at all.
    expect(nativeAccelerator('recent_files')).toBeUndefined();
    expect(nativeAccelerator('nonexistent')).toBeUndefined();
  });
});

describe('native menu accelerators and the keyboard', () => {
  it('declares no Ctrl-only accelerator — it would work by click only', () => {
    // With the window key, a Ctrl-only chord goes to the WKWebView and never
    // reaches NSMenu (measured 2026-09-25 on Ctrl+Tab and Ctrl+BracketLeft).
    // Such a chord belongs in the page, like ⌃1…⌃9 and ⌃Tab (`tabs/`). The
    // mirror equals menu.rs by the drift test above, so this covers the Rust.
    const command = /^(cmd|command|super|cmdorctrl|cmdorcontrol|commandorctrl|commandorcontrol)$/;
    for (const { id, accelerator } of NATIVE_MENU_ACCELERATORS) {
      const mods = accelerator
        .split('+')
        .slice(0, -1)
        .map((m) => m.toLowerCase());
      const ctrlOnly = mods.some((m) => m === 'ctrl' || m === 'control') && !mods.some((m) => command.test(m));
      expect(ctrlOnly, `${id}: ${accelerator}`).toBe(false);
    }
  });
});
