import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorState, StateEffect } from '@codemirror/state';
import {
  createTabController,
  FLUSH_ATTEMPTS,
  type InitTab,
  type OpenAnswer,
  type SwapOptions,
  type TabControllerDeps,
} from './controller';
import type { TabOwner } from '../switch-document';

const fileTab = (tabId: string, path: string): InitTab => ({
  tabId,
  path,
  content: null,
  cursor: 0,
  topLine: 1,
});
const untitledTab = (tabId: string, content: string | null = null): InitTab => ({
  tabId,
  path: null,
  content,
  cursor: 0,
  topLine: 1,
});

const scrollMark = StateEffect.define<string>();

function makeHarness(initialFiles: Record<string, string>) {
  const files = new Map(Object.entries(initialFiles));
  const unreadable = new Set<string>();
  const owners = new Map<string, TabOwner>();
  const calls: string[] = [];
  const swaps: { state: EditorState; opts: SwapOptions }[] = [];
  const hooks = { duringRead: () => {}, duringCommitPauses: () => {}, afterFlush: () => {} };
  const doc = { path: null as string | null, dirty: false, baseline: null as string | null };
  let live = EditorState.create({ doc: '' });
  let saveSucceeds = true;
  let nextId = 1;
  let snapshot = 0;

  const deps: TabControllerDeps = {
    editor: {
      current: () => live,
      createState: (text, cursor) =>
        EditorState.create({
          doc: text,
          selection: { anchor: cursor === null ? text.length : Math.min(cursor, text.length) },
        }),
      swap: (state, opts) => {
        live = state;
        swaps.push({ state, opts });
        calls.push('swap');
      },
      applyDocumentConfig: vi.fn((path: string | null) => {
        calls.push(`config ${path}`);
      }),
      stripForBackground: () => {
        calls.push('strip');
      },
      scrollSnapshot: () => scrollMark.of(`snapshot ${++snapshot}`),
      applyPosition: vi.fn(async () => {}),
      topLine: () => 1,
      commitCellEdit: () => {
        calls.push('commitCell');
      },
    },
    doc: {
      path: () => doc.path,
      dirty: () => doc.dirty,
      baseline: () => doc.baseline,
      setActive: (path, dirty, baseline) => {
        calls.push(`setActive ${path}`);
        doc.path = path;
        doc.dirty = dirty;
        doc.baseline = baseline;
      },
    },
    autosave: {
      flush: vi.fn(async () => {
        calls.push('flush');
        if (saveSucceeds && doc.path !== null && doc.dirty) {
          files.set(doc.path, live.doc.toString());
          doc.baseline = live.doc.toString();
          doc.dirty = false;
        }
        hooks.afterFlush();
      }),
      holdsBack: vi.fn(() => false),
    },
    saveErrorPending: vi.fn(() => false),
    reportUnsaved: vi.fn(),
    comments: {
      flush: vi.fn(async (_path: string) => true),
      commitPauses: vi.fn(async (path: string) => {
        calls.push(`commitPauses ${path}`);
        hooks.duringCommitPauses();
      }),
      forget: vi.fn(),
      reload: vi.fn(async () => {}),
    },
    ai: {
      cancel: vi.fn(async (path: string) => {
        calls.push(`cancel ${path}`);
      }),
      hasLiveAsk: vi.fn(() => false),
      clearAsks: vi.fn(),
    },
    disk: {
      exists: async (path) => files.has(path),
      read: vi.fn(async (path: string) => {
        hooks.duringRead();
        if (unreadable.has(path)) throw new Error('Cannot open: file is not valid text.');
        const text = files.get(path);
        if (text === undefined) throw new Error('ENOENT');
        return text;
      }),
    },
    rust: {
      owner: vi.fn(async (path: string): Promise<TabOwner> => owners.get(path) ?? { kind: 'none' }),
      open: vi.fn(async (): Promise<OpenAnswer> => ({ kind: 'created', tabId: `t${nextId++}` })),
      release: vi.fn(async (tabId: string) => {
        calls.push(`release ${tabId}`);
      }),
      activate: vi.fn(async (tabId: string) => {
        calls.push(`activate ${tabId}`);
      }),
      close: vi.fn(async (tabId: string) => {
        calls.push(`close ${tabId}`);
      }),
      focusElsewhere: vi.fn(async (path: string) => {
        calls.push(`focusElsewhere ${path}`);
      }),
      closeWindow: vi.fn(async () => {
        calls.push('closeWindow');
      }),
    },
    entered: vi.fn(),
    changed: vi.fn(),
    settled: vi.fn(),
  };

  const controller = createTabController(deps);
  return {
    deps,
    controller,
    files,
    unreadable,
    owners,
    calls,
    swaps,
    hooks,
    doc,
    live: () => live,
    /** A keystroke: the live state changes and the document becomes dirty. */
    type(text: string) {
      live = live.update({ changes: { from: live.doc.length, insert: text } }).state;
      doc.dirty = true;
    },
    setSaveSucceeds(value: boolean) {
      saveSucceeds = value;
    },
    ids: () => controller.list.tabs.map((t) => t.id),
    active: () => controller.list.activeId,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** A window already showing `init`, with call records cleared. */
async function started(
  files: Record<string, string>,
  init: InitTab[],
  activeTabId: string | null = init[0]?.tabId ?? null
): Promise<Harness> {
  const h = makeHarness(files);
  await h.controller.init(init, activeTabId);
  vi.clearAllMocks();
  h.calls.length = 0;
  h.swaps.length = 0;
  return h;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('init', () => {
  it('LoadsOnlyTheActiveTab', async () => {
    const h = makeHarness({ '/a.md': 'AAAA', '/b.md': 'BBBB' });
    await h.controller.init([fileTab('a', '/a.md'), fileTab('b', '/b.md')], 'b');
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.deps.disk.read).toHaveBeenCalledTimes(1);
    expect(h.ids()).toEqual(['a', 'b']);
    expect(h.active()).toBe('b');
    expect(h.deps.rust.activate).toHaveBeenCalledWith('b');
    expect(h.deps.entered).toHaveBeenCalledWith('/b.md', true);
  });

  it('RestoresAnUntitledTabsTextAsUnsaved', async () => {
    const h = makeHarness({});
    await h.controller.init([untitledTab('u', 'draft')], 'u');
    expect(h.live().doc.toString()).toBe('draft');
    expect(h.doc.dirty).toBe(true);
  });

  it('ReleasesATabWhoseFileCannotBeReadAndShowsTheNext', async () => {
    const h = makeHarness({ '/bad.md': 'x', '/b.md': 'BBBB' });
    h.unreadable.add('/bad.md');
    await h.controller.init([fileTab('bad', '/bad.md'), fileTab('b', '/b.md')], 'bad');
    expect(h.deps.rust.release).toHaveBeenCalledWith('bad');
    expect(h.ids()).toEqual(['b']);
    expect(h.live().doc.toString()).toBe('BBBB');
  });

  it('StartsAnUntitledTabWhenNothingCanBeShown', async () => {
    const h = makeHarness({});
    await h.controller.init([], null);
    expect(h.deps.rust.open).toHaveBeenCalledWith(null);
    expect(h.ids()).toEqual(['t1']);
    expect(h.doc.path).toBeNull();
  });
});

describe('openPath', () => {
  it('OpensANewTabAfterTheActiveOneAndCachesTheLeavingState', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();

    await h.controller.openPath('/b.md');

    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.active()).toBe('t1');
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.deps.comments.flush).toHaveBeenCalledWith('/a.md');
    expect(h.calls).toContain('commitPauses /a.md');
    expect(h.calls).toContain('cancel /a.md');

    await h.controller.activate('a');
    expect(h.live()).toBe(stateA);
  });

  it('ReloadsACachedTabWhoseFileChangedOnDisk', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    await h.controller.openPath('/b.md');
    h.files.set('/a.md', 'changed outside');

    await h.controller.activate('a');

    expect(h.live()).not.toBe(stateA);
    expect(h.live().doc.toString()).toBe('changed outside');
  });

  it('ActivatesTheTabThatAlreadyHoldsThePath', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.openPath('/a.md');
    expect(h.deps.rust.open).toHaveBeenCalledTimes(1);
    expect(h.active()).toBe('a');
  });

  it('FocusesTheOtherWindowThatHoldsThePath', async () => {
    const h = await started({ '/a.md': 'AAAA', '/c.md': 'CCCC' }, [fileTab('a', '/a.md')]);
    h.owners.set('/c.md', { kind: 'other-window' });
    await h.controller.openPath('/c.md');
    expect(h.calls).toContain('focusElsewhere /c.md');
    expect(h.ids()).toEqual(['a']);
    expect(h.deps.disk.read).not.toHaveBeenCalled();
  });

  it('ReplacesABlankUntitledTab', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u')]);
    await h.controller.openPath('/a.md');
    expect(h.ids()).toEqual(['t1']);
    expect(h.deps.rust.release).toHaveBeenCalledWith('u');
    expect(h.live().doc.toString()).toBe('AAAA');
    // The blank tab's window overlays close like on any other leave.
    expect(h.calls).toContain('strip');
    expect(h.calls.indexOf('strip')).toBeLessThan(h.calls.indexOf('swap'));
  });

  it('KeepsAnUntitledTabTypedIntoWhileTheFileWasRead', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u')]);
    h.hooks.duringRead = () => h.type('hello');

    await h.controller.openPath('/a.md');

    expect(h.ids()).toEqual(['u', 't1']);
    expect(h.deps.rust.release).not.toHaveBeenCalled();
    h.hooks.duringRead = () => {};
    await h.controller.activate('u');
    expect(h.live().doc.toString()).toBe('hello');
  });

  it('SwitchingRightAfterTypingFlushesAndSucceeds_NoRefusal', async () => {
    // A keystroke still inside the 300 ms debounce is not "unsaved" in the
    // refusal sense: leaving flushes it first and only refuses a save that
    // did not land (architect review of plan 02).
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    h.type('x');

    await h.controller.openPath('/b.md');

    expect(h.deps.autosave.flush).toHaveBeenCalled();
    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
    expect(h.live().doc.toString()).toBe('BBBB');
    await h.controller.activate('a');
    expect(h.live().doc.toString()).toBe('AAAAx');
  });

  it('RefusesToLeaveAFileTabWhoseSaveDidNotLand_AfterBoundedRetries', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    h.setSaveSucceeds(false);
    h.type('x');

    await h.controller.openPath('/b.md');

    expect(h.deps.autosave.flush).toHaveBeenCalledTimes(FLUSH_ATTEMPTS);
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(h.deps.rust.open).not.toHaveBeenCalled();
    expect(h.live().doc.toString()).toBe('AAAAx');
  });

  it('DoesNotRetryAFlushWhileASaveErrorStands', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.saveErrorPending).mockReturnValue(true);
    h.setSaveSucceeds(false);
    h.type('x');

    await h.controller.openPath('/b.md');

    expect(h.deps.autosave.flush).toHaveBeenCalledTimes(1);
    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
    expect(h.ids()).toEqual(['a']);
  });

  it('RollsBackWhenTheUserTypesIntoAFileTabDuringTheHandover', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    h.hooks.duringCommitPauses = () => {
      h.setSaveSucceeds(false);
      h.type('late');
    };

    await h.controller.openPath('/b.md');

    expect(h.deps.ai.clearAsks).toHaveBeenCalled();
    expect(h.deps.comments.reload).toHaveBeenCalled();
    expect(h.deps.reportUnsaved).toHaveBeenCalled();
    expect(h.deps.rust.release).toHaveBeenCalledWith('t1');
    expect(h.ids()).toEqual(['a']);
    expect(h.live().doc.toString()).toBe('AAAAlate');
  });

  it('StopsBeforeAnythingIrreversibleWhenCommentsCannotBeSaved', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.comments.flush).mockResolvedValue(false);

    await h.controller.openPath('/b.md');

    expect(h.deps.comments.commitPauses).not.toHaveBeenCalled();
    expect(h.deps.ai.cancel).not.toHaveBeenCalled();
    expect(h.deps.rust.release).toHaveBeenCalledWith('t1');
    expect(h.ids()).toEqual(['a']);
  });

  it('ClaimsNothingWhenTheFileCannotBeRead', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'x' }, [fileTab('a', '/a.md')]);
    h.unreadable.add('/b.md');
    await h.controller.openPath('/b.md');
    expect(h.deps.rust.open).not.toHaveBeenCalled();
    expect(h.ids()).toEqual(['a']);
  });

  it('AppliesAGivenPositionToTheNewTab', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md', { cursor: 2, topLine: 3 });
    expect(h.live().selection.main.head).toBe(2);
    expect(h.deps.editor.applyPosition).toHaveBeenCalledWith({ cursor: 2, topLine: 3 });
  });
});

describe('swap', () => {
  it('ReappliesTheDocumentConfigAfterEverySwap_FreshAndCached', async () => {
    // A cached state can come back with a stale language (a load it started
    // was dropped when it was left), and the code-file class lives on the
    // view, not the state — so the window's config follows every swap.
    const h = await started({ '/a.md': 'AAAA', '/b.yml': 'k: v' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();

    await h.controller.openPath('/b.yml');
    await h.controller.activate('a');

    expect(h.live()).toBe(stateA);
    expect(h.calls.filter((c) => /^(swap|setActive|config)/.test(c))).toEqual([
      'swap',
      'setActive /b.yml',
      'config /b.yml',
      'swap',
      'setActive /a.md',
      'config /a.md',
    ]);
  });

  it('StartsAFreshStateAtTheTop_ACachedOneWhereItWasLeft', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);

    await h.controller.openPath('/b.md');
    await h.controller.activate('a');

    expect(h.swaps).toHaveLength(2);
    expect(h.swaps[0].opts).toEqual({ blur: true, scroll: 'top' });
    const back = h.swaps[1].opts;
    expect(back.blur).toBe(false);
    expect(back.scroll).not.toBe('top');
    expect(back.scroll instanceof StateEffect && back.scroll.is(scrollMark)).toBe(true);
    // Snapshot 1 was taken when /a.md was left.
    expect(back.scroll instanceof StateEffect ? back.scroll.value : null).toBe('snapshot 1');
  });
});

describe('newTab', () => {
  it('OpensABlankUntitledTabRightAfterTheActiveOne', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [fileTab('a', '/a.md')]);
    await h.controller.newTab();
    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.live().doc.toString()).toBe('');
    expect(h.doc.path).toBeNull();
  });
});

describe('activate', () => {
  it('AnAgentCannotTakeTheViewFromALiveQuestion_AHumanCan', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    vi.mocked(h.deps.ai.hasLiveAsk).mockReturnValue(true);

    const byAgent = await h.controller.runExclusive(() =>
      h.controller.activateNow('a', { byAgent: true })
    );
    expect(byAgent).toBe('busy');
    expect(h.active()).toBe('t1');

    await h.controller.activate('a');
    expect(h.active()).toBe('a');
  });

  it('SelectsByIndexAndCyclesWithWrap', async () => {
    const h = await started({ '/a.md': 'A', '/b.md': 'B', '/c.md': 'C' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.openPath('/c.md');
    expect(h.ids()).toEqual(['a', 't1', 't2']);

    await h.controller.selectIndex(1);
    expect(h.active()).toBe('a');
    await h.controller.cycle(-1);
    expect(h.active()).toBe('t2');
    await h.controller.cycle(1);
    expect(h.active()).toBe('a');
  });
});

describe('close', () => {
  it('ClosingTheLastTabClosesTheWindow', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [fileTab('a', '/a.md')]);
    await h.controller.closeActive();
    expect(h.calls.indexOf('close a')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('closeWindow')).toBeGreaterThan(h.calls.indexOf('close a'));
  });

  it('ActivatesTheRightNeighbourBeforeReleasingTheClosedTab', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    h.calls.length = 0;

    await h.controller.closeActive();

    expect(h.ids()).toEqual(['t1']);
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.calls.indexOf('activate t1')).toBeLessThan(h.calls.indexOf('close a'));
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
  });

  it('RefusesToCloseAFileTabWhoseSaveDidNotLand', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [fileTab('a', '/a.md')]);
    h.setSaveSucceeds(false);
    h.type('x');
    await h.controller.closeActive();
    expect(h.deps.reportUnsaved).toHaveBeenCalled();
    expect(h.deps.rust.close).not.toHaveBeenCalled();
    expect(h.ids()).toEqual(['a']);
  });

  it('DiscardsAnUntitledTabsTextOnClose', async () => {
    // Spec §8: ⌘W on untitled loses the text, by design.
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u', 'draft'), fileTab('a', '/a.md')], 'u');
    await h.controller.closeActive();
    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
    // A restored tab comes back at its saved caret (0 here), which is what gets recorded.
    expect(h.deps.rust.close).toHaveBeenCalledWith('u', { cursor: 0, topLine: 1 });
    expect(h.active()).toBe('a');
  });

  it('ClosesABackgroundTabWithItsCachedPosition', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [{ ...fileTab('a', '/a.md'), cursor: 2 }]);
    await h.controller.openPath('/b.md');
    h.calls.length = 0;

    await h.controller.closeTab('a');

    expect(h.deps.rust.close).toHaveBeenCalledWith('a', { cursor: 2, topLine: 1 });
    expect(h.active()).toBe('t1');
    expect(h.calls).not.toContain('swap');
  });
});

describe('report', () => {
  it('ReportsEveryTab_BackgroundUntitledTextFromItsCachedState', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u', 'one'), fileTab('a', '/a.md')], 'u');
    h.type(' two');
    await h.controller.activate('a');

    const { tabs, active } = h.controller.report({ cursor: 3, topLine: 2, content: 'AAAA' });

    expect(active).toBe('a');
    expect(tabs).toEqual([
      { tabId: 'u', path: null, cursor: 0, topLine: 1, content: 'one two' },
      { tabId: 'a', path: '/a.md', cursor: 3, topLine: 2, content: null },
    ]);
  });
});

describe('files that went away', () => {
  it('KeepsTheCachedTextOfATabWhoseFileWasDeleted', async () => {
    // Same rule as for the active tab: a deleted file keeps its buffer. A
    // fresh empty state on that path would drop the last copy of the text.
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    await h.controller.openPath('/b.md');
    h.files.delete('/a.md');

    expect(await h.controller.activate('a')).toBe('ok');

    expect(h.live()).toBe(stateA);
    expect(h.doc.path).toBe('/a.md');
    expect(h.doc.baseline).toBeNull();
  });

  it('ReturningToATabWhoseFileCannotBeReadFails_AndKeepsItsCache', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    await h.controller.openPath('/b.md');
    h.unreadable.add('/a.md');

    expect(await h.controller.activate('a')).toBe('failed');
    expect(h.active()).toBe('t1');
    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.live().doc.toString()).toBe('BBBB');

    h.unreadable.delete('/a.md');
    expect(await h.controller.activate('a')).toBe('ok');
    expect(h.live()).toBe(stateA);
  });
});

describe('claims', () => {
  it('ReleasesTheClaimWhenTheHandoverThrows_OpeningAFile', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    vi.mocked(h.deps.comments.commitPauses).mockRejectedValueOnce(new Error('ipc'));

    await h.controller.openPath('/b.md');

    expect(h.deps.rust.release).toHaveBeenCalledWith('t1');
    expect(h.ids()).toEqual(['a']);
    expect(h.live()).toBe(stateA);
  });

  it('ReleasesTheClaimWhenTheHandoverThrows_NewTab', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    vi.mocked(h.deps.comments.commitPauses).mockRejectedValueOnce(new Error('ipc'));

    await h.controller.newTab();

    expect(h.deps.rust.release).toHaveBeenCalledWith('t1');
    expect(h.ids()).toEqual(['a']);
    expect(h.live()).toBe(stateA);
  });

  it('ReleasesAStaleClaimTheOwnerQueryReportsForThisWindow', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    h.owners.set('/b.md', { kind: 'this-window', tabId: 'ghost' });

    await h.controller.openPath('/b.md');

    expect(h.deps.rust.release).toHaveBeenCalledWith('ghost');
    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.live().doc.toString()).toBe('BBBB');
  });

  it('ReleasesAStaleClaimTabOpenAnswersAndOpensAgain', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'this-window', tabId: 'ghost' });

    await h.controller.openPath('/b.md');

    expect(h.deps.rust.release).toHaveBeenCalledWith('ghost');
    expect(h.deps.rust.open).toHaveBeenCalledTimes(2);
    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.live().doc.toString()).toBe('BBBB');
  });
});

describe('flush', () => {
  it('ATypedKeyDuringTheHandoverFlushIsPickedUpByARetry', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    let armed = false;
    h.hooks.duringCommitPauses = () => {
      armed = true;
    };
    h.hooks.afterFlush = () => {
      if (!armed) return;
      armed = false;
      h.type('y');
    };

    await h.controller.openPath('/b.md');

    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.files.get('/a.md')).toBe('AAAAy');
  });

  it('DoesNotRetryAFlushTheConflictDialogHoldsBack', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.autosave.holdsBack).mockReturnValue(true);
    h.setSaveSucceeds(false);
    h.type('x');

    await h.controller.openPath('/b.md');

    expect(h.deps.autosave.flush).toHaveBeenCalledTimes(1);
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(h.ids()).toEqual(['a']);
  });

  it('AnAgentIsRefusedWhenTheActiveSaveDidNotLand', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    h.setSaveSucceeds(false);
    h.type('x');

    const result = await h.controller.runExclusive(() =>
      h.controller.activateNow('a', { byAgent: true })
    );

    expect(result).toBe('refused');
    expect(h.active()).toBe('t1');
  });
});

describe('close, continued', () => {
  it('KeepsTheTabWhenItIsTypedIntoDuringTheCloseAwaits', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    vi.clearAllMocks();
    h.hooks.duringCommitPauses = () => {
      h.setSaveSucceeds(false);
      h.type('late');
    };

    await h.controller.closeActive();

    expect(h.deps.rust.close).not.toHaveBeenCalled();
    expect(h.deps.reportUnsaved).toHaveBeenCalled();
    expect(h.deps.comments.reload).toHaveBeenCalled();
    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.active()).toBe('a');
    expect(h.live().doc.toString()).toBe('AAAAlate');
  });

  it('StopsClosingWhenCommentsCannotBeSaved', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.comments.flush).mockResolvedValue(false);

    await h.controller.closeActive();

    expect(h.deps.comments.commitPauses).not.toHaveBeenCalled();
    expect(h.deps.rust.close).not.toHaveBeenCalled();
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
    expect(h.ids()).toEqual(['a']);
  });

  it('ClosingABackgroundUntitledTabDropsItsText', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [untitledTab('u', 'draft'), fileTab('a', '/a.md')], 'a');

    await h.controller.closeTab('u');

    expect(h.deps.rust.close).toHaveBeenCalledWith('u', { cursor: 0, topLine: 1 });
    const { tabs } = h.controller.report({ cursor: 0, topLine: 1, content: 'AAAA' });
    expect(tabs.map((t) => t.tabId)).toEqual(['a']);
  });

  it('ReleasesUnreadableNeighboursOnlyAfterTheSwap', async () => {
    // Nothing may await between the last dirty check and the swap.
    const h = await started({ '/a.md': 'A', '/b.md': 'B', '/c.md': 'C' }, [
      fileTab('a', '/a.md'),
      fileTab('b', '/b.md'),
      fileTab('c', '/c.md'),
    ]);
    h.unreadable.add('/b.md');

    await h.controller.closeActive();

    expect(h.ids()).toEqual(['c']);
    expect(h.live().doc.toString()).toBe('C');
    expect(h.calls.indexOf('swap')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('swap')).toBeLessThan(h.calls.indexOf('release b'));
  });

  it('CallsMadeInOneTickSeeTheListTheEarlierOneLeft', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);

    const opening = h.controller.openPath('/b.md');
    const closing = h.controller.closeActive();
    await Promise.all([opening, closing]);

    expect(h.deps.rust.close).toHaveBeenCalledWith('t1', expect.anything());
    expect(h.ids()).toEqual(['a']);
    expect(h.active()).toBe('a');
  });
});
