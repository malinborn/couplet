import { describe, it, expect } from 'vitest';
import { clampZoom, stepZoom, ZOOM_MIN, ZOOM_MAX } from './window-zoom';

describe('clampZoom', () => {
  it('InsideRange_Unchanged', () => {
    expect(clampZoom(1.3)).toBe(1.3);
  });

  it('AboveMax_ClampedToMax', () => {
    expect(clampZoom(12)).toBe(ZOOM_MAX);
  });

  it('BelowMin_ClampedToMin', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
  });

  it('GarbageFromDisk_FallsBackToOne', () => {
    // `zoomLevel` приходит из localStorage: там может лежать что угодно,
    // включая значение, записанное прошлой версией приложения.
    expect(clampZoom('1.4')).toBe(1);
    expect(clampZoom(null)).toBe(1);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });
});

describe('stepZoom', () => {
  it('Up_AddsOneStep', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
  });

  it('Down_SubtractsOneStep', () => {
    expect(stepZoom(1, -1)).toBe(0.9);
  });

  it('NoFloatDrift_AcrossWholeRange', () => {
    // 0.7 + 0.1 === 0.7999999999999999 без округления, и такое значение затем
    // ушло бы в setZoom и в настройку.
    let level = ZOOM_MIN;
    const seen: number[] = [level];
    while (level < ZOOM_MAX) {
      level = stepZoom(level, 1);
      seen.push(level);
    }
    expect(seen).toEqual([
      0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2,
    ]);
  });

  it('AtMax_StaysAtMax', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
  });

  it('AtMin_StaysAtMin', () => {
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
});
