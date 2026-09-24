import { describe, it, expect } from 'vitest';
import { decideSaveAs } from './save-as';

describe('decideSaveAs', () => {
  it('WritesOnlyAfterTheTabClaimedThePath', () => {
    expect(decideSaveAs({ kind: 'claimed' })).toEqual({ kind: 'write' });
  });

  it('WritesNothingOverAPathAnotherTabOfThisWindowHolds', () => {
    expect(decideSaveAs({ kind: 'this-window', tabId: 'b' })).toEqual({
      kind: 'blocked',
      reason: 'held',
      focusOtherWindow: false,
    });
  });

  it('WritesNothingOverAPathAnotherWindowHolds_AndBringsThatWindowForward', () => {
    expect(decideSaveAs({ kind: 'other-window', label: 'editor-2' })).toEqual({
      kind: 'blocked',
      reason: 'held',
      focusOtherWindow: true,
    });
  });

  it('WritesNothingWhenTheClaimWasRefusedOrCouldNotBeAsked', () => {
    const blocked = { kind: 'blocked', reason: 'unavailable', focusOtherWindow: false };
    expect(decideSaveAs({ kind: 'refused' })).toEqual(blocked);
    expect(decideSaveAs(null)).toEqual(blocked);
  });
});
