import { describe, it, expect } from 'vitest';
import { decideSaveAs } from './save-as';

describe('decideSaveAs', () => {
  it('WritesOnlyAfterTheTabClaimedThePath', () => {
    expect(decideSaveAs({ kind: 'claimed' }, '/tmp/a.md')).toEqual({ kind: 'write', path: '/tmp/a.md' });
  });

  it('WritesToThePathAsRustRegisteredIt', () => {
    expect(decideSaveAs({ kind: 'claimed', path: '/private/tmp/a.md' }, '/tmp/a.md')).toEqual({
      kind: 'write',
      path: '/private/tmp/a.md',
    });
  });

  it('WritesNothingOverAPathAnotherTabOfThisWindowHolds', () => {
    expect(decideSaveAs({ kind: 'this-window', tabId: 'b' }, '/a.md')).toEqual({
      kind: 'blocked',
      reason: 'held',
      focusOtherWindow: false,
    });
  });

  it('WritesNothingOverAPathAnotherWindowHolds_AndBringsThatWindowForward', () => {
    expect(decideSaveAs({ kind: 'other-window', label: 'editor-2' }, '/a.md')).toEqual({
      kind: 'blocked',
      reason: 'held',
      focusOtherWindow: true,
    });
  });

  it('WritesNothingWhenTheClaimWasRefusedOrCouldNotBeAsked', () => {
    const blocked = { kind: 'blocked', reason: 'unavailable', focusOtherWindow: false };
    expect(decideSaveAs({ kind: 'refused' }, '/a.md')).toEqual(blocked);
    expect(decideSaveAs(null, '/a.md')).toEqual(blocked);
  });
});
