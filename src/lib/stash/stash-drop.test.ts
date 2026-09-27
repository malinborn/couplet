import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DropResult } from '../tabs/controller';
import { handleStashDropTab, type StashDropDeps } from './stash-drop';

afterEach(() => vi.restoreAllMocks());

function deps(over: Partial<StashDropDeps> = {}) {
  const order: string[] = [];
  const d: StashDropDeps = {
    dropPath: vi.fn(async (path: string) => {
      order.push(`drop ${path}`);
      return 'dropped' as const;
    }),
    pending: vi.fn(async () => true),
    done: vi.fn(async (requestId: number, dropped: boolean) => {
      order.push(`done ${requestId} ${dropped}`);
    }),
    ...over,
  };
  return { d, order };
}

describe('handleStashDropTab', () => {
  it('drops the tab, then answers dropped: true — never before the drop has settled', async () => {
    let release!: (v: DropResult) => void;
    const { d, order } = deps({
      dropPath: vi.fn(
        (path: string) =>
          new Promise<DropResult>((resolve) => {
            order.push(`drop ${path}`);
            release = resolve;
          })
      ),
    });
    const running = handleStashDropTab(d, { requestId: 7, path: '/n/a.md' });
    await Promise.resolve();
    expect(d.done).not.toHaveBeenCalled();
    release('dropped');
    await running;
    expect(order).toEqual(['drop /n/a.md', 'done 7 true']);
  });

  it('a tab that stayed answers dropped: false', async () => {
    const { d } = deps({ dropPath: vi.fn(async () => 'kept' as const) });
    await handleStashDropTab(d, { requestId: 3, path: '/n/b.md' });
    expect(d.done).toHaveBeenCalledWith(3, false);
  });

  it('a drop the tab queue swallowed (undefined) answers dropped: false', async () => {
    const { d } = deps({ dropPath: vi.fn(async () => undefined) });
    await handleStashDropTab(d, { requestId: 6, path: '/n/e.md' });
    expect(d.done).toHaveBeenCalledWith(6, false);
  });

  it('a drop that throws still answers, dropped: false — Rust must not wait out its timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = deps({
      dropPath: vi.fn(async () => {
        throw new Error('queue broke');
      }),
    });
    await handleStashDropTab(d, { requestId: 4, path: '/n/c.md' });
    expect(d.done).toHaveBeenCalledWith(4, false);
  });

  it('a failed answer does not throw out of the listener', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d } = deps({
      done: vi.fn(async () => {
        throw new Error('ipc closed');
      }),
    });
    await expect(handleStashDropTab(d, { requestId: 5, path: '/n/d.md' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  describe('a drop Rust no longer waits for (review M1)', () => {
    /** A `dropPath` that asks `stillWanted` the way the controller does: in its queue slot. */
    function asking(order: string[]) {
      return vi.fn(async (path: string, stillWanted: () => Promise<boolean>): Promise<DropResult> => {
        order.push('slot');
        if (!(await stillWanted())) return 'unwanted';
        order.push(`drop ${path}`);
        return 'dropped';
      });
    }

    it('asks Rust about this very request, from inside the drop — after the queue wait', async () => {
      const order: string[] = [];
      const { d } = deps({
        dropPath: asking(order),
        pending: vi.fn(async (id: number) => {
          order.push(`pending ${id}`);
          return true;
        }),
      });
      await handleStashDropTab(d, { requestId: 8, path: '/n/a.md' });
      expect(order).toEqual(['slot', 'pending 8', 'drop /n/a.md']);
      expect(d.done).toHaveBeenCalledWith(8, true);
    });

    it('a request already answered (timed out) keeps the tab and answers nothing', async () => {
      const order: string[] = [];
      const { d } = deps({ dropPath: asking(order), pending: vi.fn(async () => false) });
      await handleStashDropTab(d, { requestId: 9, path: '/n/a.md' });
      expect(order).toEqual(['slot']);
      expect(d.done).not.toHaveBeenCalled();
    });

    it('a pending check that fails keeps the tab and answers dropped: false', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const order: string[] = [];
      const { d } = deps({
        dropPath: asking(order),
        pending: vi.fn(async () => {
          throw new Error('ipc closed');
        }),
      });
      await handleStashDropTab(d, { requestId: 10, path: '/n/a.md' });
      expect(order).toEqual(['slot']);
      expect(d.done).toHaveBeenCalledWith(10, false);
    });
  });
});
