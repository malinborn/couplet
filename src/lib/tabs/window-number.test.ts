import { describe, expect, it, vi } from 'vitest';
import { parseWindowNumber, renumberWindow, type RenumberResult } from './window-number';

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
