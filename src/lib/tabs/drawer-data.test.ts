import { describe, it, expect, vi } from 'vitest';
import { createDrawerData, type DrawerDataDeps, type GitInfo } from './drawer-data';
import { filterEntries } from './drawer-filter';
import type { TabMeta } from './tab-model';

const meta = (id: string, path: string | null): TabMeta => ({
  id,
  path,
  dirty: false,
  openedAt: 0,
  viewedAt: 0,
  unviewed: false,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(held: Record<string, string> = {}) {
  const reads: { path: string; d: ReturnType<typeof deferred<string>> }[] = [];
  const gits: { paths: string[]; d: ReturnType<typeof deferred<(GitInfo | null)[]>> }[] = [];
  const deps: DrawerDataDeps = {
    held: (id) => held[id] ?? null,
    read: vi.fn((path: string) => {
      const d = deferred<string>();
      reads.push({ path, d });
      return d.promise;
    }),
    gitInfo: vi.fn((paths: string[]) => {
      const d = deferred<(GitInfo | null)[]>();
      gits.push({ paths, d });
      return d.promise;
    }),
  };
  const onChange = vi.fn();
  return { deps, reads, gits, onChange, data: createDrawerData(deps, onChange) };
}

describe('createDrawerData', () => {
  it('DigestsHeldTextAtOnce_AndReadsTheRestFromDisk', async () => {
    const h = harness({ a: '# Alpha\n\nbody' });
    h.data.refresh([meta('a', '/a.md'), meta('b', '/b.md')]);
    expect(h.data.text('a')?.first).toBe('Alpha');
    expect(h.data.text('a')?.preview[0]).toEqual({ kind: 'heading', segs: [{ text: 'Alpha' }] });
    expect(h.data.text('b')).toBeNull();
    expect(h.reads.map((r) => r.path)).toEqual(['/b.md']);
    h.reads[0].d.resolve('Bravo line');
    await flush();
    expect(h.data.text('b')?.index?.lines).toEqual(['Bravo line']);
    expect(h.onChange).toHaveBeenCalled();
  });

  it('AnUntitledTabWithoutHeldTextIsEmpty', () => {
    const h = harness();
    h.data.refresh([meta('u', null)]);
    expect(h.data.text('u')).toEqual({ index: { lines: [], lower: [] }, preview: [], first: '' });
    expect(h.deps.read).not.toHaveBeenCalled();
  });

  it('DropsAReadFromAnEarlierOpening', async () => {
    const h = harness();
    h.data.refresh([meta('b', '/b.md')]);
    h.data.refresh([meta('b', '/b.md')]);
    h.reads[1].d.resolve('new');
    await flush();
    h.reads[0].d.resolve('old');
    await flush();
    expect(h.data.text('b')?.first).toBe('new');
  });

  it('EnsureReadsOnlyTabsItHasNotSeen', () => {
    const h = harness({ a: 'A' });
    h.data.refresh([meta('a', '/a.md')]);
    h.data.ensure([meta('a', '/a.md'), meta('c', '/c.md')]);
    h.data.ensure([meta('a', '/a.md'), meta('c', '/c.md')]);
    expect(h.reads.map((r) => r.path)).toEqual(['/c.md']);
  });

  it('ForgetsTabsThatAreGone', () => {
    const h = harness({ a: 'A', b: 'B' });
    h.data.refresh([meta('a', '/a.md'), meta('b', '/b.md')]);
    h.data.refresh([meta('a', '/a.md')]);
    expect(h.data.text('b')).toBeNull();
  });

  it('AFailedReadLeavesNoText', async () => {
    const h = harness();
    h.data.refresh([meta('b', '/b.md')]);
    h.reads[0].d.reject(new Error('EACCES'));
    await flush();
    expect(h.data.text('b')).toBeNull();
  });

  it('AFailedReadDropsTextFromAnEarlierOpening', async () => {
    const h = harness();
    h.data.refresh([meta('b', '/b.md')]);
    h.reads[0].d.resolve('old');
    await flush();
    h.data.refresh([meta('b', '/b.md')]);
    h.onChange.mockClear();
    h.reads[1].d.reject(new Error('ENOENT'));
    await flush();
    expect(h.data.text('b')).toBeNull();
    expect(h.onChange).toHaveBeenCalled();
  });

  it('AsksGitInfoForEveryFileOnOpen_AndOnlyForNewPathsOnEnsure', async () => {
    const h = harness({ a: 'A', b: 'B', c: 'C' });
    h.data.refresh([meta('a', '/a.md'), meta('u', null), meta('b', '/b.md')]);
    expect(h.gits.map((g) => g.paths)).toEqual([['/a.md', '/b.md']]);
    expect(h.data.git('/a.md')).toBeUndefined();
    h.gits[0].d.resolve([{ project: 'couplet', branch: 'main' }, null]);
    await flush();
    expect(h.data.git('/a.md')).toEqual({ project: 'couplet', branch: 'main' });
    expect(h.data.git('/b.md')).toBeNull();
    h.data.ensure([meta('a', '/a.md'), meta('b', '/b.md'), meta('c', '/c.md')]);
    expect(h.gits.map((g) => g.paths)).toEqual([['/a.md', '/b.md'], ['/c.md']]);
  });

  it('AReadThatLandsAfterTheTabBecameHeldDoesNotOverwriteIt', async () => {
    const held: Record<string, string> = {};
    const h = harness(held);
    h.data.refresh([meta('b', '/b.md')]);
    held.b = 'Live';
    h.data.refresh([meta('b', '/b.md')]);
    h.reads[0].d.resolve('disk');
    await flush();
    expect(h.data.text('b')?.first).toBe('Live');
  });

  it('AReadThatFailsAfterTheTabBecameHeldKeepsTheHeldText', async () => {
    const held: Record<string, string> = {};
    const h = harness(held);
    h.data.refresh([meta('b', '/b.md')]);
    held.b = 'Live';
    h.data.refresh([meta('b', '/b.md')]);
    h.reads[0].d.reject(new Error('EACCES'));
    await flush();
    expect(h.data.text('b')?.first).toBe('Live');
  });

  it('AFailedReadIsRetriedOncePerOpening_NotOnEveryEnsure', async () => {
    const h = harness();
    const tabs = [meta('b', '/b.md')];
    h.data.refresh(tabs);
    h.reads[0].d.reject(new Error('EACCES'));
    await flush();
    h.data.ensure(tabs);
    h.data.ensure(tabs);
    h.data.ensure(tabs);
    expect(h.reads).toHaveLength(1);
    h.data.refresh(tabs);
    expect(h.reads).toHaveLength(2);
  });

  it('AnOlderGitAnswerDoesNotOverwriteANewerOne', async () => {
    const h = harness({ a: 'A' });
    h.data.refresh([meta('a', '/a.md')]);
    h.data.refresh([meta('a', '/a.md')]);
    h.gits[1].d.resolve([{ project: 'couplet', branch: 'feat' }]);
    await flush();
    h.gits[0].d.resolve([{ project: 'couplet', branch: 'main' }]);
    await flush();
    expect(h.data.git('/a.md')).toEqual({ project: 'couplet', branch: 'feat' });
  });

  it('AFailedGitCallAnswersNull_WithoutLosingAnEarlierAnswer', async () => {
    const h = harness({ a: 'A', b: 'B' });
    h.data.refresh([meta('a', '/a.md')]);
    h.gits[0].d.resolve([{ project: 'couplet', branch: 'main' }]);
    await flush();
    h.data.refresh([meta('a', '/a.md'), meta('b', '/b.md')]);
    h.onChange.mockClear();
    h.gits[1].d.reject(new Error('ipc'));
    await flush();
    expect(h.data.git('/a.md')).toEqual({ project: 'couplet', branch: 'main' });
    expect(h.data.git('/b.md')).toBeNull();
    expect(h.onChange).toHaveBeenCalled();
  });

  it('EnsureDoesNotAskGitAgainForAPathStillBeingAnswered', () => {
    const h = harness({ a: 'A', c: 'C' });
    h.data.refresh([meta('a', '/a.md')]);
    h.data.ensure([meta('a', '/a.md'), meta('c', '/c.md')]);
    expect(h.gits.map((g) => g.paths)).toEqual([['/a.md'], ['/c.md']]);
  });

  it('EnsureAsksGitForAKnownTabThatMovedToANewPath', () => {
    const h = harness({ a: 'A' });
    h.data.refresh([meta('a', '/a.md')]);
    h.data.ensure([meta('a', '/renamed.md')]);
    expect(h.gits.map((g) => g.paths)).toEqual([['/a.md'], ['/renamed.md']]);
  });

  it('ForgetsGitForPathsNoTabHas_AndDropsTheirLateAnswers', async () => {
    const h = harness({ a: 'A', b: 'B' });
    h.data.refresh([meta('a', '/a.md'), meta('b', '/b.md')]);
    h.data.ensure([meta('a', '/a.md')]);
    h.gits[0].d.resolve([
      { project: 'couplet', branch: 'main' },
      { project: 'other', branch: 'dev' },
    ]);
    await flush();
    expect(h.data.git('/a.md')).toEqual({ project: 'couplet', branch: 'main' });
    expect(h.data.git('/b.md')).toBeUndefined();
  });

  it('ReleaseDropsTheSearchIndex_KeepsTheCard_AndTheNextOpeningRebuildsIt', async () => {
    const held: Record<string, string> = { a: '# Alpha\n\nneedle here' };
    const h = harness(held);
    const tabs = [meta('a', '/a.md'), meta('b', '/b.md')];
    h.data.refresh(tabs);
    h.reads[0].d.resolve('bravo needle');
    await flush();

    const before = h.data.text('a');
    expect(before?.index).not.toBeNull();

    h.onChange.mockClear();
    h.data.release();

    expect(h.onChange).toHaveBeenCalled();
    expect(h.data.text('a')).toEqual({ index: null, preview: before?.preview, first: 'Alpha' });
    expect(h.data.text('b')?.index).toBeNull();
    expect(h.data.text('b')?.first).toBe('bravo needle');

    h.data.refresh(tabs);
    h.reads[1].d.resolve('bravo needle');
    await flush();
    const entries = tabs.map((t) => ({ id: t.id, name: t.id, index: h.data.text(t.id)?.index ?? null }));
    expect(filterEntries(entries, 'needle').map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('ReleaseDropsAReadStillInFlight', async () => {
    const h = harness();
    h.data.refresh([meta('b', '/b.md')]);
    h.data.release();
    h.reads[0].d.resolve('late');
    await flush();
    expect(h.data.text('b')).toBeNull();
  });
});
