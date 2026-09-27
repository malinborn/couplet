import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { payload: unknown }) => void;

// `vi.mock` factories are hoisted above every declaration in this file.
const { windowListen, globalListen } = vi.hoisted(() => ({
  windowListen: vi.fn((_name: string, _cb: Listener) => Promise.resolve(() => {})),
  globalListen: vi.fn((_name: string, _cb: Listener) => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ listen: windowListen }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: globalListen }));

import { onStashChanged } from './events';

describe('onStashChanged', () => {
  beforeEach(() => {
    windowListen.mockClear();
    globalListen.mockClear();
  });

  it('listens through the current window, never globally', async () => {
    await onStashChanged(() => {});
    expect(windowListen).toHaveBeenCalledTimes(1);
    expect(windowListen.mock.calls[0][0]).toBe('stash-changed');
    expect(globalListen).not.toHaveBeenCalled();
  });

  it("hands over the payload's reason and ids, or no ids when Rust left them out (A6)", async () => {
    const seen: [string, string[] | undefined][] = [];
    await onStashChanged((reason, ids) => seen.push([reason, ids]));
    const deliver = windowListen.mock.calls[0][1];
    deliver({ payload: { reason: 'put-away', ids: ['s1', 's2'] } });
    deliver({ payload: { reason: 'opened' } });
    expect(seen).toEqual([
      ['put-away', ['s1', 's2']],
      ['opened', undefined],
    ]);
  });
});
