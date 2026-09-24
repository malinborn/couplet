import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorState, StateEffect } from '@codemirror/state';
import {
  createTabController,
  FLUSH_ATTEMPTS,
  TRANSIENT_IGNORED_AFTER_MS,
  type BackgroundOpen,
  type InitTab,
  type OpenAnswer,
  type OpenPathResult,
  type QuickLookOrigin,
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
  const parkOnLeave = new Set<string>();
  let writeFails = false;
  let nextId = 1;
  let snapshot = 0;
  const clock = { now: 1_000, focused: true };

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
      leave: vi.fn((tabId: string) => {
        calls.push(`leave ${tabId}`);
        return parkOnLeave.has(tabId);
      }),
      enter: vi.fn(async (tabId: string) => {
        calls.push(`enter ${tabId}`);
      }),
      forget: vi.fn((tabId: string) => {
        calls.push(`forget ${tabId}`);
      }),
      hasLiveAsk: vi.fn(() => false),
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
      write: vi.fn(async (path: string, content: string) => {
        if (writeFails) throw new Error('EACCES');
        files.set(path, content);
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
      openWindow: vi.fn(async (path: string) => {
        calls.push(`openWindow ${path}`);
      }),
    },
    entered: vi.fn(),
    changed: vi.fn(),
    settled: vi.fn(),
    now: () => clock.now,
    windowFocused: () => clock.focused,
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
    clock,
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
    parkOnLeave,
    setWriteFails(value: boolean) {
      writeFails = value;
    },
    ids: () => controller.list.tabs.map((t) => t.id),
    active: () => controller.list.activeId,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** "To new windows": the paths a window was asked for, in order. */
async function moveOut(h: Harness, ids: string[]): Promise<string[]> {
  await h.controller.moveToNewWindows(ids);
  return vi.mocked(h.deps.rust.openWindow).mock.calls.map(([path]) => path);
}

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
    expect(h.calls).toContain('leave a');

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
    // did not land.
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

    expect(h.deps.ai.leave).not.toHaveBeenCalled();
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
    expect(h.deps.ai.leave).not.toHaveBeenCalled();
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

  it('ANewTabTakesThePathAsRustRegisteredIt', async () => {
    // `/tmp` is a symlink on macOS: Rust registers `/private/tmp/b.md`, and
    // an agent names the file that way — the tab must answer to it.
    const h = await started({ '/a.md': 'AAAA', '/tmp/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'created', tabId: 't9', path: '/private/tmp/b.md' });

    await h.controller.openPath('/tmp/b.md');

    expect(h.controller.list.tabs.find((t) => t.id === 't9')?.path).toBe('/private/tmp/b.md');
    expect(h.deps.entered).toHaveBeenLastCalledWith('/private/tmp/b.md', true);
    vi.mocked(h.deps.rust.open).mockClear();
    await h.controller.openPath('/private/tmp/b.md');
    expect(h.deps.rust.open).not.toHaveBeenCalled();
    expect(h.active()).toBe('t9');
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

    await h.controller.closeTabs(['a']);

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
      expect.objectContaining({ tabId: 'u', path: null, cursor: 0, topLine: 1, content: 'one two' }),
      expect.objectContaining({ tabId: 'a', path: '/a.md', cursor: 3, topLine: 2, content: null }),
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

  it('ShowsNoTabRustDidNotRegister_OpeningAFile', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'failed' });

    await h.controller.openPath('/b.md');

    expect(h.ids()).toEqual(['a']);
    expect(h.active()).toBe('a');
    expect(h.live()).toBe(stateA);
    expect(h.swaps).toHaveLength(0);
    expect(h.deps.rust.release).not.toHaveBeenCalled();
  });

  it('ShowsNoTabRustDidNotRegister_NewTab', async () => {
    const h = await started({ '/a.md': 'AAAA' }, [fileTab('a', '/a.md')]);
    const stateA = h.live();
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'failed' });

    await h.controller.newTab();

    expect(h.ids()).toEqual(['a']);
    expect(h.live()).toBe(stateA);
    expect(h.swaps).toHaveLength(0);
  });

  it('ShowsNoTabRustDidNotRegister_InitFallback', async () => {
    const h = makeHarness({});
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'failed' });

    await h.controller.init([], null);

    expect(h.ids()).toEqual([]);
    expect(h.swaps).toHaveLength(0);
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

    await h.controller.closeTabs(['u']);

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

describe('drawer stamps', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB' };
  const meta = (h: Harness, id: string) => {
    const found = h.controller.list.tabs.find((t) => t.id === id);
    if (!found) throw new Error(`no tab ${id}`);
    return found;
  };
  const withStamps = (t: InitTab, openedAt: number, viewedAt: number, unviewed: boolean): InitTab => ({
    ...t,
    openedAt,
    viewedAt,
    unviewed,
  });

  it('ANewTabIsStampedWhenOpened', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    h.clock.now = 5_000;
    await h.controller.newTab();
    const fresh = h.controller.list.tabs.find((t) => t.id !== 'a');
    expect(fresh).toMatchObject({ openedAt: 5_000, unviewed: false });
  });

  it('RestoredStampsAreKept_AndAMissingOneMeansNow', async () => {
    const h = makeHarness(files);
    h.clock.now = 9_000;
    await h.controller.init([fileTab('a', '/a.md'), withStamps(fileTab('b', '/b.md'), 5, 6, true)], 'a');
    expect(meta(h, 'a').openedAt).toBe(9_000);
    expect(meta(h, 'b')).toMatchObject({ openedAt: 5, viewedAt: 6, unviewed: true });
  });

  it('ActivatingInAFocusedWindowMarksTheTabSeen_AndStampsTheOneLeft', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), withStamps(fileTab('b', '/b.md'), 5, 6, true)]);
    h.clock.now = 7_000;
    await h.controller.activate('b');
    expect(meta(h, 'b')).toMatchObject({ viewedAt: 7_000, unviewed: false });
    expect(meta(h, 'a').viewedAt).toBe(7_000);
  });

  it('ActivatingWhileNobodyLooksLeavesItUnviewed', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), withStamps(fileTab('b', '/b.md'), 5, 6, true)]);
    const aSeen = meta(h, 'a').viewedAt;
    h.clock.focused = false;
    h.clock.now = 7_000;
    await h.controller.activate('b');
    expect(meta(h, 'b')).toMatchObject({ viewedAt: 6, unviewed: true });
    expect(meta(h, 'a').viewedAt).toBe(aSeen);
  });

  it('FocusComingBackMarksTheActiveTabSeen', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), withStamps(fileTab('b', '/b.md'), 5, 6, true)]);
    h.clock.focused = false;
    await h.controller.activate('b');
    h.clock.focused = true;
    h.clock.now = 8_000;
    vi.mocked(h.deps.settled).mockClear();
    await h.controller.windowFocusChanged(true);
    expect(meta(h, 'b')).toMatchObject({ viewedAt: 8_000, unviewed: false });
    expect(h.deps.settled).toHaveBeenCalledTimes(1);
  });

  it('LosingFocusStampsTheActiveTab', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    h.clock.now = 3_000;
    await h.controller.windowFocusChanged(false);
    expect(meta(h, 'a').viewedAt).toBe(3_000);
    expect(meta(h, 'b').viewedAt).toBe(0);
  });

  it('AnAgentMarksATabUnviewedUnlessItIsInFrontOfAHuman', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    await h.controller.runExclusive(async () => {
      h.controller.markUnviewedNow('a');
      h.controller.markUnviewedNow('b');
    });
    expect(meta(h, 'a').unviewed, 'the active tab of a focused window is being looked at').toBe(false);
    expect(meta(h, 'b').unviewed, 'a background tab is not, focus or no focus').toBe(true);
    h.clock.focused = false;
    await h.controller.runExclusive(async () => h.controller.markUnviewedNow('a'));
    expect(meta(h, 'a').unviewed).toBe(true);
    expect(h.deps.settled).toHaveBeenCalled();
    await h.controller.runExclusive(async () => {
      expect(() => h.controller.markUnviewedNow('ghost')).not.toThrow();
    });
  });

  it('AStampFromOutsideTheExclusiveSlotIsRefused', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    h.controller.markUnviewedNow('b');
    expect(meta(h, 'b').unviewed).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('markUnviewedNow'));
  });

  it('TheHeartbeatCarriesTheStamps', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), withStamps(fileTab('b', '/b.md'), 5, 6, true)]);
    const { tabs } = h.controller.report({ cursor: 0, topLine: 1, content: 'AAAA' });
    expect(tabs).toEqual([
      expect.objectContaining({ tabId: 'a', openedAt: 1_000, viewedAt: 1_000, unviewed: false }),
      expect.objectContaining({ tabId: 'b', openedAt: 5, viewedAt: 6, unviewed: true }),
    ]);
  });
});

describe('drawer operations', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC' };
  const three = () => [fileTab('a', '/a.md'), fileTab('b', '/b.md'), fileTab('c', '/c.md')];

  it('ReorderIsPublishedAndReported', async () => {
    const h = await started(files, three());
    await h.controller.reorder(['c', 'a', 'b']);
    expect(h.ids()).toEqual(['c', 'a', 'b']);
    expect(h.active()).toBe('a');
    expect(h.deps.settled).toHaveBeenCalledTimes(1);
  });

  it('ReorderIgnoresAnOrderThatIsNotAPermutation', async () => {
    const h = await started(files, three());
    await h.controller.reorder(['c', 'a']);
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.deps.settled).not.toHaveBeenCalled();
  });

  it('TextOfAnswersFromTheLiveViewAndTheCache_NeverFromDisk', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md'), untitledTab('u', 'draft')]);
    const reads = vi.mocked(h.deps.disk.read).mock.calls.length;
    expect(h.controller.textOf('a')).toBe('AAAA');
    expect(h.controller.textOf('b')).toBeNull();
    expect(h.controller.textOf('u')).toBe('draft');
    await h.controller.activate('b');
    expect(h.controller.textOf('a')).toBe('AAAA');
    expect(h.controller.textOf('b')).toBe('BBBB');
    expect(h.controller.textOf('ghost')).toBeNull();
    expect(vi.mocked(h.deps.disk.read).mock.calls.length).toBe(reads + 1);
  });

  it('CloseTabsClosesBackgroundTabsBeforeTheActiveOne', async () => {
    const h = await started(files, three());
    await h.controller.closeTabs(['a', 'c']);
    expect(h.ids()).toEqual(['b']);
    expect(h.active()).toBe('b');
    expect(h.calls.indexOf('close c')).toBeLessThan(h.calls.indexOf('close a'));
    expect(h.calls.filter((c) => c === 'swap')).toHaveLength(1);
  });

  it('CloseTabsLeavesAnActiveTabWhoseSaveDidNotLand_TheBackgroundOnesStillGo', async () => {
    // Background tabs are clean by construction, so the only one that can
    // refuse is the active one — and it goes last.
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');

    await h.controller.closeTabs(['a', 'b', 'c']);

    expect(h.ids()).toEqual(['a']);
    expect(h.active()).toBe('a');
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(h.deps.rust.close).not.toHaveBeenCalledWith('a', expect.anything());
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
    expect(h.live().doc.toString()).toBe('AAAAunsaved');
  });

  it('CloseTabsSkipsIdsItDoesNotHave', async () => {
    const h = await started(files, three());
    await h.controller.closeTabs(['ghost', 'b']);
    expect(h.ids()).toEqual(['a', 'c']);
  });

  it('DetachTabsReleasesInsteadOfClosing', async () => {
    const h = await started(files, three());
    expect(await moveOut(h, ['b'])).toEqual(['/b.md']);
    expect(h.ids()).toEqual(['a', 'c']);
    expect(h.deps.rust.release).toHaveBeenCalledWith('b');
    expect(h.deps.rust.close).not.toHaveBeenCalled();
  });

  it('DetachingTheActiveTabHandsItOverAndSwitchesFirst', async () => {
    const h = await started(files, three());
    expect(await moveOut(h, ['a'])).toEqual(['/a.md']);
    expect(h.active()).toBe('b');
    expect(h.calls.indexOf('swap')).toBeLessThan(h.calls.indexOf('release a'));
    expect(h.deps.rust.close).not.toHaveBeenCalled();
  });

  it('DetachNeverEmptiesTheWindow', async () => {
    const h = await started(files, three());
    expect(await moveOut(h, ['a', 'b', 'c'])).toEqual(['/b.md', '/c.md']);
    expect(h.ids()).toEqual(['a']);
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
  });

  it('DetachLeavesUntitledTabsWhereTheyAre', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), untitledTab('u', 'draft'), fileTab('b', '/b.md')]);
    expect(await moveOut(h, ['u', 'b'])).toEqual(['/b.md']);
    expect(h.ids()).toEqual(['a', 'u']);
  });

  it('DetachKeepsAnActiveTabWhoseSaveDidNotLand', async () => {
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');

    expect(await moveOut(h, ['a', 'b'])).toEqual(['/b.md']);

    expect(h.ids()).toEqual(['a', 'c']);
    expect(h.active()).toBe('a');
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(h.deps.rust.release).not.toHaveBeenCalledWith('a');
    expect(h.live().doc.toString()).toBe('AAAAunsaved');
  });

  it('DetachKeepsTheActiveTabWhenNoOtherTabCanBeShown', async () => {
    // Every neighbour is unreadable: releasing the active tab would close the window.
    const h = await started(files, three());
    h.unreadable.add('/b.md');
    h.unreadable.add('/c.md');

    expect(await moveOut(h, ['a'])).toEqual([]);

    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.deps.rust.release).not.toHaveBeenCalled();
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
  });

  it('ARefusedDetachLeavesTheAgentsPausesAlone', async () => {
    const h = await started(files, three());
    h.unreadable.add('/b.md');
    h.unreadable.add('/c.md');

    await moveOut(h, ['a']);

    expect(h.deps.comments.flush).not.toHaveBeenCalled();
    expect(h.deps.comments.commitPauses).not.toHaveBeenCalled();
  });

  it('DetachOpensAWindowForWhatItReleasedEvenIfALaterTabFails', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.release).mockImplementation(async (tabId: string) => {
      if (tabId === 'c') throw new Error('ipc down');
    });
    // Rust never let go of it: it still answers with the old id.
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'this-window', tabId: 'c' });

    expect(await moveOut(h, ['b', 'c'])).toEqual(['/b.md']);
    // Taken off the list before its release threw — and put back.
    expect(h.ids()).toEqual(['a', 'c']);
  });

  it('ATabRustStillHoldsForThisWindowGetsNoWindow_ItComesBack', async () => {
    // A release whose IPC failed is swallowed (logged) on the App side, so the
    // controller sees a success; a window opened now would only focus this one.
    const h = await started(files, three());
    h.owners.set('/b.md', { kind: 'this-window', tabId: 'b' });
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'this-window', tabId: 'b' });

    const stranded = await h.controller.moveToNewWindows(['b', 'c']);

    expect(stranded).toEqual([{ path: '/b.md', error: null }]);
    expect(vi.mocked(h.deps.rust.openWindow).mock.calls.map(([p]) => p)).toEqual(['/c.md']);
    expect(h.ids()).toEqual(['a', 'b']);
  });

  it('EachDetachedTabGetsItsWindowAfterItWasReleased', async () => {
    const h = await started(files, three());
    await moveOut(h, ['b', 'c']);
    expect(h.calls.indexOf('release b')).toBeLessThan(h.calls.indexOf('openWindow /b.md'));
    expect(h.calls.indexOf('release c')).toBeLessThan(h.calls.indexOf('openWindow /c.md'));
  });

  it('ATabWhoseWindowDidNotOpenComesBackWhereItWas_InTheBackground', async () => {
    // Released and then no window: without this the tab is gone from every
    // window at once (D-a).
    const h = await started(files, three());
    await h.controller.activate('b');
    vi.mocked(h.deps.rust.openWindow).mockImplementation(async (path: string) => {
      if (path === '/b.md') throw new Error('window build failed');
    });
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'created', tabId: 'b2' });

    const stranded = await h.controller.moveToNewWindows(['b', 'c']);

    expect(stranded).toEqual([{ path: '/b.md', error: 'window build failed' }]);
    expect(h.deps.rust.open).toHaveBeenCalledWith('/b.md');
    expect(h.ids()).toEqual(['a', 'b2']);
    expect(h.controller.list.tabs[1]).toMatchObject({ path: '/b.md', dirty: false });
    expect(h.active()).toBe('a');
    expect(h.deps.settled).toHaveBeenCalled();
  });

  it('ABroughtBackTabKeepsItsStampsAndOpensAtItsOldCaret', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), { ...fileTab('b', '/b.md'), cursor: 3 }, fileTab('c', '/c.md')]);
    h.clock.now = 5_000;
    await h.controller.activate('b');
    await h.controller.activate('a');
    const before = h.controller.list.tabs.find((t) => t.id === 'b');
    vi.mocked(h.deps.rust.openWindow).mockRejectedValue(new Error('no'));
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'created', tabId: 'b2' });

    await h.controller.moveToNewWindows(['b']);
    const back = h.controller.list.tabs.find((t) => t.id === 'b2');
    expect(back).toMatchObject({ openedAt: before?.openedAt, viewedAt: before?.viewedAt, unviewed: before?.unviewed });

    vi.mocked(h.deps.editor.applyPosition).mockClear();
    await h.controller.activate('b2');
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.deps.editor.applyPosition).toHaveBeenCalledWith({ cursor: 3, topLine: 1 });
  });

  it('SeveralStrandedTabsComeBackInTheirOldOrder', async () => {
    const four = [...three(), fileTab('d', '/d.md')];
    const h = await started({ ...files, '/d.md': 'DDDD' }, four);
    vi.mocked(h.deps.rust.openWindow).mockRejectedValue(new Error('no'));

    await h.controller.moveToNewWindows(['b', 'd', 'a']);

    expect(h.controller.list.tabs.map((t) => t.path)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
  });

  it('AStrandedTabSomeoneElseClaimedMeanwhileIsNotAddedTwice', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.openWindow).mockRejectedValue(new Error('no'));
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'other-window', label: 'editor-3' });

    expect(await h.controller.moveToNewWindows(['b'])).toEqual([{ path: '/b.md', error: 'no' }]);
    expect(h.ids()).toEqual(['a', 'c']);
  });

  it('AReorderQueuedAfterACloseWithTheOldOrderIsIgnored', async () => {
    const h = await started(files, three());

    const closing = h.controller.closeTabs(['b']);
    const reordering = h.controller.reorder(['c', 'b', 'a']);
    await Promise.all([closing, reordering]);

    expect(h.ids()).toEqual(['a', 'c']);
  });
});

describe('agent hooks', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB' };
  const meta = (h: Harness, id: string) => h.controller.list.tabs.find((t) => t.id === id);

  it('LeavingATabParksItsAsksBeforeTheStrip_AndMarksItUnviewed', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    h.parkOnLeave.add('a');
    await h.controller.openPath('/b.md');
    expect(h.calls.indexOf('leave a')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('leave a')).toBeLessThan(h.calls.indexOf('strip'));
    expect(meta(h, 'a')?.unviewed).toBe(true);
  });

  it('ATabThatParkedNothingIsNotMarked', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    expect(meta(h, 'a')?.unviewed).toBe(false);
  });

  it('ShowingATabDeliversWhatWaitsForIt_AfterRustKnowsItIsActive', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    h.calls.length = 0;
    await h.controller.activate('a');
    expect(h.calls.indexOf('activate a')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('activate a')).toBeLessThan(h.calls.indexOf('enter a'));
  });

  it('ClosingATabForgetsWhatWaitsForIt_BackgroundOrActive', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.closeTabs(['a']);
    expect(h.calls).toContain('forget a');
    // Rust still answers the agents: `tab_close` fails them with `tab closed`.
    expect(h.calls).toContain('close a');
    await h.controller.closeActive();
    expect(h.calls).toContain('forget t1');
    expect(h.calls).toContain('close t1');
    expect(h.deps.ai.leave, 'a closed tab parks nothing').not.toHaveBeenCalledWith('t1');
  });

  it('ATabMovedToAnotherWindowIsForgottenAndReleased', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    await h.controller.moveToNewWindows(['b']);
    // `tab_release` fails its agents with `tab released`.
    expect(h.calls.indexOf('forget b')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('forget b')).toBeLessThan(h.calls.indexOf('release b'));
  });

  it('TheBlankTabAFileReplacesIsForgotten', async () => {
    const h = await started(files, [untitledTab('u')]);
    await h.controller.openPath('/a.md');
    expect(h.calls).toContain('forget u');
    expect(h.deps.ai.leave).not.toHaveBeenCalled();
  });
});

describe('agent operations', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB' };
  const meta = (h: Harness, id: string) => h.controller.list.tabs.find((t) => t.id === id);
  const exclusive = <T>(h: Harness, fn: () => Promise<T>) => h.controller.runExclusive(fn);
  const prependX = (s: EditorState) => ({ state: s.update({ changes: { from: 0, insert: 'X' } }).state, result: 'done' });

  it('OpenBackgroundAddsATabWithoutSwitching', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    const opened = await exclusive(h, () => h.controller.openBackgroundNow('/b.md'));
    expect(opened).toEqual({ kind: 'opened', tabId: 't1', text: 'BBBB' });
    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.active()).toBe('a');
    expect(h.swaps).toHaveLength(0);
    expect(h.deps.rust.activate).not.toHaveBeenCalled();
    expect(meta(h, 't1')?.unviewed).toBe(true);
    expect(h.deps.settled).toHaveBeenCalled();
    await h.controller.activate('t1');
    expect(h.live().doc.toString()).toBe('BBBB');
  });

  it('OpenBackgroundAnswersWhereTheFileAlreadyIs_OrThatItCannot', async () => {
    const h = await started({ ...files, '/bad.md': 'x' }, [fileTab('a', '/a.md')]);
    expect(await exclusive(h, () => h.controller.openBackgroundNow('/a.md'))).toEqual({ kind: 'existing', tabId: 'a' });
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'other-window', label: 'editor-2' });
    expect(await exclusive(h, () => h.controller.openBackgroundNow('/b.md'))).toEqual({ kind: 'other-window', label: 'editor-2' });
    h.unreadable.add('/bad.md');
    expect(await exclusive(h, () => h.controller.openBackgroundNow('/bad.md'))).toEqual({ kind: 'failed' });
    expect(h.ids()).toEqual(['a']);
  });

  it('OpenBackgroundTakesThePathAsRustRegisteredIt', async () => {
    const h = await started({ ...files, '/tmp/c.md': 'CCCC' }, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'created', tabId: 't9', path: '/private/tmp/c.md' });
    await exclusive(h, () => h.controller.openBackgroundNow('/tmp/c.md'));
    expect(meta(h, 't9')?.path).toBe('/private/tmp/c.md');
  });

  it('APlacedCaretIsWhereANeverShownTabOpens', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await exclusive(h, async () => {
      await h.controller.openBackgroundNow('/b.md');
      expect(h.controller.placeCaretNow('t1', { cursor: 2, topLine: 1 })).toBe(true);
    });
    await h.controller.activate('t1');
    expect(h.deps.editor.applyPosition).toHaveBeenLastCalledWith({ cursor: 2, topLine: 1 });
    expect(h.live().selection.main.head).toBe(2);
  });

  it('APlacedCaretIsWhereACachedTabComesBack_ScrolledThereNotWhereItWasLeft', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    await exclusive(h, async () => {
      h.controller.placeCaretNow('t1', { cursor: 3, topLine: 1 });
    });
    await h.controller.activate('t1');
    expect(h.swaps[h.swaps.length - 1]?.opts).toEqual({ blur: false, scroll: 'top' });
    expect(h.deps.editor.applyPosition).toHaveBeenLastCalledWith({ cursor: 3, topLine: 1 });
    expect(h.live().selection.main.head).toBe(3);
  });

  it('APlacedCaretIsUsedOnce', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    await exclusive(h, async () => {
      h.controller.placeCaretNow('t1', { cursor: 3, topLine: 1 });
    });
    await h.controller.activate('t1');
    await h.controller.activate('a');
    vi.mocked(h.deps.editor.applyPosition).mockClear();
    await h.controller.activate('t1');
    expect(h.deps.editor.applyPosition, 'back where it was left, not at the old placement').not.toHaveBeenCalled();
  });

  it('PlaceCaretRefusesTheActiveTab', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    expect(await exclusive(h, async () => h.controller.placeCaretNow('a', { cursor: 1, topLine: 1 }))).toBe(false);
  });

  it('AnEditOfACachedTabIsWrittenAtOnce_AndThatStateComesBack', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    const result = await exclusive(h, () => h.controller.applyToTabNow('t1', prependX));
    expect(result).toEqual({ kind: 'applied', result: 'done' });
    expect(h.files.get('/b.md')).toBe('XBBBB');
    await h.controller.activate('t1');
    expect(h.live().doc.toString()).toBe('XBBBB');
    expect(h.swaps[h.swaps.length - 1]?.opts.blur, 'the cached state, not a reload').toBe(false);
  });

  it('AnEditOfANeverShownTabStartsFromTheDisk', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await exclusive(h, async () => {
      await h.controller.openBackgroundNow('/b.md');
      await h.controller.applyToTabNow('t1', prependX);
    });
    expect(h.files.get('/b.md')).toBe('XBBBB');
    await h.controller.activate('t1');
    expect(h.live().doc.toString()).toBe('XBBBB');
  });

  it('AnEditOfACachedTabWhoseFileMovedOnStartsFromTheDisk', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    h.files.set('/b.md', 'NEW');
    await exclusive(h, () => h.controller.applyToTabNow('t1', prependX));
    expect(h.files.get('/b.md')).toBe('XNEW');
  });

  it('AFailedWriteChangesNothing', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    h.setWriteFails(true);
    const result = await exclusive(h, () => h.controller.applyToTabNow('t1', prependX));
    expect(result).toEqual({ kind: 'failed', error: 'EACCES' });
    expect(h.files.get('/b.md')).toBe('BBBB');
    await h.controller.activate('t1');
    expect(h.live().doc.toString()).toBe('BBBB');
  });

  it('ApplyRefusesTheActiveTabAndUntitledOnes_AndReportsNoChange', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), untitledTab('u', 'draft')]);
    expect((await exclusive(h, () => h.controller.applyToTabNow('a', prependX)))?.kind).toBe('failed');
    expect((await exclusive(h, () => h.controller.applyToTabNow('u', prependX)))?.kind).toBe('failed');
    await h.controller.openPath('/b.md');
    expect(await exclusive(h, () => h.controller.applyToTabNow('a', () => null))).toEqual({ kind: 'unchanged' });
    expect(h.deps.disk.write).not.toHaveBeenCalled();
  });

  it('ClosingTheLastTabAnswersTheAgentBeforeTheWindowCloses', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    const closed = await exclusive(h, () =>
      h.controller.closeTabNow('a', async () => {
        h.calls.push('answered');
      })
    );
    expect(closed).toBe(true);
    expect(h.calls.indexOf('answered')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('answered')).toBeLessThan(h.calls.indexOf('closeWindow'));
  });

  it('CloseTabNowRefusesAnActiveTabWhoseSaveDidNotLand', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    h.setSaveSucceeds(false);
    h.type('x');
    expect(await exclusive(h, () => h.controller.closeTabNow('a'))).toBe(false);
    expect(h.ids()).toEqual(['a', 'b']);
    expect(h.deps.rust.close).not.toHaveBeenCalled();
  });

  it('TextForAgentReadsTheLiveViewOrTheDisk', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    await exclusive(h, async () => {
      expect(await h.controller.textForAgentNow('a')).toBe('AAAA');
      expect(await h.controller.textForAgentNow('b')).toBe('BBBB');
      expect(await h.controller.textForAgentNow('ghost')).toBeNull();
    });
  });

  it('OpenPathNowSaysWhetherItOpenedTheTab_WhichIsWhatAQuickLookNeeds', async () => {
    // Rust's `fresh` is false when the tab lands in an existing window: only
    // this answer tells the command that it opened the tab itself (D17).
    const h = await started({ ...files, '/c.md': 'CCCC' }, [fileTab('a', '/a.md')]);
    expect(await exclusive(h, () => h.controller.openPathNow('/b.md'))).toEqual({ kind: 'opened', tabId: 't1' });
    expect(h.active()).toBe('t1');
    expect(await exclusive(h, () => h.controller.openPathNow('/a.md'))).toEqual({ kind: 'shown', tabId: 'a' });
    expect(await exclusive(h, () => h.controller.openPathNow('/a.md')), 'already active').toEqual({
      kind: 'shown',
      tabId: 'a',
    });
    h.owners.set('/c.md', { kind: 'other-window' });
    expect(await exclusive(h, () => h.controller.openPathNow('/c.md'))).toEqual({ kind: 'elsewhere' });
  });

  it('OpenPathNowIntoTheBlankTabOfAnUntouchedWindowIsAnOpen', async () => {
    const h = await started(files, [untitledTab('u')]);
    expect(await exclusive(h, () => h.controller.openPathNow('/a.md'))).toEqual({ kind: 'opened', tabId: 't1' });
    expect(h.ids()).toEqual(['t1']);
  });

  it('OpenPathNowReportsARefusal_AndAnUnreadableFile', async () => {
    const h = await started({ ...files, '/bad.md': 'x' }, [fileTab('a', '/a.md')]);
    h.unreadable.add('/bad.md');
    expect(await exclusive(h, () => h.controller.openPathNow('/bad.md'))).toEqual({ kind: 'failed' });
    h.setSaveSucceeds(false);
    h.type('x');
    expect(await exclusive(h, () => h.controller.openPathNow('/b.md'))).toEqual({ kind: 'refused' });
    expect(h.active()).toBe('a');
  });

  it('EveryAgentOperationIsRefusedOutsideTheExclusiveSlot', async () => {
    const h = await started({ ...files, '/c.md': 'CCCC' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    vi.mocked(console.error).mockClear();

    expect(await h.controller.openBackgroundNow('/c.md')).toEqual({ kind: 'failed' });
    expect(h.controller.placeCaretNow('t1', { cursor: 1, topLine: 1 })).toBe(false);
    expect((await h.controller.applyToTabNow('t1', prependX)).kind).toBe('failed');
    expect(await h.controller.closeTabNow('t1')).toBe(false);
    expect(await h.controller.openPathNow('/c.md')).toEqual({ kind: 'failed' });

    expect(h.ids()).toEqual(['a', 't1']);
    expect(h.active()).toBe('a');
    expect(h.files.get('/b.md')).toBe('BBBB');
    for (const name of ['openBackgroundNow', 'placeCaretNow', 'applyToTabNow', 'closeTabNow', 'openPathNow']) {
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(name));
    }
  });

  it('AnEditOfACachedTabWhoseFileWasDeletedStartsFromTheCachedText', async () => {
    // As `prepare` does: an empty state on that path would write over the
    // last copy of the text, and its undo history with it.
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    await h.controller.activate('a');
    h.files.delete('/b.md');
    let seen: string | null = null;
    await exclusive(h, async () => {
      expect(await h.controller.textForAgentNow('t1')).toBe('BBBB');
      await h.controller.applyToTabNow('t1', (s) => {
        seen = s.doc.toString();
        return prependX(s);
      });
    });
    expect(seen).toBe('BBBB');
    expect(h.files.get('/b.md')).toBe('XBBBB');
  });

  it('AFailingDeliveryStillSettlesTheSwitch', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/b.md');
    vi.mocked(h.deps.ai.enter).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(h.deps.settled).mockClear();
    expect(await h.controller.activate('a')).toBe('ok');
    expect(h.deps.settled).toHaveBeenCalled();
    expect(h.deps.entered).toHaveBeenCalledWith('/a.md', false);
    expect(h.deps.comments.reload).toHaveBeenCalled();
  });

  it('CloseTabNowNeverClosesAnUntitledTab', async () => {
    // Spec §8: an agent's `close` never takes an untitled tab with text.
    const h = await started(files, [untitledTab('u', 'draft'), fileTab('a', '/a.md')], 'a');
    expect(await exclusive(h, () => h.controller.closeTabNow('u'))).toBe(false);
    await h.controller.activate('u');
    expect(await exclusive(h, () => h.controller.closeTabNow('u')), 'active or not').toBe(false);
    expect(h.ids()).toEqual(['u', 'a']);
    expect(h.deps.rust.close).not.toHaveBeenCalled();
  });

  it('TheSlotClosesEvenWhenTheCommandThrows', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    await h.controller.runExclusive(async () => {
      throw new Error('boom');
    });
    h.controller.markUnviewedNow('b');
    expect(meta(h, 'b')?.unviewed).toBe(false);
  });
});

describe('quick looks', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC' };
  const meta = (h: Harness, id: string) => h.controller.list.tabs.find((t) => t.id === id);
  /** What a `show(transient)` hands over: the result that says it opened the tab. */
  const openedBy = (r: BackgroundOpen | OpenPathResult): QuickLookOrigin => {
    if (r.kind !== 'opened') throw new Error(`the command did not open a tab: ${r.kind}`);
    return r;
  };

  /** Opens `path` in the background and makes it a quick look, as `show(transient, focus: false)` does. */
  async function backgroundQuickLook(h: Harness, path: string): Promise<void> {
    await h.controller.runExclusive(async () => {
      h.controller.markTransientNow(openedBy(await h.controller.openBackgroundNow(path)));
    });
  }

  /**
   * `/b.md` (t1) and `/c.md` (t2) opened as quick looks in the background —
   * each right after the active tab, so the order is a, t2, t1 — both seen
   * at 10 000, `a` active again.
   */
  async function seenQuickLooks(h: Harness): Promise<void> {
    await backgroundQuickLook(h, '/b.md');
    await backgroundQuickLook(h, '/c.md');
    h.clock.now = 10_000;
    await h.controller.activate('t1');
    await h.controller.activate('t2');
    await h.controller.activate('a');
  }

  it('AQuickLookInTheBackgroundIsUnseen_ItsHourStartsWhenItIsSeen', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await backgroundQuickLook(h, '/b.md');
    expect(meta(h, 't1')).toMatchObject({ transient: true, transientSeenAt: 0 });
    h.clock.now = 5_000;
    await h.controller.activate('t1');
    expect(meta(h, 't1')?.transientSeenAt).toBe(5_000);
  });

  it('AQuickLookInAnUnfocusedWindowStartsItsHourWhenTheWindowGetsFocus', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await backgroundQuickLook(h, '/b.md');
    h.clock.focused = false;
    await h.controller.activate('t1');
    expect(meta(h, 't1')?.transientSeenAt, 'active, but nobody is looking').toBe(0);
    h.clock.focused = true;
    h.clock.now = 6_000;
    await h.controller.windowFocusChanged(true);
    expect(meta(h, 't1')?.transientSeenAt).toBe(6_000);
  });

  it('AQuickLookOpenedInFrontOfTheHumanIsSeenAtOnce', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    h.clock.now = 3_000;
    await h.controller.runExclusive(async () => {
      h.controller.markTransientNow(openedBy(await h.controller.openPathNow('/b.md')));
    });
    expect(meta(h, 't1')).toMatchObject({ transient: true, transientSeenAt: 3_000 });
  });

  it('ATabTheHumanAlreadyHadIsNotOpenedByTheShow', async () => {
    // D17: `show` answers `shown` for it, which `markTransientNow` does not take.
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    const result = await h.controller.runExclusive(() => h.controller.openPathNow('/b.md'));
    expect(result).toEqual({ kind: 'shown', tabId: 'b' });
    if (result?.kind !== 'shown') throw new Error('unreachable');
    // Pinned at the type level: a `shown` answer is not a QuickLookOrigin.
    // (Called outside the slot, so at run time it is refused anyway.)
    // @ts-expect-error — D17: only a tab the command opened becomes a quick look.
    h.controller.markTransientNow(result);
    expect(meta(h, 'b')?.transient).toBeFalsy();
  });

  it('OnlyFileTabsBecomeQuickLooks_AndMarkingAgainKeepsTheFirstClock', async () => {
    const h = await started(files, [untitledTab('u', 'x'), fileTab('a', '/a.md')]);
    await h.controller.runExclusive(async () => {
      h.controller.markTransientNow({ kind: 'fresh', tabId: 'u' });
      h.controller.markTransientNow({ kind: 'fresh', tabId: 'a' });
    });
    expect(meta(h, 'u')?.transient).toBeFalsy();
    const first = meta(h, 'a')?.transientSeenAt;
    h.clock.now += 1_000;
    await h.controller.runExclusive(async () => h.controller.markTransientNow({ kind: 'fresh', tabId: 'a' }));
    expect(meta(h, 'a')?.transientSeenAt).toBe(first);
  });

  it('MarkingIsRefusedOutsideRunExclusive', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    h.controller.markTransientNow({ kind: 'fresh', tabId: 'a' });
    expect(meta(h, 'a')?.transient).toBeFalsy();
    expect(console.error).toHaveBeenCalled();
  });

  it('KeepMakesItAnOrdinaryTab_CloseClosesItTheCmdWWay', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await seenQuickLooks(h);
    await h.controller.keepTransient('t1');
    expect(meta(h, 't1')).toMatchObject({ transient: false, transientSeenAt: 0 });
    await h.controller.closeTransient('t2');
    expect(h.deps.rust.close).toHaveBeenCalledWith('t2', expect.anything());
    expect(h.ids()).toEqual(['a', 't1']);
  });

  it('CloseLeavesAnOrdinaryTabAlone', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
    await h.controller.closeTransient('b');
    expect(h.ids()).toEqual(['a', 'b']);
  });

  it('AnHourAfterBeingSeen_TheKeepPolicyKeepsThem', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await seenQuickLooks(h);
    h.clock.now = 10_000 + TRANSIENT_IGNORED_AFTER_MS;
    await h.controller.expireTransients('keep');
    expect(h.ids()).toEqual(['a', 't2', 't1']);
    expect([meta(h, 't1')?.transient, meta(h, 't2')?.transient]).toEqual([false, false]);
  });

  it('AnHourAfterBeingSeen_TheClosePolicyClosesThem', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await seenQuickLooks(h);
    h.clock.now = 10_000 + TRANSIENT_IGNORED_AFTER_MS - 1;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'not yet').toEqual(['a', 't2', 't1']);
    h.clock.now += 1;
    await h.controller.expireTransients('close');
    expect(h.ids()).toEqual(['a']);
    expect(h.deps.rust.close).toHaveBeenCalledTimes(2);
  });

  it('AnUnseenQuickLookNeverExpires_NorTheActiveOne_FocusedOrNot', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await backgroundQuickLook(h, '/b.md');
    await h.controller.runExclusive(async () => {
      h.controller.markTransientNow(openedBy(await h.controller.openPathNow('/c.md')));
    });
    h.clock.now += 3 * TRANSIENT_IGNORED_AFTER_MS;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'unseen t1 and the active, focused t2 stay').toEqual(['a', 't2', 't1']);
    // Team-lead decision (Task 10 review): the human often reads an unfocused
    // md-mini beside the agent's terminal — the active tab never expires.
    h.clock.focused = false;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'the active t2 of an unfocused window stays too').toEqual(['a', 't2', 't1']);
    await h.controller.activate('a');
    await h.controller.expireTransients('close');
    expect(h.ids(), 'in the background it expires').toEqual(['a', 't1']);
  });

  it('AQuickLookAnAgentTouchedAgainIsUnseenAgain_ItsHourStartsAgainWhenSeen', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await seenQuickLooks(h);
    await h.controller.runExclusive(async () => h.controller.markUnviewedNow('t1'));
    h.clock.now = 10_000 + TRANSIENT_IGNORED_AFTER_MS;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'unseen again: only t2 goes').toEqual(['a', 't1']);
    const seenAgain = 10_000 + 70 * 60 * 1000;
    h.clock.now = seenAgain;
    await h.controller.activate('t1');
    await h.controller.activate('a');
    expect(meta(h, 't1')?.transientSeenAt).toBe(seenAgain);
    h.clock.now = seenAgain + TRANSIENT_IGNORED_AFTER_MS - 1;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'an hour from the second view, not the first').toEqual(['a', 't1']);
    h.clock.now += 1;
    await h.controller.expireTransients('close');
    expect(h.ids()).toEqual(['a']);
  });

  it('EditingTheActiveQuickLookKeepsIt', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await seenQuickLooks(h);
    await h.controller.activate('t2');
    h.controller.humanEdited();
    expect(meta(h, 't2')).toMatchObject({ transient: false, transientSeenAt: 0 });
    expect(meta(h, 't1')?.transient, 'only the tab in the live view').toBe(true);
  });

  it('EditingIsHeardWhileAnAgentCommandHoldsTheQueue', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    await seenQuickLooks(h);
    await h.controller.activate('t2');
    let release = () => {};
    let holding = false;
    const held = h.controller.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          holding = true;
          release = resolve;
        })
    );
    await vi.waitFor(() => expect(holding).toBe(true));
    // An update listener, mid-command: synchronous, never waits for the slot.
    h.controller.humanEdited();
    expect(meta(h, 't2')?.transient).toBe(false);
    release();
    await held;
  });

  it('EditingAnOrdinaryTabChangesNothing', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    h.controller.humanEdited();
    expect(h.deps.changed).not.toHaveBeenCalled();
  });
});
