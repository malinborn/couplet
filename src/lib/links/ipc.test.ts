import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { invoke } from '@tauri-apps/api/core';
import { PATH_KINDS_MAX, pathKinds, revealInFinder } from './ipc';

beforeEach(() => vi.mocked(invoke).mockClear());

describe('links ipc', () => {
  it('pathKinds sends the paths as they are', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(['file', 'missing']);
    await expect(pathKinds(['/a.md', '/b.md'])).resolves.toEqual(['file', 'missing']);
    expect(invoke).toHaveBeenCalledWith('path_kinds', { paths: ['/a.md', '/b.md'] });
  });

  it('revealInFinder names the path', async () => {
    await revealInFinder('/a.png');
    expect(invoke).toHaveBeenCalledWith('reveal_in_finder', { path: '/a.png' });
  });

  it('mirrors the Rust batch limit', () => {
    expect(PATH_KINDS_MAX).toBe(256);
  });
});
