/**
 * Debounced autosave, extracted so a tab switch (`lib/tabs/controller.ts`) can `flush()` it
 * synchronously before replacing the document — otherwise the last ≤300ms of
 * typing before a Cmd+O / Recent Files switch is silently dropped (the
 * pending `setTimeout` was still holding it, unfired, when the document
 * underneath it changed). See docs/investigations/2026-09-23-tabs-options.md §1.
 */
export interface AutoSaveScheduler {
  /** Debounce: (re)start the delay. Call on every document change. */
  schedule(): void;
  /** Cancel any pending timer and save now, if there is something to save. */
  flush(): Promise<void>;
  /** Cancel any pending timer without saving. */
  cancel(): void;
}

export interface AutoSaveSchedulerOptions {
  delayMs: number;
  /** Whether a save is actually warranted right now (dirty + has a path). */
  shouldSave: () => boolean;
  save: () => Promise<void>;
}

export function createAutoSaveScheduler(opts: AutoSaveSchedulerOptions): AutoSaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (opts.shouldSave()) {
        void opts.save();
      }
    }, opts.delayMs);
  }

  async function flush(): Promise<void> {
    cancel();
    if (opts.shouldSave()) {
      await opts.save();
    }
  }

  return { schedule, flush, cancel };
}
