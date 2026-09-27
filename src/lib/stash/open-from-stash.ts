/**
 * Stash → tabs (stash stage 04, D9; spec «Перенос»). `tab_request_move`
 * decides in one IPC: this window has it → show that tab; another window has
 * it → that window was asked (`tab-pull`) to move it here — the holder runs
 * its own move, with its own dirty checks — and the caller watches for the
 * arrival (`awaitPull`); nobody has it → open it here at its caret and, for a
 * drop, put it where it was dropped. `stash_touch_opened` after every success
 * («открытие» sort). The touch is fire-and-forget: a stash that cannot record
 * the time must not undo an open that happened.
 */
import type { PullAnswer, StashEntry } from './types';

/** How long a pulled tab has to arrive before the human is told it did not. */
export const PULL_WAIT_MS = 4000;
/** How often `awaitPull` looks. */
const PULL_POLL_MS = 200;

export interface OpenFromStashDeps {
  /** `requestTabMove`. */
  requestMove(path: string): Promise<PullAnswer>;
  activate(tabId: string): Promise<void>;
  /** `tabs.openPath(path, { cursor, topLine })`. */
  openPath(path: string, position: { cursor: number; topLine: number }): Promise<void>;
  /** The path is a tab here now. */
  has(path: string): boolean;
  /** Put the tab holding `path` before tab `before` (`null`: last). */
  place(path: string, before: string | null): void;
  /** `stashTouchOpened`. */
  touch(path: string): Promise<void>;
}

export type StashOpened =
  | { kind: 'activated' }
  | { kind: 'opened' }
  | { kind: 'pulled'; label: string; number: number | null }
  /** `error: null` — the open's own toast (`open-error`) already said why. */
  | { kind: 'failed'; error: string | null };

/** `before`: `undefined` — a click or Enter (after the active tab, as any open); else the drop position. */
export async function openFromStash(
  entry: StashEntry,
  before: string | null | undefined,
  deps: OpenFromStashDeps
): Promise<StashOpened> {
  let answer: PullAnswer;
  try {
    answer = await deps.requestMove(entry.path);
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  const touch = (): void => {
    deps.touch(entry.path).catch((err: unknown) => console.error('stash: touch failed', err));
  };
  if (answer.kind === 'this-window') {
    await deps.activate(answer.tabId);
    touch();
    return { kind: 'activated' };
  }
  if (answer.kind === 'requested') {
    touch();
    return { kind: 'pulled', label: answer.label, number: answer.number };
  }
  await deps.openPath(entry.path, { cursor: entry.caret, topLine: entry.topLine });
  if (!deps.has(entry.path)) return { kind: 'failed', error: null };
  if (before !== undefined) deps.place(entry.path, before);
  touch();
  return { kind: 'opened' };
}

/**
 * After a `pulled` open: `true` once the tab is here (`has()` — it came in
 * through `tabs-arrive`), `false` when `waitMs` passed without it, and the
 * caller offers «Перейти» to the holder (the `stash` toast `pull-failed`; the
 * holder's refusal, if any, is shown over there). Elapsed time is read from
 * the clock, not counted in steps: timers in a background webview may fire
 * late, which would stretch a step count well past `waitMs`.
 */
export function awaitPull(has: () => boolean, waitMs = PULL_WAIT_MS): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const look = (): void => {
      if (has()) resolve(true);
      else if (Date.now() - started >= waitMs) resolve(false);
      else setTimeout(look, PULL_POLL_MS);
    };
    setTimeout(look, PULL_POLL_MS);
  });
}
