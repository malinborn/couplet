import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoSaveScheduler } from './autosave';

describe('createAutoSaveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces: multiple schedule() calls within the delay produce one save', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => true, save });

    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    vi.advanceTimersByTime(300);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not save when the timer fires but shouldSave() is now false', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let dirty = true;
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => dirty, save });

    scheduler.schedule();
    dirty = false;
    vi.advanceTimersByTime(300);

    expect(save).not.toHaveBeenCalled();
  });

  it('flush() cancels the pending timer and saves immediately when dirty', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => true, save });

    scheduler.schedule();
    await scheduler.flush();
    vi.advanceTimersByTime(300);

    expect(save).toHaveBeenCalledTimes(1); // not called again when the (now cancelled) timer would have fired
  });

  it('flush() is a no-op when nothing is dirty', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => false, save });

    await scheduler.flush();

    expect(save).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending timer without saving', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => true, save });

    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(300);

    expect(save).not.toHaveBeenCalled();
  });
});
