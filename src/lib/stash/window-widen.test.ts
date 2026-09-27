// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `?raw`, not `node:fs` + `import.meta.url`: under jsdom that URL is not a
// `file:` URL, so `fileURLToPath` throws before a single test runs.
import caps from '../../../src-tauri/capabilities/default.json?raw';

vi.mock('@tauri-apps/api/window', () => {
  class LogicalSize {
    constructor(
      public width: number,
      public height: number
    ) {}
  }
  class LogicalPosition {
    constructor(
      public x: number,
      public y: number
    ) {}
  }
  const size = (w: number, h: number) => ({
    width: w,
    height: h,
    toLogical: (s: number) => ({ width: w / s, height: h / s }),
  });
  const pos = (x: number, y: number) => ({ x, y, toLogical: (s: number) => ({ x: x / s, y: y / s }) });
  const win = {
    isFullscreen: vi.fn(async () => false),
    scaleFactor: vi.fn(async () => 2),
    innerSize: vi.fn(async () => size(1120, 1400)),
    outerSize: vi.fn(async () => size(1120, 1456)),
    outerPosition: vi.fn(async () => pos(200, 100)),
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
  };
  return {
    LogicalSize,
    LogicalPosition,
    getCurrentWindow: () => win,
    currentMonitor: vi.fn(async () => ({ scaleFactor: 2, workArea: { position: pos(0, 50), size: size(2880, 1700) } })),
    __win: win,
    __size: size,
    __pos: pos,
  };
});

import * as tauriWindow from '@tauri-apps/api/window';
import { restoreWindow, widenForStash } from './window-widen';

type Method = 'isFullscreen' | 'scaleFactor' | 'innerSize' | 'outerSize' | 'outerPosition' | 'setSize' | 'setPosition';
interface Fake {
  __win: Record<Method, ReturnType<typeof vi.fn>>;
  __size: (w: number, h: number) => unknown;
  __pos: (x: number, y: number) => unknown;
}
const fake = tauriWindow as unknown as Fake;
const w = fake.__win;
const globals = window as unknown as Record<string, unknown>;

beforeEach(() => {
  globals.__TAURI_INTERNALS__ = {};
  for (const fn of Object.values(w)) fn.mockClear();
});
afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
});

describe('widenForStash', () => {
  it('a 560 px window grows to 680 in place', async () => {
    const memo = await widenForStash(560);
    expect(w.setPosition).not.toHaveBeenCalled();
    expect(w.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 680, height: 700 }));
    expect(memo).toEqual({
      before: { width: 560, height: 700, x: 100, y: 50 },
      widened: { width: 680, height: 700 },
      at: null,
    });
  });

  it('at the right edge it moves left first', async () => {
    w.outerPosition.mockResolvedValueOnce(fake.__pos(2400, 100));
    const memo = await widenForStash(560);
    expect(w.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 760, y: 50 }));
    expect(w.setPosition.mock.invocationCallOrder[0]).toBeLessThan(w.setSize.mock.invocationCallOrder[0]);
    expect(memo?.at).toEqual({ x: 760, y: 50 });
  });

  it('leaves a fullscreen window, a wide one, and the browser alone', async () => {
    w.isFullscreen.mockResolvedValueOnce(true);
    expect(await widenForStash(560)).toBeNull();
    expect(await widenForStash(700)).toBeNull();
    delete globals.__TAURI_INTERNALS__;
    expect(await widenForStash(560)).toBeNull();
    expect(w.setSize).not.toHaveBeenCalled();
  });
});

describe('restoreWindow', () => {
  const memo = {
    before: { width: 560, height: 700, x: 1100, y: 50 },
    widened: { width: 680, height: 700 },
    at: { x: 760, y: 50 },
  };

  it('puts size and place back while the window is still as widened', async () => {
    w.innerSize.mockResolvedValueOnce(fake.__size(1360, 1400));
    w.outerPosition.mockResolvedValueOnce(fake.__pos(1520, 100));
    await restoreWindow(memo);
    expect(w.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 560, height: 700 }));
    expect(w.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 1100, y: 50 }));
  });

  it('keeps a resize the human made meanwhile', async () => {
    w.innerSize.mockResolvedValueOnce(fake.__size(1500, 1400));
    await restoreWindow(memo);
    expect(w.setSize).not.toHaveBeenCalled();
  });

  it('keeps the place if the human moved the window', async () => {
    w.innerSize.mockResolvedValueOnce(fake.__size(1360, 1400));
    w.outerPosition.mockResolvedValueOnce(fake.__pos(300, 300));
    await restoreWindow(memo);
    expect(w.setSize).toHaveBeenCalled();
    expect(w.setPosition).not.toHaveBeenCalled();
  });
});

describe('capabilities', () => {
  it('grant the two setters — without them the IPC is rejected silently', () => {
    const permissions = (JSON.parse(caps) as { permissions: string[] }).permissions;
    expect(permissions).toContain('core:window:allow-set-size');
    expect(permissions).toContain('core:window:allow-set-position');
  });
});
