import { describe, it, expect } from 'vitest';
import { hotkeyLabel, ariaKeyShortcuts, isMacPlatform } from './hotkey-label';
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
