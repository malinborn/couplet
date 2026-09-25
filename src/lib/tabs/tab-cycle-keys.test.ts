// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ctrlTab, ctrlTabHandler } from './tab-cycle-keys';
import { ctrlDigit } from './window-number';
import { nativeAccelerator } from '../editor/native-menu-accelerators';

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...init });
}

describe('ctrlTab', () => {
  it('⌃Tab is the next tab, ⌃⇧Tab the previous one', () => {
    expect(ctrlTab(key('Tab', { ctrlKey: true }))).toBe(1);
    expect(ctrlTab(key('Tab', { ctrlKey: true, shiftKey: true }))).toBe(-1);
  });

  it('leaves bare Tab, ⇧Tab (table/list indent), ⌘Tab, ⌥Tab and ⌃ with other keys alone', () => {
    expect(ctrlTab(key('Tab'))).toBeNull();
    expect(ctrlTab(key('Tab', { shiftKey: true }))).toBeNull();
    expect(ctrlTab(key('Tab', { metaKey: true }))).toBeNull();
    expect(ctrlTab(key('Tab', { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(ctrlTab(key('Tab', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(ctrlTab(key('Digit1', { ctrlKey: true }))).toBeNull();
    expect(ctrlTab(key('BracketRight', { ctrlKey: true }))).toBeNull();
  });

  it('matches the physical key, not the character', () => {
    expect(ctrlTab(new KeyboardEvent('keydown', { code: 'Tab', key: 'Unidentified', ctrlKey: true }))).toBe(1);
  });

  it('never overlaps ⌃1…⌃9 (window keys)', () => {
    const codes = ['Tab', ...Array.from({ length: 10 }, (_, i) => `Digit${i}`)];
    const mods: KeyboardEventInit[] = [
      { ctrlKey: true },
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, metaKey: true },
      { metaKey: true },
      {},
    ];
    for (const code of codes) {
      for (const m of mods) {
        const e = key(code, m);
        expect(ctrlTab(e) !== null && ctrlDigit(e) !== null, `${code} ${JSON.stringify(m)}`).toBe(false);
      }
    }
  });
});

describe('ctrlTabHandler', () => {
  it('takes ⌃Tab away from everyone after it and cycles', () => {
    const cycle = vi.fn();
    const handler = ctrlTabHandler(cycle);
    const e = key('Tab', { ctrlKey: true });
    const stop = vi.spyOn(e, 'stopImmediatePropagation');
    handler(e);
    expect(e.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(cycle).toHaveBeenLastCalledWith(1);
    handler(key('Tab', { ctrlKey: true, shiftKey: true }));
    expect(cycle).toHaveBeenLastCalledWith(-1);
  });

  it('a held key keeps cycling, as a held menu key does', () => {
    const cycle = vi.fn();
    ctrlTabHandler(cycle)(key('Tab', { ctrlKey: true, repeat: true }));
    expect(cycle).toHaveBeenCalledWith(1);
  });

  it('leaves every other key alone', () => {
    const cycle = vi.fn();
    const e = key('Tab');
    ctrlTabHandler(cycle)(e);
    expect(e.defaultPrevented).toBe(false);
    expect(cycle).not.toHaveBeenCalled();
  });
});

describe('the menu keys for the same commands', () => {
  it('are ⌘⇧] / ⌘⇧[, not a Ctrl-only chord', () => {
    expect(nativeAccelerator('next_tab')).toBe('CmdOrCtrl+Shift+BracketRight');
    expect(nativeAccelerator('prev_tab')).toBe('CmdOrCtrl+Shift+BracketLeft');
  });});
