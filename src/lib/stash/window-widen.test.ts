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
  // A window that moves and resizes as told (scale 2) — unless `clamp` says
  // what the window server made of a size, as macOS does at a screen edge.
  const at = {
    inner: { w: 1120, h: 1400 },
    pos: { x: 200, y: 100 },
    clamp: null as ((w: number, h: number) => { w: number; h: number }) | null,
  };
  const reset = () => {
    at.inner = { w: 1120, h: 1400 };
    at.pos = { x: 200, y: 100 };
    at.clamp = null;
  };
  const win = {
    isFullscreen: vi.fn(async () => false),
    scaleFactor: vi.fn(async () => 2),
    innerSize: vi.fn(async () => size(at.inner.w, at.inner.h)),
    outerSize: vi.fn(async () => size(at.inner.w, at.inner.h + 56)),
    outerPosition: vi.fn(async () => pos(at.pos.x, at.pos.y)),
    setSize: vi.fn(async (s: { width: number; height: number }) => {
      const [w, h] = [s.width * 2, s.height * 2];
      at.inner = at.clamp ? at.clamp(w, h) : { w, h };
    }),
    setPosition: vi.fn(async (p: { x: number; y: number }) => {
      at.pos = { x: p.x * 2, y: p.y * 2 };
    }),
  };
  return {
    LogicalSize,
    LogicalPosition,
    getCurrentWindow: () => win,
    currentMonitor: vi.fn(async () => ({ scaleFactor: 2, workArea: { position: pos(0, 50), size: size(2880, 1700) } })),
    __win: win,
    __at: at,
    __reset: reset,
    __size: size,
    __pos: pos,
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import * as tauriWindow from '@tauri-apps/api/window';
import { restoreWindow, widenForStash } from './window-widen';

type Method = 'isFullscreen' | 'scaleFactor' | 'innerSize' | 'outerSize' | 'outerPosition' | 'setSize' | 'setPosition';
interface Fake {
  __win: Record<Method, ReturnType<typeof vi.fn>>;
  __at: { pos: { x: number; y: number }; clamp: ((w: number, h: number) => { w: number; h: number }) | null };
  __reset: () => void;
  __size: (w: number, h: number) => unknown;
  __pos: (x: number, y: number) => unknown;
}
const fake = tauriWindow as unknown as Fake;
const w = fake.__win;
const globals = window as unknown as Record<string, unknown>;

beforeEach(() => {
  globals.__TAURI_INTERNALS__ = {};
  fake.__reset();
  for (const fn of Object.values(w)) fn.mockClear();
  vi.mocked(invoke).mockClear();
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

  it('remembers the size the window server gave, not the one asked for', async () => {
    // Clamped at the screen's bottom and rounded to an odd physical width.
    fake.__at.clamp = (width, height) => ({ w: width - 3, h: Math.min(height, 1300) });
    const memo = await widenForStash(560);
    expect(memo?.widened).toEqual({ width: 678.5, height: 650 });
  });

  it('remembers where the window ended up, not where it was sent', async () => {
    fake.__at.pos = { x: 2400, y: 100 };
    w.setPosition.mockImplementationOnce(async (p: { x: number; y: number }) => {
      // The window server kept it 10 px right of the asked-for x (760).
      fake.__at.pos = { x: (p.x + 10) * 2, y: p.y * 2 };
    });
    const memo = await widenForStash(560);
    expect(memo?.at).toEqual({ x: 770, y: 50 });
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

describe('the session keeps the size from before', () => {
  const holds = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === 'session_hold_geometry')
      .map(([, args]) => (args as { geometry: unknown }).geometry);

  it('held before the window moves, so no Resized can record 680 px', async () => {
    await widenForStash(560);
    expect(holds()).toEqual([{ width: 560, height: 700, x: 100, y: 50 }]);
    expect(vi.mocked(invoke).mock.invocationCallOrder[0]).toBeLessThan(w.setSize.mock.invocationCallOrder[0]);
  });

  it('released after the restore — also when the human resized it and it stays', async () => {
    const memo = {
      before: { width: 560, height: 700, x: 100, y: 50 },
      widened: { width: 680, height: 700 },
      at: null,
    };
    fake.__at.pos = { x: 200, y: 100 };
    w.innerSize.mockResolvedValueOnce(fake.__size(1360, 1400));
    await restoreWindow(memo);
    expect(holds()).toEqual([null]);
    expect(vi.mocked(invoke).mock.invocationCallOrder[0]).toBeGreaterThan(w.setSize.mock.invocationCallOrder[0]);
    vi.mocked(invoke).mockClear();
    w.innerSize.mockResolvedValueOnce(fake.__size(1500, 1400));
    await restoreWindow(memo);
    expect(holds()).toEqual([null]);
  });

  it('a widen that fails after the hold releases it', async () => {
    w.setSize.mockRejectedValueOnce(new Error('denied'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await widenForStash(560)).toBeNull();
    expect(holds()).toEqual([{ width: 560, height: 700, x: 100, y: 50 }, null]);
    error.mockRestore();
  });

  it('a hold the session refuses does not stop the widen', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no such command'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await widenForStash(560)).not.toBeNull();
    expect(w.setSize).toHaveBeenCalled();
    error.mockRestore();
  });

  it('nothing is held for a window that is not widened', async () => {
    expect(await widenForStash(700)).toBeNull();
    expect(holds()).toEqual([]);
  });
});

describe('capabilities', () => {
  it('grant the two setters — without them the IPC is rejected silently', () => {
    const permissions = (JSON.parse(caps) as { permissions: string[] }).permissions;
    expect(permissions).toContain('core:window:allow-set-size');
    expect(permissions).toContain('core:window:allow-set-position');
  });
});
