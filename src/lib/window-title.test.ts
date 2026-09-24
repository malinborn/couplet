import { describe, it, expect } from 'vitest';
import { windowTitle } from './window-title';

describe('windowTitle', () => {
  it('ShowsTheWindowNumberInsteadOfTheProduct', () => {
    expect(windowTitle({ name: 'README.md', dirty: false, number: 7, product: 'md-mini' })).toBe(
      'README.md — #7'
    );
  });

  it('MarksAnUnsavedBufferWithADot', () => {
    expect(windowTitle({ name: 'README.md', dirty: true, number: 7, product: 'md-mini' })).toBe(
      '● README.md — #7'
    );
  });

  it('KeepsTheDevBuildRecognisable', () => {
    // The titlebar is the one place a human tells the dev build from the
    // installed release; the number alone would erase that.
    expect(windowTitle({ name: 'a.md', dirty: false, number: 3, product: 'md-mini-dev' })).toBe(
      'a.md — #3 · md-mini-dev'
    );
  });

  it('FallsBackToTheProductNameWithoutANumber', () => {
    expect(windowTitle({ name: 'a.md', dirty: false, number: null, product: 'md-mini' })).toBe(
      'a.md — md-mini'
    );
  });
});
