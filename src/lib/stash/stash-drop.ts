/**
 * Rust asks this window to drop a stash note's tab before the note moves to
 * the trash (`stash-drop-tab`, stash stage 06). The controller leaves the tab
 * the normal way (`tabs.dropPath`: flush, refuse if the save did not land,
 * release); Rust waits for the answer (`stash_drop_done`) and moves the file
 * only after `dropped: true`. Every request Rust still waits for is answered —
 * a missing answer would make Rust wait out its 10 s timeout and report `kept`.
 *
 * The one exception (review M1): a tab queue busy past that timeout finds the
 * delete already answered `kept: timeout`. The drop asks Rust
 * (`stash_drop_pending`) in its queue slot, right before it would leave the
 * tab, and keeps the tab when the request is gone — a late drop would make the
 * tab vanish for a delete that never happened.
 */
import type { DropResult } from '../tabs/controller';

export interface StashDropDeps {
  /**
   * `'dropped'`: no tab in this window holds `path` any more. `stillWanted`
   * runs in the drop's queue slot, before anything is left; `'unwanted'` when
   * it said no. `undefined` is the serial queue's answer for a task that
   * threw — not dropped.
   */
  dropPath(path: string, stillWanted: () => Promise<boolean>): Promise<DropResult | undefined>;
  /** `stash_drop_pending`: whether Rust still waits for this request. */
  pending(requestId: number): Promise<boolean>;
  done(requestId: number, dropped: boolean): Promise<void>;
}

export interface StashDropRequest {
  requestId: number;
  /** The registry's spelling — the same as this window's tabs. */
  path: string;
}

export async function handleStashDropTab(deps: StashDropDeps, request: StashDropRequest): Promise<void> {
  // What the pending check said: `gone` means Rust has answered already.
  let asked: 'wanted' | 'gone' | 'failed' | null = null;
  const stillWanted = async (): Promise<boolean> => {
    try {
      const wanted = await deps.pending(request.requestId);
      asked = wanted ? 'wanted' : 'gone';
      return wanted;
    } catch (err) {
      // Not knowing is not a yes: keep the tab, and say so if Rust still listens.
      console.error('stash-drop-tab: the pending check failed', err);
      asked = 'failed';
      return false;
    }
  };
  let result: DropResult | undefined;
  try {
    result = await deps.dropPath(request.path, stillWanted);
  } catch (err) {
    console.error('stash-drop-tab: the drop failed', err);
  }
  if (result === 'unwanted' && asked === 'gone') return;
  try {
    await deps.done(request.requestId, result === 'dropped');
  } catch (err) {
    // Rust times out on its own and reports `kept`; nothing to undo here.
    console.error('stash-drop-tab: the answer failed', err);
  }
}
