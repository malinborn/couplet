import { describe, it, expect } from 'vitest';
import {
  decideLeave,
  decideOpenAction,
  type OpenDecisionInput,
} from './switch-document';

describe('decideLeave', () => {
  const clean = { activePath: '/a.md', activeIsDirty: false, saveErrorPending: false };

  it('LetsACleanFileTabGo', () => {
    expect(decideLeave(clean)).toEqual({ kind: 'ok' });
  });

  it('RefusesWhileASaveErrorStands', () => {
    expect(decideLeave({ ...clean, saveErrorPending: true })).toEqual({ kind: 'refuse-save-error' });
  });

  it('RefusesAFileTabWhoseSaveHasNotLanded', () => {
    expect(decideLeave({ ...clean, activeIsDirty: true })).toEqual({ kind: 'refuse-unsaved' });
  });

  it('LetsADirtyUntitledTabGoToTheBackground', () => {
    // Its text stays in the tab and in its session sidecar; nothing is lost.
    expect(decideLeave({ ...clean, activePath: null, activeIsDirty: true })).toEqual({ kind: 'ok' });
  });
});

describe('decideOpenAction', () => {
  const base: OpenDecisionInput = {
    targetPath: '/b.md',
    activeTabId: 't-a',
    activePath: '/a.md',
    activeIsDirty: false,
    activeIsEmptyUntitled: false,
    saveErrorPending: false,
    owner: { kind: 'none' },
  };

  it('NoopWhenTheTargetIsTheActiveTab', () => {
    expect(decideOpenAction({ ...base, owner: { kind: 'this-window', tabId: 't-a' } })).toEqual({
      kind: 'noop',
    });
  });

  it('NoopWinsEvenOverASaveError', () => {
    expect(
      decideOpenAction({ ...base, saveErrorPending: true, owner: { kind: 'this-window', tabId: 't-a' } })
    ).toEqual({ kind: 'noop' });
  });

  it('RefusesEverythingElseWhileASaveErrorStands', () => {
    expect(decideOpenAction({ ...base, saveErrorPending: true, owner: { kind: 'other-window' } })).toEqual({
      kind: 'refuse-save-error',
    });
  });

  it('FocusesTheOtherWindowEvenWhenTheActiveTabIsUnsaved', () => {
    // Nothing here is left behind, so nothing needs to be saved first.
    expect(decideOpenAction({ ...base, activeIsDirty: true, owner: { kind: 'other-window' } })).toEqual({
      kind: 'focus-other-window',
    });
  });

  it('RefusesToLeaveAnUnsavedFileTab', () => {
    expect(decideOpenAction({ ...base, activeIsDirty: true })).toEqual({ kind: 'refuse-unsaved' });
    expect(
      decideOpenAction({ ...base, activeIsDirty: true, owner: { kind: 'this-window', tabId: 't-b' } })
    ).toEqual({ kind: 'refuse-unsaved' });
  });

  it('ActivatesTheBackgroundTabThatAlreadyHoldsTheFile', () => {
    expect(decideOpenAction({ ...base, owner: { kind: 'this-window', tabId: 't-b' } })).toEqual({
      kind: 'activate-tab',
      tabId: 't-b',
    });
  });

  it('ReplacesAnEmptyUntitledActiveTab', () => {
    expect(
      decideOpenAction({ ...base, activePath: null, activeIsEmptyUntitled: true })
    ).toEqual({ kind: 'replace-active' });
  });

  it('OpensANewTabOtherwise', () => {
    expect(decideOpenAction(base)).toEqual({ kind: 'open-new-tab' });
    expect(decideOpenAction({ ...base, activePath: null, activeIsDirty: true })).toEqual({
      kind: 'open-new-tab',
    });
  });
});
