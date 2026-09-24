import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorState, StateEffect } from '@codemirror/state';
import {
  createTabController,
  FLUSH_ATTEMPTS,
  TRANSIENT_IGNORED_AFTER_MS,
  type BackgroundOpen,
  type DiskOptions,
  type InitTab,
  type MoveDone,
  type MovedTab,
  type OpenAnswer,
  type OpenPathResult,
  type QuickLookOrigin,
  type SwapOptions,
  type TabControllerDeps,
} from './controller';
import type { TabOwner } from '../switch-document';
import type { InboxItem } from './agent-inbox';
import type { MoveTarget } from './carousel';
import { applyLineEnding, fromDisk, type LineEnding } from '../line-endings';

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
  const doc = {
    path: null as string | null,
    dirty: false,
    baseline: null as string | null,
    lineEnding: 'lf' as LineEnding,
  };
  let live = EditorState.create({ doc: '' });
  let saveSucceeds = true;
  const parkOnLeave = new Set<string>();
  const inboxes = new Map<string, InboxItem[]>();
  let moveCount = 0;
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
      lineEnding: () => doc.lineEnding,
      setActive: (path, dirty, baseline, lineEnding) => {
        calls.push(`setActive ${path}`);
        doc.path = path;
        doc.dirty = dirty;
        doc.baseline = baseline;
        doc.lineEnding = lineEnding;
      },
    },
    autosave: {
      flush: vi.fn(async () => {
        calls.push('flush');
        if (saveSucceeds && doc.path !== null && doc.dirty) {
          // As App's `doSave`: the buffer's LF text, in the document's own ending.
          files.set(doc.path, applyLineEnding(live.doc.toString(), doc.lineEnding));
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
      carry: vi.fn((tabId: string): InboxItem[] => {
        calls.push(`carry ${tabId}`);
        return inboxes.get(tabId) ?? [];
      }),
      adopt: vi.fn((tabId: string, items: readonly InboxItem[]) => {
        calls.push(`adopt ${tabId} ${items.length}`);
      }),
    },
    disk: {
      exists: async (path) => files.has(path),
      read: vi.fn(async (path: string, opts?: DiskOptions) => {
        hooks.duringRead();
        if (unreadable.has(path)) throw new Error('Cannot open: file is not valid text.');
        const raw = files.get(path);
        if (raw === undefined) throw new Error('ENOENT');
        return fromDisk(raw, opts?.fallback);
      }),
      write: vi.fn(async (path: string, content: string, lineEnding: LineEnding) => {
        if (writeFails) throw new Error('EACCES');
        files.set(path, applyLineEnding(content, lineEnding));
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
      move: vi.fn(async (moving: MovedTab[], target: MoveTarget): Promise<MoveDone> => {
        calls.push(`move ${moving.map((t) => t.tabId).join(',')} → ${target.kind === 'window' ? target.label : 'new'}`);
        return { label: target.kind === 'window' ? target.label : `editor-${9 + moveCount++}`, number: 9 };
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
    inboxes,
    setWriteFails(value: boolean) {
      writeFails = value;
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

  it('SaysWhetherTheActiveTabIsABlankUntitled', async () => {
    const blank = await started(files, [untitledTab('u')]);
    expect(blank.controller.activeIsEmptyUntitled()).toBe(true);
    blank.type('draft');
    expect(blank.controller.activeIsEmptyUntitled()).toBe(false);
    const file = await started(files, [fileTab('a', '/a.md')]);
    expect(file.controller.activeIsEmptyUntitled()).toBe(false);
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

  describe('an agent refused is not the human refused (D5)', () => {
    // The human did not ask to leave the tab: an «unsaved» toast would blame
    // them for an agent's switch that simply lands in the background.
    it('ASwitchRefusedByAnUnsavedTabShowsNoToast', async () => {
      const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
      h.setSaveSucceeds(false);
      h.type('x');
      expect(await exclusive(h, () => h.controller.activateNow('b', { byAgent: true }))).toBe('refused');
      expect(await exclusive(h, () => h.controller.openPathNow('/b.md'))).toEqual({ kind: 'refused' });
      expect(await exclusive(h, () => h.controller.openPathNow('/c.md'))).toEqual({ kind: 'refused' });
      expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
      // The human's own switch still says why it did not happen.
      await h.controller.activate('b');
      expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    });

    it('AnOpenRefusedByTypingDuringTheHandoverShowsNoToast', async () => {
      const h = await started({ ...files, '/c.md': 'CCCC' }, [fileTab('a', '/a.md')]);
      h.hooks.duringCommitPauses = () => {
        h.setSaveSucceeds(false);
        h.type('late');
      };
      expect(await exclusive(h, () => h.controller.openPathNow('/c.md'))).toEqual({ kind: 'refused' });
      expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
      expect(h.active()).toBe('a');
    });

    it('ACloseRefusedByAnUnsavedTabShowsNoToast', async () => {
      const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
      h.setSaveSucceeds(false);
      h.type('x');
      expect(await exclusive(h, () => h.controller.closeTabNow('a'))).toBe(false);
      expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
      await h.controller.closeActive();
      expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    });

    it('ACloseRefusedByTypingDuringItShowsNoToast', async () => {
      const h = await started(files, [fileTab('a', '/a.md'), fileTab('b', '/b.md')]);
      h.hooks.duringCommitPauses = () => {
        h.setSaveSucceeds(false);
        h.type('late');
      };
      expect(await exclusive(h, () => h.controller.closeTabNow('a'))).toBe(false);
      expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
      expect(h.ids()).toEqual(['a', 'b']);
    });
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

describe('quick looks across a restart (tabs-questions Q8)', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC' };
  const meta = (h: Harness, id: string) => h.controller.list.tabs.find((t) => t.id === id);

  it('TheHeartbeatCarriesAQuickLooksStateIntoTheSession', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), { ...fileTab('b', '/b.md'), transient: true, transientSeenAt: 7 }], 'a');
    const { tabs } = h.controller.report({ cursor: 0, topLine: 1, content: 'AAAA' });
    expect(tabs).toEqual([
      expect.objectContaining({ tabId: 'a', transient: false, transientSeenAt: 0 }),
      expect.objectContaining({ tabId: 'b', transient: true, transientSeenAt: 7 }),
    ]);
  });

  it('ARestoredQuickLooksHourCountsFromWhenItWasFirstSeen_NotFromTheLaunch', async () => {
    const seen = 500; // the harness launches at 1 000
    const h = await started(files, [fileTab('a', '/a.md'), { ...fileTab('b', '/b.md'), transient: true, transientSeenAt: seen }], 'b');
    // Launched later, with the quick look active in a focused window: seeing it
    // again does not restart its clock.
    h.clock.now = seen + 10 * 60 * 1000;
    await h.controller.windowFocusChanged(true);
    expect(meta(h, 'b')).toMatchObject({ transient: true, transientSeenAt: seen });
    await h.controller.activate('a');
    h.clock.now = seen + TRANSIENT_IGNORED_AFTER_MS - 1;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'not yet').toEqual(['a', 'b']);
    h.clock.now += 1;
    await h.controller.expireTransients('close');
    expect(h.ids()).toEqual(['a']);
  });

  it('ExpiredWhileTheAppWasDown_TheFirstTickClosesTheBackgroundOnes_NeverTheActiveOne', async () => {
    const h = await started(
      files,
      [
        { ...fileTab('b', '/b.md'), transient: true, transientSeenAt: 1 },
        { ...fileTab('c', '/c.md'), transient: true, transientSeenAt: 1 },
        { ...fileTab('a', '/a.md'), transient: true, transientSeenAt: 0, unviewed: true },
      ],
      'b'
    );
    h.clock.now = 5 * TRANSIENT_IGNORED_AFTER_MS;
    await h.controller.expireTransients('close');
    expect(h.ids(), 'c went; b is active; a was never seen').toEqual(['b', 'a']);
    expect(h.deps.rust.close).toHaveBeenCalledWith('c', expect.anything());
  });

  it('ExpiredWhileTheAppWasDown_TheKeepPolicyMakesThemOrdinary', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), { ...fileTab('b', '/b.md'), transient: true, transientSeenAt: 1 }], 'a');
    h.clock.now = 2 * TRANSIENT_IGNORED_AFTER_MS;
    await h.controller.expireTransients('keep');
    expect(h.ids()).toEqual(['a', 'b']);
    expect(meta(h, 'b')).toMatchObject({ transient: false, transientSeenAt: 0 });
  });
});

describe('moving tabs to another window (plan 05)', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC', '/d.md': 'DDDD' };
  const three = () => [fileTab('a', '/a.md'), fileTab('b', '/b.md'), fileTab('c', '/c.md')];
  const to2: MoveTarget = { kind: 'window', label: 'editor-2' };
  const sent = (h: Harness) => vi.mocked(h.deps.rust.move).mock.calls.map(([tabs]) => tabs);
  const pulse = { kind: 'pulse', payload: { id: 9 } } as unknown as InboxItem;
  const lastActivate = (h: Harness) => h.calls.filter((c) => c.startsWith('activate ')).pop();

  it('MovesABackgroundTab_TheActiveStays_NothingIsReleasedOrClosed', async () => {
    const h = await started(files, three());
    expect(await h.controller.moveTabs(['b'], to2)).toEqual({ kind: 'moved', label: 'editor-2', number: 9, count: 1 });
    expect(h.ids()).toEqual(['a', 'c']);
    expect(h.active()).toBe('a');
    expect(h.deps.rust.release).not.toHaveBeenCalled();
    expect(h.deps.rust.close).not.toHaveBeenCalled();
    expect(h.deps.ai.forget).not.toHaveBeenCalled();
    expect(h.deps.settled).toHaveBeenCalled();
  });

  it('AGroupGoesInThisWindowsOrder', async () => {
    const h = await started(files, [...three(), fileTab('d', '/d.md')]);
    await h.controller.moveTabs(['d', 'b'], to2);
    expect(sent(h)[0].map((t) => t.tabId)).toEqual(['b', 'd']);
    expect(h.ids()).toEqual(['a', 'c']);
  });

  it('MovingTheActiveTabShowsItsRightNeighbourBeforeTheMoveIsSent', async () => {
    const h = await started(files, three());
    await h.controller.moveTabs(['a'], to2);
    expect(h.active()).toBe('b');
    expect(h.live().doc.toString()).toBe('BBBB');
    expect(h.calls.indexOf('swap')).toBeLessThan(h.calls.indexOf('move a → editor-2'));
    expect(h.calls.indexOf('move a → editor-2')).toBeLessThan(h.calls.indexOf('activate b'));
    expect(h.deps.comments.commitPauses).toHaveBeenCalledWith('/a.md');
  });

  it('AnUntitledTabGoesWithItsText_TheActiveOneWithWhatWasJustTyped', async () => {
    const h = await started(files, [untitledTab('u'), untitledTab('v', 'draft'), fileTab('b', '/b.md')]);
    h.type('typed');
    await h.controller.moveTabs(['v', 'u'], to2);
    expect(sent(h)[0].map((t) => [t.tabId, t.content])).toEqual([
      ['u', 'typed'],
      ['v', 'draft'],
    ]);
    expect(h.ids()).toEqual(['b']);
  });

  it('StampsCaretAndQuickLookGoWithIt', async () => {
    const b: InitTab = {
      ...fileTab('b', '/b.md'),
      cursor: 3,
      topLine: 2,
      openedAt: 50,
      viewedAt: 60,
      unviewed: true,
      transient: true,
      transientSeenAt: 70,
    };
    const h = await started(files, [fileTab('a', '/a.md'), b]);
    await h.controller.moveTabs(['b'], to2);
    expect(sent(h)[0]).toEqual([
      {
        tabId: 'b',
        content: null,
        cursor: 3,
        topLine: 2,
        openedAt: 50,
        viewedAt: 60,
        unviewed: true,
        transient: true,
        transientSeenAt: 70,
        inbox: [],
      },
    ]);
  });

  it('WhereAnAgentPlacedTheCaretWinsOverWhereItWas', async () => {
    const h = await started(files, [fileTab('a', '/a.md'), { ...fileTab('b', '/b.md'), cursor: 1 }]);
    await h.controller.runExclusive(async () => {
      h.controller.placeCaretNow('b', { cursor: 3, topLine: 4 });
    });
    await h.controller.moveTabs(['b'], to2);
    expect(sent(h)[0][0]).toMatchObject({ cursor: 3, topLine: 4 });
  });

  it('WhatWaitedForTheTabGoesWithIt', async () => {
    const h = await started(files, three());
    h.inboxes.set('b', [pulse]);
    await h.controller.moveTabs(['b'], to2);
    expect(sent(h)[0][0].inbox).toEqual([pulse]);
    expect(h.calls).toContain('carry b');
  });

  it('AnActiveFileTabWhoseSaveDidNotLandIsRefused_NothingMoves', async () => {
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');
    expect(await h.controller.moveTabs(['a', 'b'], to2)).toEqual({ kind: 'refused' });
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(h.deps.autosave.flush).toHaveBeenCalledTimes(FLUSH_ATTEMPTS);
    expect(h.deps.rust.move).not.toHaveBeenCalled();
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.live().doc.toString()).toBe('AAAAunsaved');
  });

  it('AnActiveFileTabJustTypedIntoIsFlushedAndMoves', async () => {
    const h = await started(files, three());
    h.type('!');
    expect(await h.controller.moveTabs(['a'], to2)).toMatchObject({ kind: 'moved' });
    expect(h.files.get('/a.md')).toBe('AAAA!');
    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
  });

  it('ASaveErrorRefusesTheMove', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.saveErrorPending).mockReturnValue(true);
    expect(await h.controller.moveTabs(['a'], to2)).toEqual({ kind: 'refused' });
    expect(h.deps.rust.move).not.toHaveBeenCalled();
  });

  it('MovingEveryTabClosesTheWindowAfterTheMove', async () => {
    const h = await started(files, three());
    const outcome = await h.controller.moveTabs(['c', 'a', 'b'], { kind: 'new-window' });
    expect(outcome).toEqual({ kind: 'moved', label: 'editor-9', number: 9, count: 3 });
    await vi.waitFor(() => expect(h.deps.rust.closeWindow).toHaveBeenCalled());
    expect(h.calls.indexOf('move a,b,c → new')).toBeLessThan(h.calls.indexOf('closeWindow'));
    expect(h.live().doc.toString()).toBe('');
    expect(h.ids()).toEqual([]);
  });

  it('WhileTheWholeWindowMovesNothingCanBeTypedIntoWhatStandsInForIt', async () => {
    const h = await started(files, three());
    let readOnly: boolean | null = null;
    vi.mocked(h.deps.rust.move).mockImplementationOnce(async () => {
      readOnly = h.live().readOnly;
      return { label: 'editor-9', number: 9 };
    });
    await h.controller.moveTabs(['a', 'b', 'c'], { kind: 'new-window' });
    expect(readOnly).toBe(true);
    expect(h.swaps[h.swaps.length - 1]?.opts.blur).toBe(true);
  });

  it('ACommandQueuedBehindAWholeWindowMoveRunsBeforeTheWindowCloses_AndIsForwardedNotRaised', async () => {
    // Rust relabelled its request to the target: closing first would leave
    // its agent waiting for nothing. Run here, it finds the file elsewhere
    // and goes on to `ai_forward` (agent-commands) — without raising the holder (D5).
    const h = await started(files, three());
    h.owners.set('/a.md', { kind: 'other-window', label: 'editor-9' });
    const moving = h.controller.moveTabs(['a', 'b', 'c'], { kind: 'new-window' });
    let answer: OpenPathResult | null = null;
    const command = h.controller.runExclusive(async () => {
      answer = await h.controller.openPathNow('/a.md');
      h.calls.push('agent ran');
    });
    await moving;
    await command;
    await vi.waitFor(() => expect(h.deps.rust.closeWindow).toHaveBeenCalled());
    expect(answer).toEqual({ kind: 'elsewhere' });
    expect(h.calls.indexOf('agent ran')).toBeLessThan(h.calls.indexOf('closeWindow'));
    expect(h.deps.rust.focusElsewhere).not.toHaveBeenCalled();
  });

  it('AnEmptiedWindowAnAgentOpenedAFileInMeanwhileStays', async () => {
    const h = await started({ ...files, '/new.md': 'NEW' }, three());
    const moving = h.controller.moveTabs(['a', 'b', 'c'], { kind: 'new-window' });
    const command = h.controller.runExclusive(() => h.controller.openPathNow('/new.md'));
    await moving;
    expect(await command).toMatchObject({ kind: 'opened' });
    await h.controller.reorder([]);
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
    expect(h.live().doc.toString()).toBe('NEW');
    expect(h.live().readOnly).toBe(false);
  });

  it('MovingTabsThisWindowNoLongerHasIsANoOp_NotAFailure', async () => {
    const h = await started(files, three());
    expect(await h.controller.moveTabs(['gone'], to2)).toEqual({ kind: 'refused' });
    expect(h.deps.rust.move).not.toHaveBeenCalled();
  });

  it('AFailedMovePutsTheTabsBackWhereTheyStood', async () => {
    const h = await started(files, three());
    h.inboxes.set('b', [pulse]);
    vi.mocked(h.deps.rust.move).mockRejectedValueOnce(new Error('window editor-2 is gone'));
    expect(await h.controller.moveTabs(['b'], to2)).toEqual({ kind: 'failed', error: 'window editor-2 is gone' });
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.calls).toContain('adopt b 1');
  });

  it('AFailedMoveEndsWithRustToldWhichTabIsActive_SoTheWatcherIsRight', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.move).mockRejectedValueOnce(new Error('no'));
    await h.controller.moveTabs(['b'], to2);
    expect(lastActivate(h)).toBe('activate a');

    h.calls.length = 0;
    vi.mocked(h.deps.rust.move).mockRejectedValueOnce(new Error('no'));
    await h.controller.moveTabs(['a'], to2);
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(lastActivate(h)).toBe(`activate ${h.active()}`);
    expect(h.calls.indexOf('move a → editor-2')).toBeLessThan(h.calls.lastIndexOf(`activate ${h.active()}`));
  });

  it('AFailedMoveOfTheWholeWindowShowsItsTabAgain', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.move).mockRejectedValueOnce(new Error('no'));
    await h.controller.moveTabs(['a', 'b', 'c'], { kind: 'new-window' });
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.live().doc.toString()).toBe('AAAA');
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
    expect(lastActivate(h)).toBe('activate a');
  });

  it('MoveToNewWindowsSendsEachTabToAWindowOfItsOwn_InListOrder_TheActiveOneLast', async () => {
    const h = await started(files, [...three(), fileTab('d', '/d.md')]);
    const outcome = await h.controller.moveToNewWindows(['d', 'a', 'c']);
    expect(h.calls.filter((c) => c.startsWith('move '))).toEqual(['move c → new', 'move d → new', 'move a → new']);
    expect(outcome?.moved.map((m) => m.label)).toEqual(['editor-9', 'editor-10', 'editor-11']);
    expect(outcome?.stranded).toEqual([]);
    expect(h.ids()).toEqual(['b']);
  });

  it('MoveToNewWindowsNeverShowsASelectedNeighbourOnTheWay', async () => {
    // Moved first, the active tab would hand the view to b — shown, seen, its
    // pulse spent — only for b to leave next.
    const h = await started(files, three());
    h.inboxes.set('b', [pulse]);
    h.swaps.length = 0;
    await h.controller.moveToNewWindows(['a', 'b']);
    expect(h.swaps.map((s) => s.state.doc.toString())).toEqual(['CCCC']);
    expect(h.calls).not.toContain('activate b');
    expect(sent(h)[0]).toEqual([expect.objectContaining({ tabId: 'b', inbox: [pulse], viewedAt: 0 })]);
    expect(h.ids()).toEqual(['c']);
    expect(h.active()).toBe('c');
  });

  it('MoveToNewWindowsNeverReleases_TheAgentsKeepWaiting_AndTheTabKeepsWhatItHad', async () => {
    const b: InitTab = { ...fileTab('b', '/b.md'), cursor: 2, openedAt: 5, transient: true, transientSeenAt: 6 };
    const h = await started(files, [fileTab('a', '/a.md'), b, untitledTab('u', 'draft')]);
    h.inboxes.set('b', [pulse]);
    await h.controller.moveToNewWindows(['b', 'u']);
    expect(h.deps.rust.release).not.toHaveBeenCalled();
    expect(h.deps.ai.forget).not.toHaveBeenCalled();
    expect(sent(h)).toEqual([
      [expect.objectContaining({ tabId: 'b', cursor: 2, openedAt: 5, transient: true, transientSeenAt: 6, inbox: [pulse] })],
      [expect.objectContaining({ tabId: 'u', content: 'draft' })],
    ]);
    expect(h.ids()).toEqual(['a']);
  });

  it('MoveToNewWindowsReportsWhatStayed', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.rust.move)
      .mockResolvedValueOnce({ label: 'editor-9', number: 9 })
      .mockRejectedValueOnce(new Error('no'));
    const outcome = await h.controller.moveToNewWindows(['b', 'c']);
    expect(outcome?.stranded).toEqual([{ path: '/c.md', error: 'no' }]);
    expect(h.ids()).toEqual(['a', 'c']);
  });

  it('MoveToNewWindowsLeavesARefusedTabToItsOwnToast', async () => {
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');
    const outcome = await h.controller.moveToNewWindows(['a', 'b']);
    expect(outcome?.stranded, 'one toast: unsaved-blocked, not also tabs-stranded').toEqual([]);
    expect(h.deps.reportUnsaved).toHaveBeenCalledTimes(1);
    expect(outcome?.moved).toHaveLength(1);
    expect(h.ids()).toEqual(['a', 'c']);
  });
});

describe('an agent open of a file another window holds (plan 05, D5)', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB' };

  it('NeverRaisesTheHolder_AHumansOpenDoes', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    h.owners.set('/b.md', { kind: 'other-window', label: 'editor-2' });
    const agent = await h.controller.runExclusive(() => h.controller.openPathNow('/b.md'));
    expect(agent).toEqual({ kind: 'elsewhere' });
    expect(h.deps.rust.focusElsewhere).not.toHaveBeenCalled();
    await h.controller.openPath('/b.md');
    expect(h.deps.rust.focusElsewhere).toHaveBeenCalledWith('/b.md');
  });

  it('NorWhenRustSaysSoOnlyAtTheClaim', async () => {
    const h = await started(files, [fileTab('a', '/a.md')]);
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'other-window', label: 'editor-2' });
    const agent = await h.controller.runExclusive(() => h.controller.openPathNow('/b.md'));
    expect(agent).toEqual({ kind: 'elsewhere' });
    expect(h.deps.rust.focusElsewhere).not.toHaveBeenCalled();
  });
});

describe('tabs arriving from another window (plan 05)', () => {
  const files = { '/a.md': 'AAAA', '/b.md': 'BBBB', '/c.md': 'CCCC', '/x.md': 'XXXX' };
  const three = () => [fileTab('a', '/a.md'), fileTab('b', '/b.md'), fileTab('c', '/c.md')];
  const meta = (h: Harness, id: string) => h.controller.list.tabs.find((t) => t.id === id);
  const ask = { kind: 'ask', payload: { id: 4 }, deadline: 9_999_999 } as unknown as InboxItem;

  it('ArrivalsGoRightAfterTheActiveTab_InOrder_AndTheFirstIsShown', async () => {
    const h = await started(files, three());
    h.clock.focused = false;
    await h.controller.arrive([fileTab('x', '/x.md'), untitledTab('y', 'note')]);
    expect(h.ids()).toEqual(['a', 'x', 'y', 'b', 'c']);
    expect(h.active()).toBe('x');
    expect(h.live().doc.toString()).toBe('XXXX');
    expect(h.deps.rust.activate).toHaveBeenCalledWith('x');
    expect(h.deps.rust.open, 'Rust registered them already').not.toHaveBeenCalled();
    expect(meta(h, 'y')?.dirty, 'an untitled tab with text').toBe(true);
  });

  it('ArrivalsKeepTheirStampsAndQuickLook', async () => {
    const h = await started(files, three());
    h.clock.focused = false;
    await h.controller.arrive([
      { ...fileTab('x', '/x.md'), openedAt: 7, viewedAt: 8, unviewed: true, transient: true, transientSeenAt: 9 },
    ]);
    expect(meta(h, 'x')).toMatchObject({ openedAt: 7, viewedAt: 8, unviewed: true, transient: true, transientSeenAt: 9 });
  });

  it('WhatWaitedArrivesInTheInboxBeforeTheTabIsEntered', async () => {
    const h = await started(files, three());
    await h.controller.arrive([{ ...fileTab('x', '/x.md'), inbox: [ask] }]);
    expect(h.calls.indexOf('adopt x 1')).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('adopt x 1')).toBeLessThan(h.calls.indexOf('enter x'));
  });

  it('AWindowThatMayNotLeaveItsTabKeepsArrivalsInTheBackground_Quietly', async () => {
    const h = await started(files, three());
    h.setSaveSucceeds(false);
    h.type('unsaved');
    await h.controller.arrive([fileTab('x', '/x.md')]);
    expect(h.ids()).toEqual(['a', 'x', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.deps.reportUnsaved).not.toHaveBeenCalled();
    expect(h.deps.settled).toHaveBeenCalled();
  });

  it('ABlankUntitledGivesWayToArrivals', async () => {
    const h = await started(files, [untitledTab('u')]);
    await h.controller.arrive([fileTab('x', '/x.md')]);
    expect(h.ids()).toEqual(['x']);
    expect(h.calls).toContain('release u');
  });

  it('ANewWindowThatMountedBeforeTheMove_ItsBlankUntitledGivesWayToTheEvent', async () => {
    // Built for the move, it called get_window_init before `tab_move` took the
    // lock: an empty init (a blank Untitled of its own), then `tabs-arrive`.
    const h = makeHarness(files);
    await h.controller.init([], null);
    expect(h.ids()).toEqual(['t1']);
    await h.controller.arrive([untitledTab('y', 'note'), fileTab('x', '/x.md')]);
    expect(h.ids()).toEqual(['y', 'x']);
    expect(h.active()).toBe('y');
    expect(h.live().doc.toString()).toBe('note');
    expect(h.calls).toContain('release t1');
    expect(h.deps.rust.closeWindow).not.toHaveBeenCalled();
  });

  it('AnUntitledTypedIntoDoesNotGiveWay', async () => {
    const h = await started(files, [untitledTab('u')]);
    h.type('mine');
    await h.controller.arrive([fileTab('x', '/x.md')]);
    expect(h.ids()).toEqual(['u', 'x']);
    expect(h.deps.rust.release).not.toHaveBeenCalled();
  });

  it('ANewWindowsInitCarriesQuickLookAndInbox', async () => {
    const h = makeHarness(files);
    await h.controller.init([{ ...fileTab('x', '/x.md'), transient: true, transientSeenAt: 5, inbox: [ask] }], 'x');
    expect(meta(h, 'x')).toMatchObject({ transient: true, transientSeenAt: 5 });
    expect(h.calls).toContain('adopt x 1');
  });

  it('AnAgentsQuestionOnScreenKeepsTheView_ArrivalsWaitInTheBackground', async () => {
    const h = await started(files, three());
    vi.mocked(h.deps.ai.hasLiveAsk).mockReturnValue(true);
    await h.controller.arrive([{ ...fileTab('x', '/x.md'), inbox: [ask] }]);
    expect(h.ids()).toEqual(['a', 'x', 'b', 'c']);
    expect(h.active()).toBe('a');
    expect(h.calls).not.toContain('swap');
    expect(h.deps.ai.leave).not.toHaveBeenCalled();
    expect(h.calls).toContain('adopt x 1');
    expect(h.deps.settled).toHaveBeenCalled();
  });

  it('AnArrivalThisWindowAlreadyHasIsIgnored', async () => {
    const h = await started(files, three());
    await h.controller.arrive([fileTab('b', '/b.md')]);
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    expect(h.deps.rust.activate).not.toHaveBeenCalled();
  });
});

describe('line endings', () => {
  const crlf = 'one\r\ntwo\r\n';
  const exclusive = <T>(h: Harness, fn: () => Promise<T>) => h.controller.runExclusive(fn);
  const prependX = (s: EditorState) => ({ state: s.update({ changes: { from: 0, insert: 'X' } }).state, result: null });

  it('ACrlfTabSwitchedAwayFlushesAsCrlf', async () => {
    // The wiring the CRLF port hangs on: read → Ready → Entry → setActive,
    // then the flush on leave writes in the ending the tab carried.
    const h = await started({ '/a.md': 'AAAA', '/win.md': crlf }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/win.md');
    expect(h.live().doc.toString()).toBe('one\ntwo\n');
    expect(h.doc.lineEnding).toBe('crlf');
    h.type('three');
    await h.controller.activate('a');
    expect(h.files.get('/win.md')).toBe('one\r\ntwo\r\nthree');
    expect(h.doc.lineEnding).toBe('lf');
  });

  it('TheEndingTravelsWithTheTab_NotWithTheSpellingItWasOpenedUnder', async () => {
    // Opened as `/tmp/x.md`, registered by Rust as `/private/tmp/x.md`: one
    // file under two spellings. A table keyed by the caller's spelling found
    // nothing for the registry's, and the first autosave wrote LF.
    const h = await started({ '/a.md': 'AAAA', '/tmp/x.md': crlf, '/private/tmp/x.md': crlf }, [
      fileTab('a', '/a.md'),
    ]);
    vi.mocked(h.deps.rust.open).mockResolvedValueOnce({ kind: 'created', tabId: 't9', path: '/private/tmp/x.md' });
    await h.controller.openPath('/tmp/x.md');
    expect(h.doc.path).toBe('/private/tmp/x.md');
    expect(h.doc.lineEnding).toBe('crlf');
    h.type('!');
    await h.controller.activate('a');
    expect(h.files.get('/private/tmp/x.md')).toBe('one\r\ntwo\r\n!');
  });

  it('ACachedCrlfTabComesBackCrlf', async () => {
    const h = await started({ '/a.md': 'AAAA', '/win.md': crlf }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/win.md');
    await h.controller.activate('a');
    await h.controller.activate('t1');
    expect(h.swaps[h.swaps.length - 1]?.opts.blur).toBe(false);
    expect(h.doc.lineEnding).toBe('crlf');
  });

  it('AnAgentsBackgroundEditOfACrlfFileWritesCrlf', async () => {
    const h = await started({ '/a.md': 'AAAA', '/win.md': crlf }, [fileTab('a', '/a.md')]);
    await exclusive(h, () => h.controller.openBackgroundNow('/win.md'));
    const result = await exclusive(h, () => h.controller.applyToTabNow('t1', prependX));
    expect(result?.kind).toBe('applied');
    expect(h.files.get('/win.md')).toBe('Xone\r\ntwo\r\n');
  });

  it('AnEndingChangedWhileTheTabWasShownIsKeptWhenItIsLeft', async () => {
    // The active tab followed an external conversion (`fileState.lineEnding`);
    // the file then went away, so the agent's write has only the tab's own
    // ending to go by — the one it had when it was left, not the one it was read with.
    const h = await started({ '/a.md': 'AAAA', '/win.md': 'one\ntwo' }, [fileTab('a', '/a.md')]);
    await h.controller.openPath('/win.md');
    h.doc.lineEnding = 'crlf';
    await h.controller.activate('a');
    h.files.delete('/win.md');
    await exclusive(h, () => h.controller.applyToTabNow('t1', prependX));
    expect(h.files.get('/win.md')).toBe('Xone\r\ntwo');
  });

  it('AgentReadsAreQuiet_TheHumansAreNot', async () => {
    // A failed read an agent caused must not raise a toast the human never asked for.
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    await exclusive(h, () => h.controller.openBackgroundNow('/b.md'));
    await exclusive(h, () => h.controller.textForAgentNow('t1'));
    await exclusive(h, () => h.controller.applyToTabNow('t1', prependX));
    const agentReads = vi.mocked(h.deps.disk.read).mock.calls;
    expect(agentReads.length).toBe(3);
    for (const [, opts] of agentReads) expect(opts?.quiet).toBe(true);
    vi.mocked(h.deps.disk.read).mockClear();
    await h.controller.activate('t1');
    expect(vi.mocked(h.deps.disk.read).mock.calls.length).toBeGreaterThan(0);
    for (const [, opts] of vi.mocked(h.deps.disk.read).mock.calls) expect(opts?.quiet).toBeFalsy();
  });
});
