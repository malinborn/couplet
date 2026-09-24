import { describe, it, expect } from 'vitest';
import { decideSwitchAction, type SwitchDecisionInput } from './switch-document';

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
