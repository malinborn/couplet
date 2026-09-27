import { describe, it, expect } from 'vitest';
import { decideSaveAs, savedAsReport } from './save-as';

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

describe('savedAsReport', () => {
  const landed = { path: '/work/plan.md', dirty: false };

  it('ReportsASavedFileThatLandedCleanOnItsNewPath', () => {
    expect(savedAsReport('/Users/u/couplet/n.md', '/work/plan.md', landed)).toEqual({
      oldPath: '/Users/u/couplet/n.md',
      newPath: '/work/plan.md',
    });
  });

  it('ReportsNothingForAnUntitledTab', () => {
    expect(savedAsReport(null, '/work/plan.md', landed)).toBeNull();
  });

  it('ReportsNothingWhenThePathDidNotChange', () => {
    expect(savedAsReport('/work/plan.md', '/work/plan.md', landed)).toBeNull();
  });

  it('ReportsNothingWhileTheNewFileMissesTheLastKeystrokes', () => {
    // A failed save leaves the tab dirty: the new file cannot match the note.
    expect(savedAsReport('/n.md', '/work/plan.md', { path: '/work/plan.md', dirty: true })).toBeNull();
  });

  it('ReportsNothingWhenTheTabIsNoLongerOnTheNewPath', () => {
    expect(savedAsReport('/n.md', '/work/plan.md', { path: '/elsewhere.md', dirty: false })).toBeNull();
    expect(savedAsReport('/n.md', '/work/plan.md', { path: null, dirty: false })).toBeNull();
  });
});
