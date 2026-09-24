import { describe, it, expect } from 'vitest';
import { windowTitle } from './window-title';

describe('windowTitle', () => {
  it('ShowsTheWindowNumberInsteadOfTheProduct', () => {
    expect(windowTitle({ name: 'README.md', dirty: false, number: 7, product: 'couplet' })).toBe(
      'README.md — #7'
    );
  });

  it('MarksAnUnsavedBufferWithADot', () => {
    expect(windowTitle({ name: 'README.md', dirty: true, number: 7, product: 'couplet' })).toBe(
      '● README.md — #7'
    );
  });

  it('KeepsTheDevBuildRecognisable', () => {
    // The titlebar is the one place a human tells the dev build from the
    // installed release; the number alone would erase that.
    expect(windowTitle({ name: 'a.md', dirty: false, number: 3, product: 'couplet-dev' })).toBe(
      'a.md — #3 · couplet-dev'
    );
  });

  it('FallsBackToTheProductNameWithoutANumber', () => {
    expect(windowTitle({ name: 'a.md', dirty: false, number: null, product: 'couplet' })).toBe(
      'a.md — couplet'
    );
  });
});
