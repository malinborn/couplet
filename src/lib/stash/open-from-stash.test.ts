import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullAnswer, StashEntry } from './types';
import type { MoveOutcome, Stranded } from '../tabs/controller';
import type { MoveTarget } from '../tabs/carousel';
import { PULL_WAIT_MS, awaitPull, handOverPulled, openFromStash, type OpenFromStashDeps } from './open-from-stash';

const entry = {
  id: 's1',
  kind: 'file',
  path: '/r/a.md',
  title: 'a.md',
  repo: 'r',
  branch: 'main',
  tags: [],
  createdAt: 0,
  modifiedAt: 0,
  stashedAt: 1,
  openedAt: null,
  deletedAt: null,
  caret: 42,
  topLine: 7,
  preview: '',
} satisfies StashEntry;

function deps(answer: PullAnswer, has = true, arrives = true) {
  return {
    wait: vi.fn(async (_has: () => boolean) => arrives),
    requestMove: vi.fn(async (_path: string): Promise<PullAnswer> => answer),
    activate: vi.fn(async (_tabId: string) => {}),
    openPath: vi.fn(async (_path: string, _position: { cursor: number; topLine: number }) => {}),
    has: vi.fn((_path: string) => has),
    place: vi.fn((_path: string, _before: string | null) => {}),
    touch: vi.fn(async (_path: string) => {}),
  } satisfies OpenFromStashDeps;
}

describe('openFromStash', () => {
  it('already a tab here: shows it', async () => {
    const d = deps({ kind: 'this-window', tabId: 't9' });
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'activated' });
    expect(d.activate).toHaveBeenCalledWith('t9');
    expect(d.openPath).not.toHaveBeenCalled();
    expect(d.touch).toHaveBeenCalledWith('/r/a.md');
  });

  it('held elsewhere: asked to move here, nothing opened here; touched once it arrived', async () => {
    const d = deps({ kind: 'requested', label: 'editor-19', number: 19 });
    d.touch.mockImplementation(async () => {
      // Not before the tab is here: a pull that never lands is not an open.
      expect(d.wait).toHaveBeenCalled();
    });
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'pulled', label: 'editor-19', number: 19 });
    expect(d.openPath).not.toHaveBeenCalled();
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.touch).toHaveBeenCalledWith('/r/a.md');
  });

  it('held elsewhere and it never came: not touched, the caller offers «Перейти»', async () => {
    const d = deps({ kind: 'requested', label: 'editor-19', number: 19 }, false, false);
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'pull-failed', label: 'editor-19', number: 19 });
    expect(d.touch).not.toHaveBeenCalled();
  });

  it('a card dropped while another window holds it lands where it was dropped once it arrives', async () => {
    const d = deps({ kind: 'requested', label: 'editor-19', number: 19 });
    await openFromStash(entry, 'tab-3', d);
    expect(d.place).toHaveBeenCalledWith('/r/a.md', 'tab-3');
    expect(d.place.mock.invocationCallOrder[0]).toBeGreaterThan(d.wait.mock.invocationCallOrder[0]);
    const click = deps({ kind: 'requested', label: 'editor-19', number: 19 });
    await openFromStash(entry, undefined, click);
    expect(click.place).not.toHaveBeenCalled();
    const lost = deps({ kind: 'requested', label: 'editor-19', number: 19 }, false, false);
    await openFromStash(entry, null, lost);
    expect(lost.place).not.toHaveBeenCalled();
  });

  it('the wait watches this window for the path', async () => {
    const d = deps({ kind: 'requested', label: 'editor-19', number: 19 });
    await openFromStash(entry, undefined, d);
    const watched = d.wait.mock.calls[0][0];
    d.has.mockClear();
    watched();
    expect(d.has).toHaveBeenCalledWith('/r/a.md');
  });

  it('free: opened at its caret, placed where it was dropped', async () => {
    const d = deps({ kind: 'not-open' });
    expect(await openFromStash(entry, 'tab-3', d)).toEqual({ kind: 'opened' });
    expect(d.requestMove).toHaveBeenCalledWith('/r/a.md');
    expect(d.openPath).toHaveBeenCalledWith('/r/a.md', { cursor: 42, topLine: 7 });
    expect(d.place).toHaveBeenCalledWith('/r/a.md', 'tab-3');
    expect(d.touch).toHaveBeenCalledWith('/r/a.md');
  });

  it('a click (no drop position) is not re-placed; a drop at the end is', async () => {
    const d = deps({ kind: 'not-open' });
    await openFromStash(entry, undefined, d);
    expect(d.place).not.toHaveBeenCalled();
    await openFromStash(entry, null, d);
    expect(d.place).toHaveBeenCalledWith('/r/a.md', null);
  });

  it('an open that did not land (the open-error toast is already up) reports failure silently', async () => {
    const d = deps({ kind: 'not-open' }, false);
    expect(await openFromStash(entry, 'tab-3', d)).toEqual({ kind: 'failed', error: null });
    expect(d.place).not.toHaveBeenCalled();
    expect(d.touch).not.toHaveBeenCalled();
  });

  it('a failed request says why', async () => {
    const d = deps({ kind: 'not-open' });
    d.requestMove.mockRejectedValueOnce(new Error('no window'));
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'failed', error: 'no window' });
    expect(d.openPath).not.toHaveBeenCalled();
  });

  it('a failed touch does not fail the open', async () => {
    const d = deps({ kind: 'not-open' });
    d.touch.mockRejectedValueOnce(new Error('locked'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await openFromStash(entry, undefined, d)).toEqual({ kind: 'opened' });
    await Promise.resolve();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('handOverPulled', () => {
  function holder(outcome: MoveOutcome | undefined, tab: { id: string } | null = { id: 't4' }) {
    return {
      findByPath: vi.fn((_path: string) => tab ?? undefined),
      moveTabs: vi.fn(async (_ids: readonly string[], _target: MoveTarget) => outcome),
      reportStranded: vi.fn((_stranded: readonly Stranded[]) => {}),
    };
  }

  it('moves the tab to the window that asked', async () => {
    const d = holder({ kind: 'moved', label: 'editor-2', number: 2, count: 1 });
    await handOverPulled('/r/a.md', 'editor-2', d);
    expect(d.moveTabs).toHaveBeenCalledWith(['t4'], { kind: 'window', label: 'editor-2' });
    expect(d.reportStranded).not.toHaveBeenCalled();
  });

  it('a failed move says why here, where the tab stayed', async () => {
    const d = holder({ kind: 'failed', error: 'target gone' });
    await handOverPulled('/r/a.md', 'editor-2', d);
    expect(d.reportStranded).toHaveBeenCalledWith([{ path: '/r/a.md', error: 'target gone' }]);
  });

  it('a refusal already has its toast (mayLeave); a tab no longer here is nothing to move', async () => {
    const refused = holder({ kind: 'refused' });
    await handOverPulled('/r/a.md', 'editor-2', refused);
    expect(refused.reportStranded).not.toHaveBeenCalled();
    const gone = holder(undefined, null);
    await handOverPulled('/r/a.md', 'editor-2', gone);
    expect(gone.moveTabs).not.toHaveBeenCalled();
    expect(gone.reportStranded).not.toHaveBeenCalled();
  });
});

describe('awaitPull', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true as soon as the tab is here', async () => {
    let here = false;
    const pending = awaitPull(() => here);
    await vi.advanceTimersByTimeAsync(1000);
    here = true;
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false once PULL_WAIT_MS passed without it, not before', async () => {
    let settled: boolean | null = null;
    void awaitPull(() => false).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(PULL_WAIT_MS - 300);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);
  });

  it('a tab already here counts at the first look', async () => {
    const pending = awaitPull(() => true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(true);
  });
});
