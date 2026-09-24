import { describe, it, expect } from 'vitest';
import {
  EDGE_SPEED_PX,
  REDUCED_STEP_MS,
  carouselItems,
  carouselKey,
  clampOffset,
  edgeVelocity,
  glide,
  initialKb,
  moveKbIndex,
  reducedStep,
  revealOffset,
  targetOf,
  thumbScale,
  thumbWidth,
  wantsCarousel,
  type CarouselWindow,
} from './carousel';

const win = (label: string, number: number): CarouselWindow => ({
  label,
  number,
  project: 'p',
  branch: null,
  tabCount: 1,
  activePath: `/p/${label}.md`,
  head: '',
});

const key = (k: string, mods: Partial<KeyboardEventInit & { keyCode: number }> = {}) => ({
  key: k,
  code: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('carousel items', () => {
  it('NewWindowComesFirst_ThenTheWindowsInTheOrderRustSent', () => {
    const items = carouselItems([win('editor-3', 12), win('editor-2', 7)]);
    expect(items.map((i) => (i.kind === 'new' ? 'new' : i.label))).toEqual(['new', 'editor-3', 'editor-2']);
  });

  it('AnItemNamesWhereTheTabsGo', () => {
    const [fresh, other] = carouselItems([win('editor-3', 12)]);
    expect(targetOf(fresh)).toEqual({ kind: 'new-window' });
    expect(targetOf(other)).toEqual({ kind: 'window', label: 'editor-3' });
  });

  it('TheKeyboardStartsOnTheLastFocusedWindow_OrOnNewWindowWhenThereIsNone', () => {
    expect(initialKb(carouselItems([win('editor-3', 12)]))).toBe(1);
    expect(initialKb(carouselItems([]))).toBe(0);
  });

  it('ArrowsStopAtTheEnds', () => {
    expect(moveKbIndex(0, -1, 3)).toBe(0);
    expect(moveKbIndex(1, 1, 3)).toBe(2);
    expect(moveKbIndex(2, 1, 3)).toBe(2);
    expect(moveKbIndex(0, 1, 0)).toBe(0);
  });
});

describe('carousel geometry', () => {
  it('AThumbnailFillsTheCarouselLessAGutter_Within190To320', () => {
    expect(thumbWidth(100)).toBe(190);
    expect(thumbWidth(300)).toBe(236);
    expect(thumbWidth(1000)).toBe(320);
  });

  it('TheEdgeZonesAreTheTopAndBottom22Percent', () => {
    expect(edgeVelocity(500, 0, 1000)).toBe(0);
    expect(edgeVelocity(0, 0, 1000)).toBe(-1);
    expect(edgeVelocity(1000, 0, 1000)).toBe(1);
    expect(edgeVelocity(110, 0, 1000)).toBeCloseTo(-0.5);
    expect(edgeVelocity(-50, 0, 1000)).toBe(-1);
  });

  it('TheGlideIsSlowNearTheZoneAndStopsAtTheEnds', () => {
    expect(glide(100, 0.5, 1000)).toBe(100 + 0.25 * EDGE_SPEED_PX);
    expect(glide(100, -1, 1000)).toBe(100 - EDGE_SPEED_PX);
    expect(glide(5, -1, 1000)).toBe(0);
    expect(glide(995, 1, 1000)).toBe(1000);
    expect(clampOffset(50, -10)).toBe(0);
  });

  it('WithReducedMotionTheEdgeStepsHalfAViewAtATime', () => {
    expect(reducedStep(0, 1, 1000, 400, 0, REDUCED_STEP_MS)).toEqual({ offset: 200, lastStepAt: REDUCED_STEP_MS });
    expect(reducedStep(200, 1, 1000, 400, 1000, 1000 + REDUCED_STEP_MS - 1)).toEqual({ offset: 200, lastStepAt: 1000 });
    expect(reducedStep(200, 0, 1000, 400, 0, 5000)).toEqual({ offset: 200, lastStepAt: 0 });
  });

  it('ThumbnailsShrinkTo88PercentAwayFromTheMiddle', () => {
    expect(thumbScale(500, 500, 400)).toBe(1);
    expect(thumbScale(900, 500, 400)).toBeCloseTo(0.88);
    expect(thumbScale(2000, 500, 400)).toBeCloseTo(0.88);
  });

  it('RevealScrollsOnlyAsFarAsNeeded', () => {
    expect(revealOffset(300, 100, 200, 400, 1000)).toBe(72);
    expect(revealOffset(0, 500, 600, 400, 1000)).toBe(228);
    expect(revealOffset(100, 150, 250, 400, 1000)).toBe(100);
  });

  it('IsUpOnlyOverThePageRightOfTheDrawer', () => {
    expect(wantsCarousel(500, 300, 420, 1000, 700)).toBe(true);
    expect(wantsCarousel(410, 300, 420, 1000, 700)).toBe(false);
    expect(wantsCarousel(500, 800, 420, 1000, 700)).toBe(false);
    expect(wantsCarousel(1000, 300, 420, 1000, 700)).toBe(false);
  });
});

describe('carousel keys', () => {
  it('ArrowsEnterAndEscape', () => {
    expect(carouselKey(key('ArrowUp'))).toBe('up');
    expect(carouselKey(key('ArrowDown'))).toBe('down');
    expect(carouselKey(key('Enter'))).toBe('choose');
    expect(carouselKey(key('Escape'))).toBe('cancel');
    expect(carouselKey(key('a'))).toBe('none');
  });

  it('NothingWithACommandKeyOrWhileTheImeComposes', () => {
    expect(carouselKey(key('Enter', { metaKey: true }))).toBe('none');
    expect(carouselKey(key('ArrowDown', { ctrlKey: true }))).toBe('none');
    expect(carouselKey(key('Enter', { isComposing: true }))).toBe('none');
    expect(carouselKey(key('Process', { keyCode: 229 }))).toBe('none');
  });
});
