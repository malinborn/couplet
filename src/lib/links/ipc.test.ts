import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { invoke } from '@tauri-apps/api/core';
import { PATH_KINDS_MAX, linkCandidates, linkProject, pathKinds, revealInFinder } from './ipc';

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

  it('mirrors the Rust batch limit (MAX_PATH_KINDS in links.rs)', () => {
    // Read from the Rust source, like native-menu-accelerators.test.ts reads
    // menu.rs: a limit changed on one side only fails here, not at runtime
    // as a refused batch and links that never get their missing style.
    const LINKS_RS = fileURLToPath(new URL('../../../src-tauri/src/links.rs', import.meta.url));
    const match = /pub const MAX_PATH_KINDS: usize = (\d+);/.exec(readFileSync(LINKS_RS, 'utf8'));
    expect(match, 'MAX_PATH_KINDS not found in links.rs').not.toBeNull();
    expect(PATH_KINDS_MAX).toBe(Number(match![1]));
  });
});

describe('picker ipc', () => {
  it('linkCandidates passes the document path', async () => {
    await linkCandidates('/r/a.md');
    expect(invoke).toHaveBeenCalledWith('link_candidates', { docPath: '/r/a.md' });
  });

  it('linkProject passes null for an untitled document', async () => {
    await linkProject(null);
    expect(invoke).toHaveBeenCalledWith('link_project', { docPath: null });
  });
});
