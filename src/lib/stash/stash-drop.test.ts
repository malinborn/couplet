import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleStashDropTab, type StashDropDeps } from './stash-drop';

afterEach(() => vi.restoreAllMocks());

function deps(over: Partial<StashDropDeps> = {}) {
  const order: string[] = [];
  const d: StashDropDeps = {
    dropPath: vi.fn(async (path: string) => {
      order.push(`drop ${path}`);
      return true;
    }),
    done: vi.fn(async (requestId: number, dropped: boolean) => {
      order.push(`done ${requestId} ${dropped}`);
    }),
    ...over,
  };
  return { d, order };
}

describe('handleStashDropTab', () => {
  it('drops the tab, then answers dropped: true — never before the drop has settled', async () => {
    let release!: (v: boolean) => void;
    const { d, order } = deps({
      dropPath: vi.fn(
        (path: string) =>
          new Promise<boolean>((resolve) => {
            order.push(`drop ${path}`);
            release = resolve;
          })
      ),
    });
    const running = handleStashDropTab(d, { requestId: 7, path: '/n/a.md' });
    await Promise.resolve();
    expect(d.done).not.toHaveBeenCalled();
    release(true);
    await running;
    expect(order).toEqual(['drop /n/a.md', 'done 7 true']);
  });

  it('a tab that stayed answers dropped: false', async () => {
    const { d } = deps({ dropPath: vi.fn(async () => false) });
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
});
