import { describe, it, expect } from 'vitest';
import {
  hotkeyLabel,
  ariaKeyShortcuts,
  acceleratorLabel,
  acceleratorAriaKeyShortcuts,
  isMacPlatform,
} from './hotkey-label';
import { INLINE_FORMAT_BINDINGS } from './keybindings';

/**
 * Measured in Chrome on macOS: `userAgentData.platform` is the string
 * `"macOS"`, lowercase `m`. A `/Mac/` test reads that as a PC and captions
 * every button `Ctrl+B` on a Mac — which is what this first shipped as.
 */
describe('isMacPlatform', () => {
  const withNavigator = (value: Record<string, unknown>): boolean => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
    try {
      return isMacPlatform();
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
    }
  };

  it('recognises the lowercase userAgentData spelling', () => {
    expect(withNavigator({ userAgentData: { platform: 'macOS' } })).toBe(true);
  });

  it('falls back past an empty userAgentData platform to navigator.platform', () => {
    expect(withNavigator({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe(true);
  });

  it('says no on Windows and Linux', () => {
    expect(withNavigator({ userAgentData: { platform: 'Windows' } })).toBe(false);
    expect(withNavigator({ platform: 'Linux x86_64' })).toBe(false);
  });
});

describe('hotkeyLabel', () => {
  it('renders macOS modifiers as run-together glyphs', () => {
    expect(hotkeyLabel('Mod-b', true)).toBe('⌘B');
    expect(hotkeyLabel('Mod-i', true)).toBe('⌘I');
    expect(hotkeyLabel('Mod-Shift-x', true)).toBe('⌘⇧X');
  });

  it('renders non-mac modifiers as words joined by +', () => {
    expect(hotkeyLabel('Mod-b', false)).toBe('Ctrl+B');
    expect(hotkeyLabel('Mod-Shift-x', false)).toBe('Ctrl+Shift+X');
  });

  it('leaves multi-character key names alone', () => {
    expect(hotkeyLabel('Mod-Enter', true)).toBe('⌘Enter');
    expect(hotkeyLabel('Escape', true)).toBe('Escape');
  });

  it('handles a bare minus as the key', () => {
    expect(hotkeyLabel('Mod--', true)).toBe('⌘-');
  });
});

describe('ariaKeyShortcuts', () => {
  it('spells modifiers the way the ARIA attribute wants them', () => {
    expect(ariaKeyShortcuts('Mod-b', true)).toBe('Meta+B');
    expect(ariaKeyShortcuts('Mod-b', false)).toBe('Control+B');
    expect(ariaKeyShortcuts('Mod-Shift-x', true)).toBe('Meta+Shift+X');
  });
});

/**
 * The point of #56: the toolbar's captions and the editor's keymap must come
 * out of one list. This is the test that fails if someone adds a binding and
 * quietly leaves the toolbar behind.
 */
describe('INLINE_FORMAT_BINDINGS', () => {
  it('covers exactly the three toggle-able inline formats', () => {
    expect(INLINE_FORMAT_BINDINGS.map((b) => b.kind)).toEqual([
      'strong',
      'emphasis',
      'strikethrough',
    ]);
  });

  it('produces a caption for every binding', () => {
    for (const b of INLINE_FORMAT_BINDINGS) {
      expect(hotkeyLabel(b.key, true)).toMatch(/^[⌘⌃⇧⌥]+\S+$/);
    }
  });
});

/**
 * #59: the 💬 button's key lives in the native menu (`menu.rs`), not in the
 * keymap, so it arrives in Tauri's accelerator notation instead of CM6's. Both
 * notations have to come out looking like the menu bar, or one row of buttons
 * would print its keys two ways.
 */
describe('acceleratorLabel', () => {
  it('renders the comment accelerator the way the menu bar draws it', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+M', true)).toBe('\u2318\u21e7M');
  });

  it('agrees with the CM6 notation for the same chord', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+X', true)).toBe(hotkeyLabel('Mod-Shift-x', true));
  });

  it('spells out the two word-named keys Tauri uses', () => {
    expect(acceleratorLabel('CmdOrCtrl+Plus', true)).toBe('\u2318+');
    expect(acceleratorLabel('CmdOrCtrl+Minus', true)).toBe('\u2318-');
  });

  it('keeps a digit as a digit', () => {
    expect(acceleratorLabel('CmdOrCtrl+0', true)).toBe('\u23180');
  });

  it('falls back to words joined by + off macOS', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+M', false)).toBe('Ctrl+Shift+M');
  });
});

describe('acceleratorAriaKeyShortcuts', () => {
  it('uses modifier names and Meta for the command key', () => {
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+Shift+M', true)).toBe('Meta+Shift+M');
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+Shift+M', false)).toBe('Control+Shift+M');
  });

  it('matches what the CM6 notation produces for the same chord', () => {
    expect(acceleratorAriaKeyShortcuts('CmdOrCtrl+B', true)).toBe(ariaKeyShortcuts('Mod-b', true));
  });
});
