/**
 * Stash stage 04 (spec «Уже 680px», D15): while the stash is open a window too
 * narrow for both drawers widens itself — moving left first at the work
 * area's right edge — and goes back when the stash closes. Fullscreen (Split
 * View is a fullscreen space) is left alone. The numbers are `planWiden`'s;
 * this file only reads and moves the window. In the browser (`npm run dev`,
 * no Tauri) it does nothing.
 *
 * The getters answer PHYSICAL pixels, the setters here are given LOGICAL ones
 * (CLAUDE.md, window geometry) — every reading goes through `toLogical` with
 * its own scale factor: the window's for the window, the monitor's for the
 * work area. Page zoom (`window-zoom.ts`) is not read here: `planWiden` gets
 * it from logical inner width ÷ CSS `innerWidth`.
 *
 * Needs `core:window:allow-set-size` and `core:window:allow-set-position` in
 * `capabilities/default.json` (the getters and `currentMonitor` are in
 * `core:window:default`): without them the IPC is rejected and — as the zoom
 * was before it (CLAUDE.md) — the feature is silently dead. The test reads
 * the capability file.
 */
import { LogicalPosition, LogicalSize, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { planWiden, stillWidened, type Size } from './drawer-width';

export interface WidenMemo {
  /** Inner size and outer position before, logical px. */
  before: Size & { x: number; y: number };
  /** The inner size it was widened to: put back only while it still is. */
  widened: Size;
  /** Where it was moved to, or `null` if it was not moved. */
  at: { x: number; y: number } | null;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function near(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

export async function widenForStash(viewport: number = window.innerWidth): Promise<WidenMemo | null> {
  if (!inTauri()) return null;
  try {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) return null;
    const [scale, innerP, outerP, posP, monitor] = await Promise.all([
      win.scaleFactor(),
      win.innerSize(),
      win.outerSize(),
      win.outerPosition(),
      currentMonitor(),
    ]);
    if (!monitor) return null;
    const inner = innerP.toLogical(scale);
    const outer = outerP.toLogical(scale);
    const pos = posP.toLogical(scale);
    const waPos = monitor.workArea.position.toLogical(monitor.scaleFactor);
    const waSize = monitor.workArea.size.toLogical(monitor.scaleFactor);
    const plan = planWiden({
      viewport,
      inner: { width: inner.width, height: inner.height },
      outer: { x: pos.x, y: pos.y, width: outer.width, height: outer.height },
      workArea: { x: waPos.x, y: waPos.y, width: waSize.width, height: waSize.height },
    });
    if (!plan) return null;
    // Move first, then grow: the frame never pokes past the screen edge.
    if (plan.position) await win.setPosition(new LogicalPosition(plan.position.x, plan.position.y));
    await win.setSize(new LogicalSize(plan.inner.width, plan.inner.height));
    // What the window server made of it, not what was asked: it clamps to the
    // screen and rounds to device pixels, and `restoreWindow` compares the
    // window against this within 1 px — the asked-for size would read as
    // "the human resized it" and the window would never go back.
    const [gotInner, gotPos] = await Promise.all([win.innerSize(), plan.position ? win.outerPosition() : null]);
    const widened = gotInner.toLogical(scale);
    const at = gotPos ? gotPos.toLogical(scale) : null;
    return {
      before: { width: inner.width, height: inner.height, x: pos.x, y: pos.y },
      widened: { width: widened.width, height: widened.height },
      at: at ? { x: at.x, y: at.y } : null,
    };
  } catch (err) {
    console.error('stash: could not widen the window', err);
    return null;
  }
}

/** Shrink first, then move back — and each only if the human did not change it meanwhile. */
export async function restoreWindow(memo: WidenMemo): Promise<void> {
  if (!inTauri()) return;
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const now = (await win.innerSize()).toLogical(scale);
    if (!stillWidened({ width: now.width, height: now.height }, memo.widened)) return;
    await win.setSize(new LogicalSize(memo.before.width, memo.before.height));
    if (memo.at === null) return;
    const pos = (await win.outerPosition()).toLogical(scale);
    if (near({ x: pos.x, y: pos.y }, memo.at)) await win.setPosition(new LogicalPosition(memo.before.x, memo.before.y));
  } catch (err) {
    console.error('stash: could not restore the window', err);
  }
}
