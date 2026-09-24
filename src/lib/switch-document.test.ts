import { describe, it, expect } from 'vitest';
import {
  decideSwitchAction,
  decideLeave,
  decideOpenAction,
  type SwitchDecisionInput,
  type OpenDecisionInput,
} from './switch-document';

const base: SwitchDecisionInput = {
  targetPath: '/docs/b.md',
  currentPath: '/docs/a.md',
  currentIsDirty: false,
  saveErrorPending: false,
  alreadyOpenElsewhere: false,
};

describe('decideSwitchAction', () => {
  it('NoopWhenTargetIsAlreadyShowing', () => {
    expect(decideSwitchAction({ ...base, targetPath: '/docs/a.md' })).toEqual({
      kind: 'noop-already-showing',
    });
  });

  it('RefusesWhenTheLastSaveFailed', () => {
    expect(decideSwitchAction({ ...base, saveErrorPending: true })).toEqual({
      kind: 'refuse-save-error',
    });
  });

  it('SaveErrorRefusalWinsOverAlreadyOpenElsewhere', () => {
    expect(
      decideSwitchAction({ ...base, saveErrorPending: true, alreadyOpenElsewhere: true })
    ).toEqual({ kind: 'refuse-save-error' });
  });

  it('FocusesOtherWindowWhenOpenElsewhere', () => {
    expect(decideSwitchAction({ ...base, alreadyOpenElsewhere: true })).toEqual({
      kind: 'focus-other-window',
    });
  });

  it('FocusOtherWindowWinsOverRefuseUnsaved', () => {
    // Focusing another window loses nothing in this one.
    expect(
      decideSwitchAction({ ...base, currentIsDirty: true, alreadyOpenElsewhere: true })
    ).toEqual({ kind: 'focus-other-window' });
  });

  it('RefusesWhenAFileBackedBufferIsStillDirtyAfterTheFlush', () => {
    expect(decideSwitchAction({ ...base, currentIsDirty: true })).toEqual({
      kind: 'refuse-unsaved',
    });
  });

  it('OpensANewWindowRatherThanDiscardingADirtyUntitledBuffer', () => {
    expect(decideSwitchAction({ ...base, currentPath: null, currentIsDirty: true })).toEqual({
      kind: 'open-new-window',
    });
  });

  it('SwitchesInPlaceWhenLeavingAnEmptyUntitledBuffer', () => {
    expect(decideSwitchAction({ ...base, currentPath: null })).toEqual({
      kind: 'switch-in-place',
    });
  });

  it('SwitchesInPlaceInTheOrdinaryCase', () => {
    expect(decideSwitchAction(base)).toEqual({ kind: 'switch-in-place' });
  });
});

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
