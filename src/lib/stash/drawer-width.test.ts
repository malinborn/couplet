import { describe, expect, it } from 'vitest';
import {
  DRAWER_GAP,
  MIN_BOTH,
  NARROW_AT,
  drawerLayout,
  needsWiden,
  pageBand,
  planWiden,
  stillWidened,
} from './drawer-width';

describe('drawerLayout', () => {
  it('uses the normal widths in a wide window, stash open or not', () => {
    expect(drawerLayout(1180, false)).toEqual({ tabs: 420, stash: 400, narrow: false });
    expect(drawerLayout(1180, true)).toEqual({ tabs: 420, stash: 400, narrow: false });
  });

  it('keeps the fractions at the narrow threshold', () => {
    const l = drawerLayout(NARROW_AT, true);
    expect(l.narrow).toBe(false);
    expect(l.tabs).toBe(420);
    expect(l.stash).toBeCloseTo(345.6, 5);
  });

  it('squeezes both to (width − 40) / 2 below 960 while the stash is open', () => {
    expect(drawerLayout(900, true)).toEqual({ tabs: 420, stash: 400, narrow: true });
    expect(drawerLayout(720, true)).toEqual({ tabs: 340, stash: 340, narrow: true });
    expect(drawerLayout(MIN_BOTH, true)).toEqual({ tabs: 320, stash: 320, narrow: true });
  });

  it('with the stash closed a narrow window keeps the tabs fraction', () => {
    expect(drawerLayout(800, false)).toEqual({ tabs: 416, stash: 288, narrow: true });
  });

  it('never lets the two drawers overlap', () => {
    for (let vw = 300; vw <= 2000; vw += 7) {
      const l = drawerLayout(vw, true);
      expect(l.tabs + l.stash + (l.narrow ? DRAWER_GAP : 0), `vw ${vw}`).toBeLessThanOrEqual(vw + 1e-9);
    }
  });
});

describe('needsWiden', () => {
  it('is true only below 680 px', () => {
    expect(MIN_BOTH).toBe(680);
    expect(needsWiden(679)).toBe(true);
    expect(needsWiden(680)).toBe(false);
    expect(needsWiden(0)).toBe(false);
  });
});

describe('pageBand', () => {
  it('is the page right of the tabs drawer, or between the drawers', () => {
    expect(pageBand(420, null, 1180, false)).toEqual({ left: 420, right: 1180 });
    expect(pageBand(420, 780, 1180, false)).toEqual({ left: 420, right: 780 });
  });

  it('is gone between squeezed drawers and when under 60 px', () => {
    expect(pageBand(340, 380, 720, true)).toBeNull();
    expect(pageBand(420, 470, 1000, false)).toBeNull();
  });
});

describe('planWiden', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };

  it('grows the inner width to 680 and stays put when it fits', () => {
    expect(
      planWiden({ viewport: 560, inner: { width: 560, height: 700 }, outer: { x: 100, y: 50, width: 560, height: 728 }, workArea })
    ).toEqual({ inner: { width: 680, height: 700 }, position: null });
  });

  it('moves left when the right edge would cross the work area', () => {
    expect(
      planWiden({ viewport: 560, inner: { width: 560, height: 700 }, outer: { x: 900, y: 50, width: 560, height: 728 }, workArea })
    ).toEqual({ inner: { width: 680, height: 700 }, position: { x: 760, y: 50 } });
  });

  it('counts the page zoom: 680 CSS px at 125 % is 850 logical px', () => {
    expect(
      planWiden({ viewport: 480, inner: { width: 600, height: 700 }, outer: { x: 0, y: 50, width: 600, height: 728 }, workArea })
    ).toEqual({ inner: { width: 850, height: 700 }, position: null });
  });

  it('never grows past the work area', () => {
    const small = { x: 0, y: 25, width: 640, height: 875 };
    expect(
      planWiden({ viewport: 560, inner: { width: 560, height: 700 }, outer: { x: 40, y: 50, width: 560, height: 728 }, workArea: small })
    ).toEqual({ inner: { width: 640, height: 700 }, position: { x: 0, y: 50 } });
  });

  it('does nothing for a window already wide enough', () => {
    expect(
      planWiden({ viewport: 700, inner: { width: 700, height: 700 }, outer: { x: 0, y: 50, width: 700, height: 728 }, workArea })
    ).toBeNull();
  });
});

describe('stillWidened', () => {
  it('allows a pixel of rounding, not a resize', () => {
    expect(stillWidened({ width: 680.5, height: 700 }, { width: 680, height: 700 })).toBe(true);
    expect(stillWidened({ width: 700, height: 700 }, { width: 680, height: 700 })).toBe(false);
  });
});
