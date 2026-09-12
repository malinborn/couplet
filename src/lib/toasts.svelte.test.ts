import { describe, it, expect } from 'vitest';
import { createToastStore } from './toasts.svelte';

describe('createToastStore', () => {
  it('StartsEmpty', () => {
    expect(createToastStore().toasts).toEqual([]);
  });

  it('Push_AddsToast', () => {
    const store = createToastStore();
    store.push({ kind: 'session', count: 3 });
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].payload).toEqual({ kind: 'session', count: 3 });
  });

  it('Push_ReturnsUniqueIds', () => {
    const store = createToastStore();
    const a = store.push({ kind: 'session', count: 1 });
    const b = store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    expect(a).not.toBe(b);
  });

  it('Dismiss_RemovesById', () => {
    const store = createToastStore();
    const id = store.push({ kind: 'session', count: 2 });
    store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    store.dismiss(id);
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].payload.kind).toBe('update');
  });

  it('Dismiss_UnknownId_NoOp', () => {
    const store = createToastStore();
    store.push({ kind: 'session', count: 2 });
    store.dismiss(9999);
    expect(store.toasts).toHaveLength(1);
  });

  it('DismissKind_RemovesEveryToastOfThatKind', () => {
    const store = createToastStore();
    store.push({ kind: 'session', count: 2 });
    store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    store.dismissKind('session');
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0].payload.kind).toBe('update');
  });

  it('UpdateSortsAboveSession_RegardlessOfPushOrder', () => {
    // The update check fires 15s after launch, so insertion order would put it
    // below the session toast. Order must be explicit.
    const store = createToastStore();
    store.push({ kind: 'session', count: 4 });
    store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    expect(store.toasts.map((t) => t.payload.kind)).toEqual(['update', 'session']);
  });

  it('AiNoticesSortBelowUpdateAndSession', () => {
    // Neither AI notice is time-sensitive the way a pending update or a
    // restorable session is, so they take the bottom of the stack.
    const store = createToastStore();
    store.push({ kind: 'ai-nudge' });
    store.push({ kind: 'session', count: 2 });
    store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    expect(store.toasts.map((t) => t.payload.kind)).toEqual([
      'update',
      'session',
      'ai-nudge',
    ]);
  });

  it('AiNudge_DismissedById', () => {
    const store = createToastStore();
    const id = store.push({ kind: 'ai-nudge' });
    store.dismiss(id);
    expect(store.toasts).toEqual([]);
  });

  it('AiFirstUse_IsItsOwnKind_AndDoesNotReplaceTheNudge', () => {
    // They never legitimately coexist — one needs a never-connected install,
    // the other needs a just-connected one — but they are distinct kinds, so
    // per-kind replacement must not silently swallow one for the other.
    const store = createToastStore();
    store.push({ kind: 'ai-nudge' });
    store.push({ kind: 'ai-first-use' });
    expect(store.toasts).toHaveLength(2);
  });

  it('SaveErrorSortsAboveEverything', () => {
    // It is the only toast that means work is being lost right now, so no
    // notice about an update or a restorable session may sit above it.
    const store = createToastStore();
    store.push({ kind: 'ai-nudge' });
    store.push({ kind: 'session', count: 2 });
    store.push({ kind: 'save-error', fileName: 'notes.md', message: 'Permission denied' });
    store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    expect(store.toasts.map((t) => t.payload.kind)).toEqual([
      'save-error',
      'update',
      'session',
      'ai-nudge',
    ]);
  });

  it('SaveError_RepeatedFailures_DoNotStack', () => {
    // Autosave retries every 300ms, so a file the filesystem keeps refusing
    // would otherwise bury the window in identical cards. The latest message
    // wins — it is the one describing the current state of the disk.
    const store = createToastStore();
    store.push({ kind: 'save-error', fileName: 'notes.md', message: 'Permission denied' });
    store.push({ kind: 'save-error', fileName: 'notes.md', message: 'No space left on device' });
    expect(store.toasts).toHaveLength(1);
    const payload = store.toasts[0].payload;
    expect(payload.kind === 'save-error' && payload.message).toBe('No space left on device');
  });

  it('SaveError_WithdrawnWhenASaveFinallyLands', () => {
    // `performSave` calls `dismissKind` on success: the warning has to leave on
    // its own, because a stale "could not save" is as misleading as no warning.
    const store = createToastStore();
    store.push({ kind: 'save-error', fileName: 'notes.md', message: 'Permission denied' });
    store.dismissKind('save-error');
    expect(store.toasts).toEqual([]);
  });

  it('OnlyOneToastPerKind', () => {
    // The update checker runs hourly and must not stack duplicates.
    const store = createToastStore();
    store.push({ kind: 'update', latest: 'v1.0.0', current: '0.9.0' });
    store.push({ kind: 'update', latest: 'v1.1.0', current: '0.9.0' });
    expect(store.toasts).toHaveLength(1);
    const payload = store.toasts[0].payload;
    expect(payload.kind === 'update' && payload.latest).toBe('v1.1.0');
  });
});
