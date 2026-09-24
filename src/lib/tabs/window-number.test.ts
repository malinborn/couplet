// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  ctrlDigit,
  ctrlDigitHandler,
  parseWindowNumber,
  renumberWindow,
  revealWindowNumber,
  type RenumberResult,
  type RevealResult,
} from './window-number';

describe('parseWindowNumber', () => {
  it('takes one or two digits in 1–99', () => {
    expect(parseWindowNumber('1')).toBe(1);
    expect(parseWindowNumber('07')).toBe(7);
    expect(parseWindowNumber('99')).toBe(99);
  });

  it('refuses anything else', () => {
    for (const draft of ['', '0', '00', '100', '1a', ' 5', '-1', '1.5']) {
      expect(parseWindowNumber(draft), JSON.stringify(draft)).toBeNull();
    }
  });
});

describe('renumberWindow', () => {
  function deps(answer: () => Promise<RenumberResult>) {
    return { setNumber: vi.fn(answer), apply: vi.fn(), toast: vi.fn() };
  }

  it('set: the window shows the new number, no toast', async () => {
    const d = deps(async () => 'set');
    expect(await renumberWindow(12, d)).toBe('set');
    expect(d.setNumber).toHaveBeenCalledWith(12);
    expect(d.apply).toHaveBeenCalledWith(12);
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('taken: nothing changes and a toast says the number is taken', async () => {
    const d = deps(async () => 'taken');
    expect(await renumberWindow(4, d)).toBe('taken');
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.toast).toHaveBeenCalledWith({ kind: 'window-number', reason: 'taken', number: 4 });
  });

  it('invalid: nothing changes, no toast (the input shakes)', async () => {
    const d = deps(async () => 'invalid');
    expect(await renumberWindow(4, d)).toBe('invalid');
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('a failed IPC changes nothing and answers invalid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps(async () => {
      throw new Error('no backend');
    });
    expect(await renumberWindow(4, d)).toBe('invalid');
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, key: code.slice(-1), bubbles: true, cancelable: true, ...init });
}

describe('ctrlDigit', () => {
  it('⌃1…⌃9 name a window', () => {
    for (let n = 1; n <= 9; n++) expect(ctrlDigit(key(`Digit${n}`, { ctrlKey: true }))).toBe(n);
  });

  it('leaves ⌘digit (tabs), ⌃0, ⌃Tab, other modifiers and bare digits alone', () => {
    expect(ctrlDigit(key('Digit1', { metaKey: true }))).toBeNull();
    expect(ctrlDigit(key('Digit1', { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(ctrlDigit(key('Digit1', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(ctrlDigit(key('Digit1', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(ctrlDigit(key('Digit0', { ctrlKey: true }))).toBeNull();
    expect(ctrlDigit(key('Tab', { ctrlKey: true }))).toBeNull();
    expect(ctrlDigit(key('Numpad1', { ctrlKey: true }))).toBeNull();
    expect(ctrlDigit(key('Digit1'))).toBeNull();
  });

  it('matches the physical key, not the character a layout gives it', () => {
    // AZERTY: the 1 key types «&».
    expect(ctrlDigit(new KeyboardEvent('keydown', { code: 'Digit1', key: '&', ctrlKey: true }))).toBe(1);
  });
});

describe('revealWindowNumber', () => {
  function deps(current: number | null, answer: () => Promise<RevealResult>) {
    return { current: () => current, reveal: vi.fn(answer), toast: vi.fn() };
  }

  it('another window: asks Rust to bring it forward, no toast', async () => {
    const d = deps(1, async () => 'revealed');
    await revealWindowNumber(3, d);
    expect(d.reveal).toHaveBeenCalledWith(3);
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('no such window: a quiet toast', async () => {
    const d = deps(1, async () => 'missing');
    await revealWindowNumber(5, d);
    expect(d.toast).toHaveBeenCalledWith({ kind: 'window-number', reason: 'missing', number: 5 });
  });

  it('its own number does nothing at all', async () => {
    const d = deps(2, async () => 'current');
    await revealWindowNumber(2, d);
    expect(d.reveal).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('a failed IPC shows nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps(1, async () => {
      throw new Error('no backend');
    });
    await revealWindowNumber(4, d);
    expect(d.toast).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('ctrlDigitHandler', () => {
  it('takes ⌃digit away from everyone after it and ignores key repeat', async () => {
    const d = { current: () => 1, reveal: vi.fn(async (): Promise<RevealResult> => 'revealed'), toast: vi.fn() };
    const handler = ctrlDigitHandler(d);
    const e = key('Digit3', { ctrlKey: true });
    const stop = vi.spyOn(e, 'stopImmediatePropagation');
    handler(e);
    expect(e.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    handler(key('Digit3', { ctrlKey: true, repeat: true }));
    await Promise.resolve();
    expect(d.reveal).toHaveBeenCalledTimes(1);
  });

  it('leaves every other key alone', () => {
    const d = { current: () => 1, reveal: vi.fn(async (): Promise<RevealResult> => 'revealed'), toast: vi.fn() };
    const e = key('Digit3', { metaKey: true });
    ctrlDigitHandler(d)(e);
    expect(e.defaultPrevented).toBe(false);
    expect(d.reveal).not.toHaveBeenCalled();
  });
});
