import { describe, expect, it, vi } from 'vitest';
import { createWidenSession } from './widen-session';
import type { WidenMemo } from './window-widen';

const memo = (width: number): WidenMemo => ({
  before: { width: 560, height: 700, x: 100, y: 50 },
  widened: { width, height: 700 },
  at: null,
});

interface Gate<T> {
  promise: Promise<T>;
  open(value: T): void;
}

/** A promise the test settles by hand. */
function gate<T>(): Gate<T> {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

function harness() {
  const log: string[] = [];
  const widens: Gate<WidenMemo | null>[] = [];
  const restores: Gate<void>[] = [];
  const deps = {
    widen: vi.fn(() => {
      log.push('widen');
      const g = gate<WidenMemo | null>();
      widens.push(g);
      return g.promise;
    }),
    restore: vi.fn((m: WidenMemo) => {
      log.push(`restore ${m.widened.width}`);
      const g = gate<void>();
      restores.push(g);
      return g.promise;
    }),
    announce: vi.fn(() => {
      log.push('toast');
    }),
  };
  return { log, widens, restores, deps, session: createWidenSession(deps) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createWidenSession', () => {
  it('open widens once and says so; close puts it back', async () => {
    const h = harness();
    h.session.edge(true);
    await tick();
    h.widens[0].open(memo(680));
    await tick();
    h.session.edge(false);
    await tick();
    h.restores[0].open();
    await h.session.idle();
    expect(h.log).toEqual(['widen', 'toast', 'restore 680']);
  });

  it('a close while widening restores after the widen lands, with no toast', async () => {
    const h = harness();
    h.session.edge(true);
    await tick();
    h.session.edge(false);
    await tick();
    expect(h.deps.restore).not.toHaveBeenCalled();
    h.widens[0].open(memo(680));
    await tick();
    h.restores[0].open();
    await h.session.idle();
    expect(h.log).toEqual(['widen', 'restore 680']);
  });

  it('open → close → open while widening: one widen, one toast, no restore', async () => {
    const h = harness();
    h.session.edge(true);
    await tick();
    h.session.edge(false);
    h.session.edge(true);
    h.widens[0].open(memo(680));
    await h.session.idle();
    expect(h.log).toEqual(['widen', 'toast']);
  });

  it('a reopen while the restore runs waits for it, then widens again', async () => {
    const h = harness();
    h.session.edge(true);
    await tick();
    h.widens[0].open(memo(680));
    await tick();
    h.session.edge(false);
    await tick();
    h.session.edge(true);
    await tick();
    expect(h.deps.widen).toHaveBeenCalledTimes(1);
    h.restores[0].open();
    await tick();
    expect(h.deps.widen).toHaveBeenCalledTimes(2);
    h.widens[1].open(memo(681));
    await h.session.idle();
    expect(h.log).toEqual(['widen', 'toast', 'restore 680', 'widen', 'toast']);
  });

  it('a window wide enough is not widened, and a close has nothing to put back', async () => {
    const h = harness();
    h.session.edge(true);
    await tick();
    h.widens[0].open(null);
    await tick();
    h.session.edge(false);
    await h.session.idle();
    expect(h.log).toEqual(['widen']);
  });

  it('a closed stash at start does nothing', async () => {
    const h = harness();
    h.session.edge(false);
    await h.session.idle();
    expect(h.log).toEqual([]);
  });

  it('a step that throws does not stop the next one', async () => {
    const h = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.deps.widen.mockImplementationOnce(() => Promise.reject(new Error('ipc')));
    h.session.edge(true);
    await tick();
    h.session.edge(false);
    h.session.edge(true);
    await tick();
    h.widens[0].open(memo(680));
    await h.session.idle();
    expect(h.deps.widen).toHaveBeenCalledTimes(2);
    expect(h.deps.announce).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
