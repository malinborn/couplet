import { describe, it, expect } from 'vitest';
import { dropBefore, moveIds, pastThreshold, sweptIds, translateXOf } from './drawer-geometry';

const boxes = [
  { id: 'a', top: 0, bottom: 40 },
  { id: 'b', top: 47, bottom: 87 },
  { id: 'c', top: 94, bottom: 134 },
];

describe('sweptIds', () => {
  it('IsEveryCardTheSpanCrosses_InEitherDirection', () => {
    expect(sweptIds(boxes, 20, 20)).toEqual(['a']);
    expect(sweptIds(boxes, 20, 100)).toEqual(['a', 'b', 'c']);
    expect(sweptIds(boxes, 100, 50)).toEqual(['b', 'c']);
    expect(sweptIds(boxes, 42, 45)).toEqual([]);
  });
});

describe('dropBefore', () => {
  it('IsTheFirstCardWhoseMiddleIsBelowThePointer', () => {
    expect(dropBefore(boxes, 10, new Set())).toBe('a');
    expect(dropBefore(boxes, 30, new Set())).toBe('b');
    expect(dropBefore(boxes, 200, new Set())).toBeNull();
  });

  it('SkipsTheCardsBeingDragged', () => {
    expect(dropBefore(boxes, 10, new Set(['a']))).toBe('b');
  });
});

describe('moveIds', () => {
  it('MovesTheBlockBeforeTheTarget_KeepingItsOrder', () => {
    expect(moveIds(['a', 'b', 'c', 'd'], ['c', 'a'], 'd')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('MovesToTheEndWithoutATarget', () => {
    expect(moveIds(['a', 'b', 'c', 'd'], ['a', 'c'], null)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('pastThreshold', () => {
  it('IsMoreThanFivePixels', () => {
    expect(pastThreshold(3, 4)).toBe(false);
    expect(pastThreshold(4, 4)).toBe(true);
  });
});

describe('translateXOf', () => {
  it('reads the x shift of a computed transform, 2D or 3D', () => {
    expect(translateXOf('matrix(1, 0, 0, 1, -420, 0)')).toBe(-420);
    expect(translateXOf('matrix(1, 0, 0, 1, 137.5, 4)')).toBe(137.5);
    expect(translateXOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 408, 0, 0, 1)')).toBe(408);
  });

  it('is 0 for no transform or one it cannot read', () => {
    expect(translateXOf('none')).toBe(0);
    expect(translateXOf('')).toBe(0);
    expect(translateXOf('translateX(-100%)')).toBe(0);
    expect(translateXOf('matrix(1, 0, 0, 1, x, 0)')).toBe(0);
  });
});
