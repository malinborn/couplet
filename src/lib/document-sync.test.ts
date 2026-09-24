import { describe, it, expect } from 'vitest';
import {
  canAutoSave,
  lineEndingAfterExternalChange,
  reloadRetryDelay,
  type SaveGate,
} from './document-sync';

const open: SaveGate = {
  isDirty: true,
  filePath: '/a.md',
  conflictDialogOpen: false,
  diskUnreadable: false,
};

describe('canAutoSave', () => {
  it('DirtyFileWithNothingInTheWay_Saves', () => {
    expect(canAutoSave(open)).toBe(true);
  });

  it('CleanBuffer_DoesNotSave', () => {
    expect(canAutoSave({ ...open, isDirty: false })).toBe(false);
  });

  it('Untitled_DoesNotSave', () => {
    expect(canAutoSave({ ...open, filePath: null })).toBe(false);
  });

  it('ConflictDialogOpen_Blocks', () => {
    expect(canAutoSave({ ...open, conflictDialogOpen: true })).toBe(false);
  });

  it('DiskUnreadable_Blocks', () => {
    // The unread disk version is exactly what the next keystroke would
    // otherwise overwrite without a conflict dialog.
    expect(canAutoSave({ ...open, diskUnreadable: true })).toBe(false);
  });
});

describe('lineEndingAfterExternalChange', () => {
  const base = { disk: 'a\nb\n', baseline: 'a\nb\n', diskLineEnding: 'lf' as const, current: 'crlf' as const };

  it('Reload_TakesDisksEnding', () => {
    expect(lineEndingAfterExternalChange({ ...base, decision: 'reload', baseline: 'old\n' })).toBe('lf');
  });

  it('Adopt_TakesDisksEnding', () => {
    expect(lineEndingAfterExternalChange({ ...base, decision: 'adopt', baseline: 'old\n' })).toBe('lf');
  });

  it('Ignore_BaselineMatch_FollowsAnEolOnlyConversion', () => {
    // Someone ran dos2unix on the file: text unchanged, endings changed.
    expect(lineEndingAfterExternalChange({ ...base, decision: 'ignore' })).toBe('lf');
  });

  it('Ignore_OwnSaveEcho_IsANoOp', () => {
    expect(
      lineEndingAfterExternalChange({ ...base, decision: 'ignore', diskLineEnding: 'crlf' })
    ).toBe('crlf');
  });

  it('Ignore_DeclinedDiskState_KeepsOurs', () => {
    // Disk differs from the baseline and the user already said No to it: the
    // buffer is not disk's, so neither is its ending.
    expect(
      lineEndingAfterExternalChange({ ...base, decision: 'ignore', disk: 'theirs\n' })
    ).toBe('crlf');
  });

  it('Conflict_KeepsOurs', () => {
    expect(
      lineEndingAfterExternalChange({ ...base, decision: 'conflict', disk: 'theirs\n' })
    ).toBe('crlf');
  });
});

describe('reloadRetryDelay', () => {
  it('FirstRetryWaitsOutTheWatcherDebounce', () => {
    expect(reloadRetryDelay(0)).toBeGreaterThan(500);
  });

  it('BacksOffToACeiling', () => {
    expect(reloadRetryDelay(1)).toBeGreaterThan(reloadRetryDelay(0));
    expect(reloadRetryDelay(10)).toBe(5000);
  });
});
