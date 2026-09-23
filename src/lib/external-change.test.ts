import { describe, it, expect } from 'vitest';
import { resolveExternalChange, type ExternalChangeInput } from './external-change';

function input(overrides: Partial<ExternalChangeInput>): ExternalChangeInput {
  return {
    disk: 'disk',
    buffer: 'buffer',
    baseline: 'baseline',
    dismissedDisk: null,
    ...overrides,
  };
}

describe('resolveExternalChange', () => {
  it('DiskMatchesBaseline_Ignore', () => {
    // The watcher fired on our own write (or the write, then a no-op FSEvent
    // for the same bytes) — the disk never diverged from what we last saw.
    expect(
      resolveExternalChange(input({ disk: 'same', baseline: 'same', buffer: 'edited' }))
    ).toBe('ignore');
  });

  it('DiskMatchesBufferWinsOverDismissed', () => {
    // Ordering: disk===buffer (adopt) is checked before dismissedDisk, even
    // when the exact same string was previously dismissed — adopt only
    // resyncs bookkeeping, so a stale "No" must not block it.
    expect(
      resolveExternalChange(
        input({ disk: 'shared', buffer: 'shared', dismissedDisk: 'shared', baseline: 'old' })
      )
    ).toBe('adopt');
  });

  it('DiskMatchesBuffer_Adopt', () => {
    // Disk already reads what the user sees — nothing to reload, just resync
    // the baseline (e.g. buffer was hand-edited to match a save that raced it).
    expect(
      resolveExternalChange(input({ disk: 'shared', buffer: 'shared', baseline: 'old' }))
    ).toBe('adopt');
  });

  it('DiskMatchesDismissed_Ignore', () => {
    // The user already said No to exactly this disk content — a second
    // FSEvent for the same bytes (debounce, coalesced writes) must not re-ask.
    expect(
      resolveExternalChange(
        input({ disk: 'ext', baseline: 'base', dismissedDisk: 'ext', buffer: 'mine' })
      )
    ).toBe('ignore');
  });

  it('DismissedEmptyString_StillMatchesEmptyDisk', () => {
    // An empty file the user dismissed once must be recognized again — no
    // `!== null` guard should make an empty-string dismissal inert.
    expect(
      resolveExternalChange(
        input({ disk: '', baseline: 'base', buffer: 'mine', dismissedDisk: '' })
      )
    ).toBe('ignore');
  });

  it('BufferMatchesBaseline_Reload', () => {
    // Buffer never diverged from the last known disk state — nothing of the
    // user's to lose.
    expect(
      resolveExternalChange(input({ disk: 'ext', baseline: 'old', buffer: 'old' }))
    ).toBe('reload');
  });

  it('NullBaseline_EmptyBuffer_Reload', () => {
    // Never written/read yet, buffer still empty — treated as matching a null
    // baseline, so silently adopt the disk content.
    expect(
      resolveExternalChange(input({ disk: 'x', baseline: null, buffer: '' }))
    ).toBe('reload');
  });

  it('BufferDivergesFromBaseline_Conflict', () => {
    // Disk changed under an edited buffer, and neither safe-out applies —
    // this must hold regardless of any dirty flag, since a flag can lag
    // behind the actual buffer content (e.g. cleared mid-write).
    expect(
      resolveExternalChange(input({ disk: 'ext', baseline: 'old', buffer: 'mine' }))
    ).toBe('conflict');
  });

  it('NullBaseline_NonEmptyBuffer_Conflict', () => {
    expect(
      resolveExternalChange(input({ disk: 'ext', baseline: null, buffer: 'mine' }))
    ).toBe('conflict');
  });
});
