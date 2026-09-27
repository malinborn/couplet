/**
 * Rust asks this window to drop a stash note's tab before the note moves to
 * the trash (`stash-drop-tab`, stash stage 06). The controller leaves the tab
 * the normal way (`tabs.dropPath`: flush, refuse if the save did not land,
 * release); Rust waits for the answer (`stash_drop_done`) and moves the file
 * only after `dropped: true`. Every request is answered — a missing answer
 * would make Rust wait out its 10 s timeout and report `kept`.
 */
export interface StashDropDeps {
  /**
   * `true`: no tab in this window holds `path` any more. `undefined` is the
   * serial queue's answer for a task that threw — not dropped.
   */
  dropPath(path: string): Promise<boolean | undefined>;
  done(requestId: number, dropped: boolean): Promise<void>;
}

export interface StashDropRequest {
  requestId: number;
  /** The registry's spelling — the same as this window's tabs. */
  path: string;
}

export async function handleStashDropTab(deps: StashDropDeps, request: StashDropRequest): Promise<void> {
  let dropped = false;
  try {
    dropped = (await deps.dropPath(request.path)) === true;
  } catch (err) {
    console.error('stash-drop-tab: the drop failed', err);
  }
  try {
    await deps.done(request.requestId, dropped);
  } catch (err) {
    // Rust times out on its own and reports `kept`; nothing to undo here.
    console.error('stash-drop-tab: the answer failed', err);
  }
}
