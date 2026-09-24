import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { AiCommandPayload } from '../tauri/events';
import { createSerialQueue } from '../serial-queue';
import type { TabListState, TabMeta } from './tab-model';
import type { ActivateResult, ApplyResult, BackgroundOpen, OpenPathResult, QuickLookOrigin } from './controller';
import {
  AGENT_ERRORS,
  answerResponse,
  createAgentCommands,
  dropExpired,
  type AgentCommands,
  type AgentResponse,
  type AgentTabs,
  type AskResult,
} from './agent-commands';

function payload(p: Partial<AiCommandPayload> & Pick<AiCommandPayload, 'id' | 'cmd' | 'path'>): AiCommandPayload {
  return {
    line: null, find: null, content: null, show: false, question: 'Q?', options: ['Yes', 'No'],
    multi: false, freeText: false, timeoutSecs: 300, firstUse: false, focus: false, transient: false,
    fresh: false, ...p,
  };
}

/** `u…` ids are untitled tabs; every other id names its file (`b` holds `/b.md`). */
function meta(id: string): TabMeta {
  return { id, path: id.startsWith('u') ? null : `/${id}.md`, dirty: false, openedAt: 0, viewedAt: 0, unviewed: false };
}

/**
 * A window: tabs, a disk, and a fake of the controller that calls
 * `leave`/`enter`/`forget` exactly where the real one does (proved in
 * `controller.test.ts`, "agent hooks") and, like it, refuses every agent
 * operation outside `runExclusive` — logged as `OUTSIDE …`.
 */
function makeWorld(tabIds: string[], activeId: string) {
  const disk = new Map(tabIds.filter((id) => !id.startsWith('u')).map((id) => [`/${id}.md`, `${id}1\n${id}2\n${id}3`]));
  disk.set('/c.md', 'c1\nc2\nc3');
  let list: TabListState = { tabs: tabIds.map(meta), activeId };
  /** What the human typed into an untitled tab; absent: blank. */
  const untitledText = new Map<string, string>();
  const log: string[] = [];
  const responses: [number, AgentResponse][] = [];
  const pending = new Set<number>();
  const clock = { now: 1_000, typing: false, liveAsk: false };
  let liveAsks: number[] = [];
  const answerers = new Map<number, (r: AskResult) => void>();
  const pathOf = (id: string) => list.tabs.find((t) => t.id === id)?.path ?? null;
  const idOf = (path: string) => path.slice(1, -3);
  const ref: { agent: AgentCommands | null } = { agent: null };
  const queue = createSerialQueue();
  let exclusive = false;
  /** A controller operation an agent drives: refused outside the slot, like `requireExclusive`. */
  const inSlot = (what: string): boolean => {
    if (!exclusive) log.push(`OUTSIDE ${what}`);
    return exclusive;
  };

  async function switchTo(id: string): Promise<void> {
    if (list.activeId === id) return;
    if (list.activeId !== null) ref.agent!.leave(list.activeId);
    liveAsks = [];
    list = { ...list, activeId: id };
    await ref.agent!.enter(id);
  }

  const tabs: AgentTabs = {
    get list() {
      return list;
    },
    findByPath: (path) => list.tabs.find((t) => t.path === path),
    activeIsEmptyUntitled: () => {
      const active = list.tabs.find((t) => t.id === list.activeId);
      return active !== undefined && active.path === null && (untitledText.get(active.id) ?? '') === '';
    },
    runExclusive: <T>(fn: () => Promise<T>) =>
      queue.run(async () => {
        exclusive = true;
        try {
          return await fn();
        } finally {
          exclusive = false;
        }
      }),
    activateNow: async (id): Promise<ActivateResult> => {
      log.push(`activateNow ${id}`);
      await switchTo(id);
      return 'ok';
    },
    openPathNow: async (path): Promise<OpenPathResult> => {
      if (!inSlot('openPathNow')) return { kind: 'failed' };
      log.push(`openPathNow ${path}`);
      const existing = list.tabs.find((t) => t.path === path);
      if (existing) {
        await switchTo(existing.id);
        return { kind: 'shown', tabId: existing.id };
      }
      const tab = meta(idOf(path));
      const active = list.tabs.find((t) => t.id === list.activeId);
      if (active && tabs.activeIsEmptyUntitled()) {
        // The controller's replace-active: an empty untitled tab gives way.
        ref.agent!.forget(active.id);
        list = { tabs: list.tabs.map((t) => (t.id === active.id ? tab : t)), activeId: active.id };
        liveAsks = [];
        list = { ...list, activeId: tab.id };
        await ref.agent!.enter(tab.id);
      } else {
        list = { ...list, tabs: [...list.tabs, tab] };
        await switchTo(tab.id);
      }
      return { kind: 'opened', tabId: tab.id };
    },
    openBackgroundNow: async (path): Promise<BackgroundOpen> => {
      if (!inSlot('openBackgroundNow')) return { kind: 'failed' };
      log.push(`openBackgroundNow ${path}`);
      list = { ...list, tabs: [...list.tabs, meta(idOf(path))] };
      return { kind: 'opened', tabId: idOf(path), text: disk.get(path) ?? '' };
    },
    markUnviewedNow: (id) => {
      if (inSlot('markUnviewedNow')) log.push(`unviewed ${id}`);
    },
    markTransientNow: (origin: QuickLookOrigin) => {
      if (inSlot('markTransientNow')) log.push(`transient ${origin.kind} ${origin.tabId}`);
    },
    placeCaretNow: (id, position) => {
      if (!inSlot('placeCaretNow')) return false;
      log.push(`caret ${id} ${position.cursor} ${position.topLine}`);
      return true;
    },
    applyToTabNow: async <T>(
      id: string,
      edit: (state: EditorState) => { state: EditorState; result: T } | null
    ): Promise<ApplyResult<T>> => {
      if (!inSlot('applyToTabNow')) return { kind: 'failed', error: 'not inside runExclusive' };
      const path = pathOf(id)!;
      const out = edit(EditorState.create({ doc: disk.get(path) ?? '' }));
      if (!out) return { kind: 'unchanged' };
      // As the controller: what is written is the state's text.
      disk.set(path, out.state.doc.toString());
      log.push(`applied ${id}`);
      return { kind: 'applied', result: out.result };
    },
    textForAgentNow: async (id) => {
      const path = pathOf(id);
      return path === null ? null : (disk.get(path) ?? null);
    },
    closeTabNow: async (id, onLastTab) => {
      if (!inSlot('closeTabNow')) return false;
      // As the controller: an agent never closes an untitled tab.
      if (pathOf(id) === null) return false;
      log.push(`close ${id}`);
      const last = list.tabs.length === 1;
      const wasActive = list.activeId === id;
      const rest = list.tabs.filter((t) => t.id !== id);
      ref.agent!.forget(id);
      if (wasActive) liveAsks = [];
      list = { tabs: rest, activeId: wasActive ? (rest[0]?.id ?? null) : list.activeId };
      if (last && onLastTab) {
        await onLastTab();
        log.push('window closed');
      } else if (wasActive && list.activeId !== null) {
        await ref.agent!.enter(list.activeId);
      }
      return true;
    },
  };

  /** Requests whose `ai_is_pending` IPC fails. */
  const pendingFails = new Set<number>();
  /** Requests whose widget throws while being placed. */
  const placeThrows = new Set<number>();
  /** Requests Rust hands on to the window that holds their file now (`ai_forward`). */
  const forwards = new Set<number>();
  const forwardFails = new Set<number>();

  const agent = createAgentCommands({
    tabs,
    isPending: async (id) => {
      if (pendingFails.has(id)) throw new Error('ipc down');
      return pending.has(id);
    },
    respond: async (id, response) => {
      pending.delete(id);
      responses.push([id, response]);
      log.push(`respond ${id}`);
    },
    forward: async (p) => {
      log.push(`forward ${p.id}`);
      if (forwardFails.has(p.id)) throw new Error('ipc down');
      return forwards.has(p.id);
    },
    typing: () => clock.typing,
    liveAsk: () => clock.liveAsk,
    revealWindow: async () => {
      log.push('reveal');
    },
    now: () => clock.now,
    live: {
      show: (p, keepCaret) => {
        log.push(`live show ${p.path}${keepCaret ? ' keepCaret' : ''}`);
        return { ok: true };
      },
      edit: (p, keepCaret) => {
        log.push(`live edit ${p.path}${keepCaret ? ' keepCaret' : ''}`);
        return { ok: true, changed_lines: [[1, 1]] };
      },
      placeAsk: (p, _deadline, onAnswer, quiet) => {
        if (placeThrows.has(p.id)) throw new Error('widget broke');
        if (quiet) log.push(`quiet ${p.id}`);
        liveAsks.push(p.id);
        answerers.set(p.id, (r) => {
          liveAsks = liveAsks.filter((x) => x !== p.id);
          onAnswer(r);
        });
        log.push(`placed ${p.id}`);
        return true;
      },
      pulse: (p, quiet) => {
        log.push(`pulse ${p.path}${quiet ? ' quiet' : ''}`);
      },
      askIds: () => liveAsks,
    },
  });
  ref.agent = agent;

  return {
    agent,
    tabs,
    log,
    clock,
    disk,
    pending,
    pendingFails,
    placeThrows,
    forwards,
    forwardFails,
    untitledText,
    list: () => list,
    /** A request an agent is waiting on. */
    send: (p: AiCommandPayload) => {
      pending.add(p.id);
      return agent.handle(p);
    },
    /** The human clicks a tab — the controller's own queue, not the agents' slot. */
    click: (id: string) => queue.run(() => switchTo(id)),
    answer: (id: number, r: AskResult) => answerers.get(id)!(r),
    response: (id: number) => responses.find(([rid]) => rid === id)?.[1],
    count: (line: string) => log.filter((l) => l === line).length,
    outside: () => log.filter((l) => l.startsWith('OUTSIDE')),
  };
}

describe('answerResponse', () => {
  it('MapsEveryWidgetOutcome', () => {
    expect(answerResponse('Yes')).toEqual({ ok: true, answer: 'Yes' });
    expect(answerResponse([])).toEqual({ ok: true, answers: [] });
    expect(answerResponse({ custom: 'x' })).toEqual({ ok: true, custom: 'x' });
    expect(answerResponse({ answers: ['A'], custom: 'x' })).toEqual({ ok: true, answers: ['A'], custom: 'x' });
    expect(answerResponse(null)).toEqual({ ok: false, error: 'dismissed by user' });
  });
});

describe('ask in a background tab (spec §5)', () => {
  it('WaitsThere_IsShownWhenTheHumanOpensTheTab_AndTheAnswerReachesTheAgent', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    expect(w.log).toContain('unviewed b');
    expect(w.count('placed 1')).toBe(0);
    expect(w.response(1)).toBeUndefined();
    await w.click('b');
    expect(w.count('placed 1')).toBe(1);
    w.answer(1, 'Yes');
    expect(w.response(1)).toEqual({ ok: true, answer: 'Yes' });
    expect(w.log).not.toContain('activateNow b');
  });

  it('LeavingATabWithALiveQuestionKeepsIt_ItComesBackWithTheTab', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/a.md' }));
    expect(w.count('placed 1')).toBe(1);
    await w.click('b');
    expect(w.response(1), 'no "switched away" error any more').toBeUndefined();
    await w.click('a');
    expect(w.count('placed 1')).toBe(2);
    w.answer(1, ['Yes']);
    expect(w.response(1)).toEqual({ ok: true, answers: ['Yes'] });
  });

  it('LeaveSaysWhetherSomethingWasParked', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    expect(w.agent.leave('a')).toBe(false);
    await w.send(payload({ id: 1, cmd: 'ask', path: '/a.md', timeoutSecs: 10 }));
    expect(w.agent.leave('a')).toBe(true);
    // Taken back and shown again, then past its deadline: nothing to wait for.
    await w.agent.enter('a');
    w.clock.now += 10_000;
    expect(w.agent.leave('a')).toBe(false);
  });

  it('IsNotShownOnceItsAgentStoppedWaiting', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    w.pending.delete(1);
    await w.click('b');
    expect(w.count('placed 1')).toBe(0);
  });

  it('IsNotShownPastItsDeadline_TheTimeoutCountsFromTheRequest', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md', timeoutSecs: 10 }));
    w.clock.now += 10_000;
    await w.click('b');
    expect(w.count('placed 1')).toBe(0);
  });

  it('IsForgottenWithItsTab', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    w.agent.forget('b');
    await w.click('b');
    expect(w.count('placed 1')).toBe(0);
  });

  it('ALiveQuestionIsForgottenWithTheActiveTab_NotParkedOrAnsweredLater', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/a.md' }));
    expect(w.count('placed 1')).toBe(1);
    // The active tab goes (⌘W, a move to another window): Rust answers the
    // agent; its record here must go with it.
    w.agent.forget('a');
    expect(w.agent.leave('a'), 'nothing left to park for the gone tab').toBe(false);
    await w.agent.enter('a');
    expect(w.count('placed 1')).toBe(1);
  });

  it('OnEntryPulsesComeFirst_ThenTheQuestionsInTheOrderTheyCame', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', line: 2 }));
    await w.send(payload({ id: 3, cmd: 'ask', path: '/b.md' }));
    await w.click('b');
    const delivered = w.log.filter((l) => l.startsWith('pulse') || l.startsWith('placed'));
    expect(delivered).toEqual(['pulse /b.md', 'placed 1', 'placed 3']);
  });
});

describe('focus (spec §5)', () => {
  it('AnAgentsOpenLandsInTheBackgroundByDefault', async () => {
    const w = makeWorld(['a'], 'a');
    await w.send(payload({ id: 1, cmd: 'open', path: '/c.md' }));
    expect(w.log).toContain('openBackgroundNow /c.md');
    expect(w.log).toContain('unviewed c');
    expect(w.list().activeId).toBe('a');
    expect(w.response(1)).toEqual({ ok: true, focused: false });
  });

  it('FocusTrueWhileTheHumanTypesStaysInTheBackground', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.clock.typing = true;
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', focus: true }));
    expect(w.log).not.toContain('activateNow b');
    expect(w.log).not.toContain('reveal');
    expect(w.list().activeId).toBe('a');
    expect(w.response(1)).toEqual({ ok: true, focused: false });
  });

  it('FocusTrueWhenNobodyTypesSwitchesAndBringsTheWindowForward', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', focus: true }));
    expect(w.log).toEqual(expect.arrayContaining(['activateNow b', 'live show /b.md', 'reveal']));
    expect(w.response(1)).toEqual({ ok: true, focused: true });
  });

  it('FocusTrueForAFileNotOpenYetOpensItInFront', async () => {
    const w = makeWorld(['a'], 'a');
    await w.send(payload({ id: 1, cmd: 'show', path: '/c.md', focus: true }));
    expect(w.log).toContain('openPathNow /c.md');
    expect(w.list().activeId).toBe('c');
    expect(w.response(1)).toEqual({ ok: true, focused: true });
  });

  it('AShowOnTheActiveTabWhileTypingKeepsTheCaretAndDoesNotRaiseTheWindow', async () => {
    const w = makeWorld(['a'], 'a');
    w.clock.typing = true;
    await w.send(payload({ id: 1, cmd: 'show', path: '/a.md', focus: true, line: 2 }));
    expect(w.log).toContain('live show /a.md keepCaret');
    expect(w.log).not.toContain('reveal');
    expect(w.response(1)).toEqual({ ok: true, focused: true });
  });

  it('AnotherAgentsQuestionOnScreenIsNeverTakenAway', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.clock.liveAsk = true;
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', focus: true }));
    expect(w.list().activeId).toBe('a');
    expect(w.response(1)).toEqual({ ok: true, focused: false });
  });

  it('ARefusedSwitchFallsBackToTheBackground_AnUnreadableTabIsAnError', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.tabs.activateNow = async () => 'refused';
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', focus: true }));
    expect(w.response(1)).toEqual({ ok: true, focused: false });
    w.tabs.activateNow = async () => 'failed';
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', focus: true }));
    expect(w.response(2)).toEqual({ ok: false, error: AGENT_ERRORS.unreadable });
  });

  it('ARefusedOpenFallsBackToABackgroundOpen', async () => {
    const w = makeWorld(['a'], 'a');
    w.tabs.openPathNow = async () => ({ kind: 'refused' });
    await w.send(payload({ id: 1, cmd: 'show', path: '/c.md', focus: true, line: 2 }));
    expect(w.log).toContain('openBackgroundNow /c.md');
    expect(w.log).toContain('caret c 3 1');
    expect(w.response(1)).toEqual({ ok: true, focused: false });
  });

  it('AFileAnotherWindowTookMeanwhileIsAnError', async () => {
    const w = makeWorld(['a'], 'a');
    w.tabs.openPathNow = async () => ({ kind: 'elsewhere' });
    await w.send(payload({ id: 1, cmd: 'show', path: '/c.md', focus: true }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.elsewhere });
    w.tabs.openBackgroundNow = async () => ({ kind: 'other-window', label: 'editor-2' });
    await w.send(payload({ id: 2, cmd: 'open', path: '/c.md' }));
    expect(w.response(2)).toEqual({ ok: false, error: AGENT_ERRORS.elsewhere });
  });

  it('ACommandAnsweredMeanwhileIsDropped', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.agent.handle(payload({ id: 1, cmd: 'show', path: '/b.md', focus: true }));
    expect(w.log).toEqual([]);
  });

  it('ACommandWhoseAgentStoppedWaitingInTheQueueIsDropped', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blocker = w.tabs.runExclusive(() => gate);
    const queued = w.send(payload({ id: 1, cmd: 'edit', path: '/b.md', content: 'x' }));
    // Rust timed it out while it waited behind the switch.
    w.pending.delete(1);
    release();
    await Promise.all([blocker, queued]);
    expect(w.disk.get('/b.md')).toBe('b1\nb2\nb3');
    expect(w.log).toEqual([]);
  });

  it('AnUnknownVerbIsRefusedBeforeAnyTabMoves', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    const odd = { ...payload({ id: 1, cmd: 'show', path: '/b.md', focus: true }), cmd: 'frobnicate' };
    await w.send(odd as unknown as AiCommandPayload);
    expect(w.response(1)).toEqual({ ok: false, error: 'unsupported command: frobnicate' });
    expect(w.log).toEqual(['respond 1']);
    expect(w.list().activeId).toBe('a');
  });
});

describe('background edit and show (spec §5)', () => {
  it('AnEditOfABackgroundTabIsAppliedThereAndSaved_ShowPlacesTheCaret', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'edit', path: '/b.md', content: 'b1\nB2\nb3', show: true }));
    expect(w.disk.get('/b.md')).toBe('b1\nB2\nb3');
    expect(w.log).toEqual(expect.arrayContaining(['applied b', 'caret b 3 1', 'unviewed b']));
    expect(w.log).not.toContain('activateNow b');
    expect(w.response(1)).toEqual({ ok: true, changed_lines: [[2, 2]], focused: false });
  });

  it('AnIdenticalEditChangesNothing', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'edit', path: '/b.md', content: 'b1\nb2\nb3' }));
    expect(w.response(1)).toEqual({ ok: true, changed_lines: [], focused: false });
  });

  it('ACrlfEditIsWrittenAsTheEditorHoldsIt_AndRepeatingItChangesNothing', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'edit', path: '/b.md', content: 'b1\r\nB2\r\nb3' }));
    expect(w.disk.get('/b.md')).toBe('b1\nB2\nb3');
    expect(w.response(1)).toEqual({ ok: true, changed_lines: [[2, 2]], focused: false });
    await w.send(payload({ id: 2, cmd: 'edit', path: '/b.md', content: 'b1\r\nB2\r\nb3' }));
    expect(w.response(2)).toEqual({ ok: true, changed_lines: [], focused: false });
  });

  it('AFailedBackgroundWriteIsAnErrorAndPlacesNoCaret', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.tabs.applyToTabNow = async () => ({ kind: 'failed', error: 'disk full' });
    await w.send(payload({ id: 1, cmd: 'edit', path: '/b.md', content: 'x', show: true }));
    expect(w.response(1)).toEqual({ ok: false, error: 'could not save the background tab: disk full' });
    expect(w.log.some((l) => l.startsWith('caret'))).toBe(false);
  });

  it('AnEditOfAFileOpenNowhereHereOpensItInTheBackground', async () => {
    const w = makeWorld(['a'], 'a');
    await w.send(payload({ id: 1, cmd: 'edit', path: '/c.md', content: 'c1\nc2\nC3' }));
    expect(w.log).toEqual(expect.arrayContaining(['openBackgroundNow /c.md', 'applied c', 'unviewed c']));
    expect(w.disk.get('/c.md')).toBe('c1\nc2\nC3');
    expect(w.list().activeId).toBe('a');
  });

  it('AnEditOfTheActiveTabGoesToTheLiveView', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'edit', path: '/a.md', content: 'x' }));
    expect(w.log).toContain('live edit /a.md');
    expect(w.response(1)).toEqual({ ok: true, changed_lines: [[1, 1]], focused: true });
  });

  it('ABackgroundShowPlacesTheCaretNow_AndPulsesWhenTheTabIsShown', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', line: 3 }));
    expect(w.log).toContain('caret b 6 1');
    expect(w.response(1)).toEqual({ ok: true, focused: false });
    expect(w.log).not.toContain('pulse /b.md');
    await w.click('b');
    expect(w.log).toContain('pulse /b.md');
  });

  it('ABackgroundShowWithAMissingTargetFailsAtOnce', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', find: 'zzz' }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.targetNotFound });
  });
});

describe('quick looks (spec §7)', () => {
  it('MarkOnlyATabTheShowOpened', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'show', path: '/c.md', transient: true }));
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', transient: true }));
    expect(w.log).toContain('transient opened c');
    expect(w.log.some((l) => l.startsWith('transient') && l.endsWith(' b')), 'the human already had b open').toBe(false);
    await w.send(payload({ id: 3, cmd: 'show', path: '/b.md', transient: true, fresh: true }));
    expect(w.log, 'Rust opened it for this very command').toContain('transient fresh b');
  });

  it('ATabTheShowCreatesInAnExistingWindowIsMarked_InFrontOrBehind', async () => {
    // Rust routed to a window that already exists: `fresh` is false, and only
    // the controller's `opened` says the command made the tab.
    const front = makeWorld(['a'], 'a');
    await front.send(payload({ id: 1, cmd: 'show', path: '/c.md', transient: true, focus: true }));
    expect(front.list().activeId).toBe('c');
    expect(front.log).toContain('transient opened c');
    const behind = makeWorld(['a'], 'a');
    await behind.send(payload({ id: 1, cmd: 'show', path: '/c.md', transient: true }));
    expect(behind.list().activeId).toBe('a');
    expect(behind.log).toContain('transient opened c');
  });

  it('TheEmptyUntouchedMainsFileTabIsMarked', async () => {
    // `main` holds only its blank untitled tab; the show's file replaces it.
    const w = makeWorld(['u'], 'u');
    await w.send(payload({ id: 1, cmd: 'show', path: '/c.md', transient: true, focus: true }));
    expect(w.list().tabs.map((t) => t.id)).toEqual(['c']);
    expect(w.log).toContain('transient opened c');
    expect(w.response(1)).toEqual({ ok: true, focused: true });
  });

  it('AnOpenThatFoundTheHumansTabIsNotMarked_EvenWhenThePathLookupMissedIt', async () => {
    // A lookup by this spelling found nothing, but the controller's open
    // landed on a tab the window already had: `shown`, not `opened`.
    const w = makeWorld(['a', 'b'], 'a');
    w.tabs.openPathNow = async () => {
      await w.tabs.activateNow('b', {});
      return { kind: 'shown', tabId: 'b' };
    };
    await w.send(payload({ id: 1, cmd: 'show', path: '/B.md', transient: true, focus: true }));
    expect(w.log.some((l) => l.startsWith('transient'))).toBe(false);
  });

  it('OnlyAShowMakesAQuickLook', async () => {
    const w = makeWorld(['a'], 'a');
    await w.send(payload({ id: 1, cmd: 'open', path: '/c.md', transient: true }));
    expect(w.log.some((l) => l.startsWith('transient'))).toBe(false);
  });
});

describe('the exclusive slot (D9)', () => {
  it('EveryAgentOperationRunsInsideIt_DeliveryOnEntryIncluded', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', line: 2 }));
    await w.send(payload({ id: 3, cmd: 'edit', path: '/b.md', content: 'x', show: true }));
    await w.send(payload({ id: 4, cmd: 'show', path: '/c.md', transient: true }));
    await w.send(payload({ id: 5, cmd: 'show', path: '/c.md', focus: true }));
    await w.click('b');
    await w.send(payload({ id: 6, cmd: 'close', path: '/c.md' }));
    expect(w.outside()).toEqual([]);
    expect(w.count('respond 5')).toBe(1);
  });
});

describe('while the human types in the active tab (D4, D19)', () => {
  it('AnEditWithShowIsAppliedThere_WithoutMovingTheCaret', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.clock.typing = true;
    await w.send(payload({ id: 1, cmd: 'edit', path: '/a.md', content: 'x', show: true }));
    expect(w.log).toContain('live edit /a.md keepCaret');
    expect(w.response(1)).toEqual({ ok: true, changed_lines: [[1, 1]], focused: true });
    w.clock.typing = false;
    await w.send(payload({ id: 2, cmd: 'edit', path: '/a.md', content: 'y', show: true }));
    expect(w.log).toContain('live edit /a.md');
  });

  it('AQuestionIsPlacedQuietly', async () => {
    const w = makeWorld(['a'], 'a');
    w.clock.typing = true;
    await w.send(payload({ id: 1, cmd: 'ask', path: '/a.md' }));
    expect(w.log).toEqual(expect.arrayContaining(['placed 1', 'quiet 1']));
    w.clock.typing = false;
    await w.send(payload({ id: 2, cmd: 'ask', path: '/a.md' }));
    expect(w.log).toContain('placed 2');
    expect(w.log).not.toContain('quiet 2');
  });

  it('WhatArrivesWithATabShownMeanwhileIsQuietToo', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', line: 2 }));
    w.clock.typing = true;
    await w.click('b');
    expect(w.log).toEqual(expect.arrayContaining(['pulse /b.md quiet', 'quiet 1', 'placed 1']));
  });
});

describe('when Rust cannot say whether an agent still waits', () => {
  it('TheCommandDoesNothing_AndItsAgentIsToldSo', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.pendingFails.add(1);
    await w.send(payload({ id: 1, cmd: 'close', path: '/b.md' }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.pendingUnknown });
    expect(w.log).toEqual(['respond 1']);
  });

  it('AParkedQuestionIsAnsweredWithTheError_TheOthersAreStillShown', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    await w.send(payload({ id: 2, cmd: 'ask', path: '/b.md' }));
    w.pendingFails.add(1);
    await w.click('b');
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.pendingUnknown });
    expect(w.count('placed 1')).toBe(0);
    expect(w.count('placed 2')).toBe(1);
  });

  it('AQuestionThatBreaksWhilePlacedLosesNoneOfTheOthers', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    await w.send(payload({ id: 2, cmd: 'ask', path: '/b.md' }));
    await w.send(payload({ id: 3, cmd: 'ask', path: '/b.md' }));
    w.placeThrows.add(2);
    await w.click('b');
    expect(w.response(2)).toEqual({ ok: false, error: 'widget broke' });
    expect(w.count('placed 1')).toBe(1);
    expect(w.count('placed 3')).toBe(1);
  });
});

describe('a background open that finds the active tab', () => {
  it('IsHandledLive', async () => {
    // Another spelling missed the lookup; the controller found the tab the
    // human is looking at. It is not a background tab to shimmer or park on.
    const w = makeWorld(['a', 'b'], 'a');
    w.tabs.openBackgroundNow = async () => ({ kind: 'existing', tabId: 'a' });
    await w.send(payload({ id: 1, cmd: 'show', path: '/A.md', line: 2 }));
    expect(w.log).toContain('live show /A.md');
    expect(w.log.some((l) => l.startsWith('caret'))).toBe(false);
    expect(w.response(1)).toEqual({ ok: true, focused: true });
    await w.send(payload({ id: 2, cmd: 'ask', path: '/A.md' }));
    expect(w.count('placed 2')).toBe(1);
  });
});

describe('a window whose only tab is a blank Untitled (Rust fills an untouched main)', () => {
  it('AQuestionTakesItsPlaceAndIsShownAtOnce', async () => {
    const w = makeWorld(['u'], 'u');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/c.md' }));
    expect(w.list()).toEqual({ tabs: [expect.objectContaining({ id: 'c' })], activeId: 'c' });
    expect(w.count('placed 1')).toBe(1);
    expect(w.log).not.toContain('openBackgroundNow /c.md');
    expect(w.log).not.toContain('reveal');
  });

  it('AnEditIsAppliedLive', async () => {
    const w = makeWorld(['u'], 'u');
    await w.send(payload({ id: 1, cmd: 'edit', path: '/c.md', content: 'x' }));
    expect(w.list().activeId).toBe('c');
    expect(w.log).toContain('live edit /c.md');
    expect(w.response(1)).toEqual({ ok: true, changed_lines: [[1, 1]], focused: true });
  });

  it('ABackgroundOpenBecomesItsOnlyTab_WithoutRaisingTheWindow', async () => {
    const w = makeWorld(['u'], 'u');
    await w.send(payload({ id: 1, cmd: 'open', path: '/c.md' }));
    expect(w.list().tabs.map((t) => t.id)).toEqual(['c']);
    expect(w.log).not.toContain('reveal');
    expect(w.response(1)).toEqual({ ok: true, focused: true });
  });

  it('AnUntitledWithTextIsNotReplaced_TheCommandGoesToTheBackground', async () => {
    const w = makeWorld(['u'], 'u');
    w.untitledText.set('u', 'draft');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/c.md' }));
    expect(w.log).toContain('openBackgroundNow /c.md');
    expect(w.list().activeId).toBe('u');
    expect(w.count('placed 1')).toBe(0);
  });

  it('NorWhileTheHumanTypes', async () => {
    const w = makeWorld(['u'], 'u');
    w.clock.typing = true;
    await w.send(payload({ id: 1, cmd: 'edit', path: '/c.md', content: 'x' }));
    expect(w.log).toContain('openBackgroundNow /c.md');
    expect(w.list().activeId).toBe('u');
  });
});

describe('dropExpired', () => {
  it('KeepsOnlyRecordsBeforeTheirDeadline', () => {
    const records = new Map([
      [1, { deadline: 10 }],
      [2, { deadline: 20 }],
      [3, { deadline: 30 }],
    ]);
    dropExpired(records, 20);
    expect([...records.keys()]).toEqual([3]);
  });
});

describe('close (spec §8)', () => {
  it('ClosesTheTabTheCmdWWay', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'close', path: '/b.md' }));
    expect(w.log).toContain('close b');
    expect(w.response(1)).toEqual({ ok: true });
  });

  it('RefusesAFileNotOpenHere_OrTheTabTheHumanTypesIn', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'close', path: '/zzz.md' }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.notOpen });
    w.clock.typing = true;
    await w.send(payload({ id: 2, cmd: 'close', path: '/a.md' }));
    expect(w.response(2)).toEqual({ ok: false, error: AGENT_ERRORS.typing });
    expect(w.log).not.toContain('close a');
  });

  it('AnswersBeforeClosingTheLastTabClosesTheWindow', async () => {
    const w = makeWorld(['a'], 'a');
    await w.send(payload({ id: 1, cmd: 'close', path: '/a.md' }));
    expect(w.log.indexOf('respond 1')).toBeLessThan(w.log.indexOf('window closed'));
    expect(w.response(1)).toEqual({ ok: true });
  });

  it('ACloseWhoseAgentStoppedWaitingClosesNothing', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const blocker = w.tabs.runExclusive(() => gate);
    const queued = w.send(payload({ id: 1, cmd: 'close', path: '/b.md' }));
    w.pending.delete(1);
    release();
    await Promise.all([blocker, queued]);
    expect(w.log).not.toContain('close b');
    expect(w.list().tabs.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('ARefusedCloseIsAnsweredAtOnce_NeverLeftHanging', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.tabs.closeTabNow = async () => false;
    await w.send(payload({ id: 1, cmd: 'close', path: '/a.md' }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.unsaved });
    w.tabs.closeTabNow = async () => {
      throw new Error('ipc down');
    };
    await w.send(payload({ id: 2, cmd: 'close', path: '/b.md' }));
    expect(w.response(2)).toEqual({ ok: false, error: 'ipc down' });
  });

  it('NeverClosesAnUntitledTab', async () => {
    // A path cannot name an untitled tab; a lookup that somehow returned one
    // is still refused, with an answer.
    const w = makeWorld(['a', 'u'], 'a');
    const find = w.tabs.findByPath;
    w.tabs.findByPath = (path) => (path === '/u' ? w.list().tabs.find((t) => t.id === 'u') : find(path));
    await w.send(payload({ id: 1, cmd: 'close', path: '/u' }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.untitled });
    expect(w.list().tabs.map((t) => t.id)).toEqual(['a', 'u']);
  });

  it('ClosingTheActiveTabWithALiveQuestionForgetsIt', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 1, cmd: 'ask', path: '/a.md' }));
    await w.send(payload({ id: 2, cmd: 'close', path: '/a.md' }));
    expect(w.response(2)).toEqual({ ok: true });
    expect(w.agent.leave('a')).toBe(false);
  });
});

describe('a tab that moved to another window (plan 05)', () => {
  it('ACommandForAFileAnotherWindowHoldsNowIsForwarded_NotAnswered', async () => {
    const w = makeWorld(['a'], 'a');
    w.tabs.openBackgroundNow = async () => ({ kind: 'other-window', label: 'editor-2' });
    w.forwards.add(1);
    await w.send(payload({ id: 1, cmd: 'ask', path: '/b.md' }));
    expect(w.log).toContain('forward 1');
    expect(w.response(1)).toBeUndefined();
  });

  it('WhenRustWillNotTakeIt_OrCannotBeAsked_TheAgentHearsWhy', async () => {
    const w = makeWorld(['a'], 'a');
    w.tabs.openBackgroundNow = async () => ({ kind: 'other-window', label: 'editor-2' });
    w.forwardFails.add(2);
    await w.send(payload({ id: 1, cmd: 'show', path: '/b.md', line: 1 }));
    await w.send(payload({ id: 2, cmd: 'show', path: '/b.md', line: 1 }));
    expect(w.response(1)).toEqual({ ok: false, error: AGENT_ERRORS.elsewhere });
    expect(w.response(2)).toEqual({ ok: false, error: AGENT_ERRORS.elsewhere });
  });

  it('ACloseForATabThatLeftIsForwardedToo', async () => {
    const w = makeWorld(['a'], 'a');
    w.forwards.add(3);
    await w.send(payload({ id: 3, cmd: 'close', path: '/gone.md' }));
    expect(w.log).toContain('forward 3');
    expect(w.response(3)).toBeUndefined();
  });

  it('CarryTakesWhatWaitsForTheTab_AndNothingIsLeftBehindOrAnswered', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    await w.send(payload({ id: 4, cmd: 'ask', path: '/b.md' }));
    const carried = w.agent.carry('b');
    expect(carried).toEqual([{ kind: 'ask', payload: expect.objectContaining({ id: 4 }), deadline: 1_000 + 300_000 }]);
    await w.click('b');
    expect(w.count('placed 4')).toBe(0);
    expect(w.response(4)).toBeUndefined();
  });

  it('AdoptedAsksAreShownWhenTheTabIsEntered_ExpiredOnesAreDropped', async () => {
    const w = makeWorld(['a', 'b'], 'a');
    w.pending.add(5);
    w.pending.add(6);
    w.agent.adopt('b', [
      { kind: 'ask', payload: payload({ id: 5, cmd: 'ask', path: '/b.md' }), deadline: 2_000 },
      { kind: 'ask', payload: payload({ id: 6, cmd: 'ask', path: '/b.md' }), deadline: 900 },
    ]);
    await w.click('b');
    expect(w.count('placed 5')).toBe(1);
    expect(w.count('placed 6')).toBe(0);
  });
});
