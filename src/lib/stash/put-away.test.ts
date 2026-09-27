import { describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '../tabs/tab-model';
import type { PutAwayTabsOutcome } from '../tabs/controller';
import type { StashKind } from './types';
import { putAwayNote, putAwayTabs, type PutAwayDeps, type PutAwayOutcome } from './put-away';

const tab = (id: string, path: string | null): TabMeta => ({
  id,
  path,
  dirty: false,
  openedAt: 0,
  viewedAt: 0,
  unviewed: false,
});

// a: a file already in the stash; b: a blank new tab; c: a file not in the
// stash; d: an untitled tab with text (a note to be); n: a note.
const TABS = [tab('a', '/p/a.md'), tab('b', null), tab('c', '/p/c.md'), tab('d', null), tab('n', '/notes/n.md')];
const CAPTIONS: Record<string, string> = { a: 'a.md', b: 'Новая заметка', c: 'c.md', d: 'idea', n: 'Plan' };

function deps(
  close: (ids: string[]) => Promise<PutAwayTabsOutcome>,
  marks: Map<string, StashKind> = new Map([
    ['/p/a.md', 'file'],
    ['/notes/n.md', 'note'],
  ])
): PutAwayDeps {
  return {
    tabs: () => TABS,
    caption: (t) => CAPTIONS[t.id],
    mark: (path) => marks.get(path) ?? null,
    blank: (t) => t.id === 'b',
    close: vi.fn(close),
  };
}

const allClosed = async (ids: string[]): Promise<PutAwayTabsOutcome> => ({ closed: ids, notStashed: [] });

describe('putAwayTabs', () => {
  it('closes the chosen tabs in tab order and counts what went into the stash', async () => {
    const d = deps(allClosed);
    const outcome = await putAwayTabs(['d', 'c', 'b', 'a'], d);
    expect(d.close).toHaveBeenCalledWith(['a', 'b', 'c', 'd']);
    expect(outcome).toEqual({
      kind: 'done',
      closed: ['a', 'b', 'c', 'd'],
      count: 3,
      dup: 1,
      lead: 'a.md',
      leadIsNote: false,
      closedEmpty: 1,
      stashedPaths: ['/p/a.md', '/p/c.md'],
      kept: [],
      notStashed: [],
    });
  });

  it('reads the stash marks before the tabs close (the close itself stashes them)', async () => {
    const marks = new Map<string, StashKind>([['/notes/n.md', 'note']]);
    const d = deps(async (ids) => {
      marks.set('/p/a.md', 'file');
      marks.set('/p/c.md', 'file');
      return { closed: ids, notStashed: [] };
    }, marks);
    const outcome = await putAwayTabs(['a', 'c'], d);
    expect(outcome).toMatchObject({ kind: 'done', count: 2, dup: 0 });
  });

  it('a note leads as a note; an untitled tab with text is a note to be', async () => {
    expect(await putAwayTabs(['n', 'c'], deps(allClosed))).toMatchObject({ lead: 'c.md', leadIsNote: false, dup: 0 });
    expect(await putAwayTabs(['n'], deps(allClosed))).toMatchObject({ lead: 'Plan', leadIsNote: true, dup: 0 });
    expect(await putAwayTabs(['d'], deps(allClosed))).toMatchObject({ lead: 'idea', leadIsNote: true, count: 1 });
  });

  it('empty tabs are only closed: nothing counted', async () => {
    expect(await putAwayTabs(['b'], deps(allClosed))).toMatchObject({
      kind: 'done',
      closed: ['b'],
      count: 0,
      closedEmpty: 1,
      lead: null,
    });
  });

  it('a refused tab is not counted and is reported as kept', async () => {
    const d = deps(async () => ({ closed: ['a'], notStashed: [] }));
    expect(await putAwayTabs(['a', 'd'], d)).toMatchObject({
      closed: ['a'],
      count: 1,
      lead: 'a.md',
      kept: ['d'],
    });
  });

  it('a tab closed but not stashed is not counted; Rust’s answer is passed on', async () => {
    const d = deps(async () => ({ closed: ['a', 'c'], notStashed: [{ id: 'a', message: 'locked' }] }));
    expect(await putAwayTabs(['a', 'c'], d)).toMatchObject({
      closed: ['a', 'c'],
      count: 1,
      dup: 0,
      lead: 'c.md',
      stashedPaths: ['/p/c.md'],
      notStashed: [{ id: 'a', message: 'locked' }],
    });
  });

  it('ids that are not tabs here are ignored', async () => {
    const d = deps(allClosed);
    expect(await putAwayTabs(['zzz'], d)).toMatchObject({ kind: 'done', closed: [], count: 0, closedEmpty: 0 });
    expect(d.close).not.toHaveBeenCalled();
  });

  it('a close that threw says why', async () => {
    const d = deps(async () => {
      throw new Error('no window');
    });
    expect(await putAwayTabs(['a'], d)).toEqual({ kind: 'failed', error: 'no window' });
  });
});

describe('putAwayNote', () => {
  const done = (over: Partial<Extract<PutAwayOutcome, { kind: 'done' }>>): PutAwayOutcome => ({
    kind: 'done',
    closed: [],
    count: 0,
    dup: 0,
    lead: null,
    leadIsNote: false,
    closedEmpty: 0,
    stashedPaths: [],
    kept: [],
    notStashed: [],
    ...over,
  });

  it('the summary toast, with what the repo chip hides', () => {
    expect(putAwayNote(done({ count: 3, dup: 1, lead: 'Plan', leadIsNote: true, closedEmpty: 1 }), 2, 'r')).toEqual({
      what: 'put-away',
      count: 3,
      dup: 1,
      lead: 'Plan',
      leadIsNote: true,
      hidden: 2,
      hiddenBy: 'r',
      onlyEmpty: false,
      emptyToo: true,
    });
  });

  it('nothing hidden names no chip', () => {
    expect(putAwayNote(done({ count: 1, lead: 'a.md' }), 0, 'r')).toMatchObject({ hidden: 0, hiddenBy: null });
  });

  it('only empty tabs', () => {
    expect(putAwayNote(done({ closedEmpty: 2 }))).toMatchObject({ what: 'put-away', onlyEmpty: true, count: 0 });
  });

  it('nothing went in and nothing empty closed: no toast (the refusals have their own)', () => {
    expect(putAwayNote(done({ kept: ['d'] }))).toBeNull();
    expect(putAwayNote(done({ closed: ['a'], notStashed: [{ id: 'a', message: 'locked' }] }))).toBeNull();
  });

  it('a failed close is a drawer error', () => {
    expect(putAwayNote({ kind: 'failed', error: 'no window' })).toEqual({ what: 'error', message: 'no window' });
  });
});
