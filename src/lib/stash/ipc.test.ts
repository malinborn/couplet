import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { invoke } from '@tauri-apps/api/core';
import {
  stashCounts,
  stashCreateNote,
  stashEntryForPath,
  stashGet,
  stashList,
  stashPutAway,
  stashTag,
  stashTouchOpened,
  windowProject,
} from './ipc';

const call = () => {
  const calls = vi.mocked(invoke).mock.calls;
  return calls[calls.length - 1];
};

describe('stash ipc', () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it('names every command and its arguments as the roadmap does', async () => {
    await stashCreateNote('# t', 'proj');
    expect(call()).toEqual(['stash_create_note', { text: '# t', repo: 'proj' }]);
    await stashCreateNote('# t', null);
    expect(call()).toEqual(['stash_create_note', { text: '# t', repo: null }]);
    await stashPutAway(['/a.md'], { caret: 3, topLine: 2 });
    expect(call()).toEqual(['stash_put_away', { paths: ['/a.md'], caret: 3, topLine: 2 }]);
    await stashPutAway(['/a.md', '/b.md'], { tags: ['x'] });
    expect(call()).toEqual(['stash_put_away', { paths: ['/a.md', '/b.md'], tags: ['x'] }]);
    await stashList({ repo: 'proj', sort: 'changed' });
    expect(call()).toEqual(['stash_list', { repo: 'proj', sort: 'changed' }]);
    await stashList();
    expect(call()).toEqual(['stash_list', {}]);
    await stashGet('s1');
    expect(call()).toEqual(['stash_get', { id: 's1' }]);
    await stashTag('s1', ['a'], ['b']);
    expect(call()).toEqual(['stash_tag', { id: 's1', add: ['a'], remove: ['b'] }]);
    await stashTouchOpened('/a.md');
    expect(call()).toEqual(['stash_touch_opened', { path: '/a.md' }]);
    await stashCounts('proj');
    expect(call()).toEqual(['stash_counts', { repo: 'proj' }]);
    await stashCounts();
    expect(call()).toEqual(['stash_counts', {}]);
    await stashEntryForPath('/a.md');
    expect(call()).toEqual(['stash_entry_for_path', { path: '/a.md' }]);
    await windowProject();
    // No argument object: the command takes none but the calling window.
    expect(call()).toEqual(['window_project']);
  });

  it('passes the listing filters flat, `since` included (roadmap A9)', async () => {
    await stashList({
      repo: 'proj',
      tag: 'idea',
      kind: 'note',
      sort: 'opened',
      deleted: false,
      since: 1_790_378_100_000,
      limit: 20,
      cursor: 'changed:abc',
    });
    expect(call()).toEqual([
      'stash_list',
      {
        repo: 'proj',
        tag: 'idea',
        kind: 'note',
        sort: 'opened',
        deleted: false,
        since: 1_790_378_100_000,
        limit: 20,
        cursor: 'changed:abc',
      },
    ]);
  });

  it("hands back the window's project as Rust answers it: root and directory name (A3)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ root: '/Users/u/work/proj', repo: 'proj' });
    await expect(windowProject()).resolves.toEqual({ root: '/Users/u/work/proj', repo: 'proj' });
  });
});
