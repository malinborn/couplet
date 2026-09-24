import { EditorState } from '@codemirror/state';
import type { AiCommandPayload } from '../tauri/events';
import { applyAiEditToState, resolveShowTarget } from '../ai-commands';
import { decideLanding } from './agent-landing';
import { createAgentInbox, deliverable, type InboxItem } from './agent-inbox';
import type { QuickLookOrigin, TabController } from './controller';

/** The answer an agent gets — `AiResponse` in src-tauri/src/ai_socket.rs; Rust adds `window`. */
export interface AgentResponse {
  ok: boolean;
  error?: string;
  changed_lines?: [number, number][];
  answer?: string;
  answers?: string[];
  custom?: string;
  /** The tab is its window's active tab afterwards. */
  focused?: boolean;
}

/** What the ask widget reports (`AskSpec.onAnswer`). */
export type AskResult = string | string[] | { custom: string } | { answers: string[]; custom: string } | null;

export function answerResponse(result: AskResult): AgentResponse {
  if (result === null) return { ok: false, error: 'dismissed by user' };
  if (Array.isArray(result)) return { ok: true, answers: result };
  if (typeof result === 'string') return { ok: true, answer: result };
  if ('answers' in result) return { ok: true, answers: result.answers, custom: result.custom };
  return { ok: true, custom: result.custom };
}

/** Lines kept above a target when a background tab is later shown at it. */
export const CONTEXT_LINES = 5;

export const AGENT_ERRORS = {
  unreadable: 'could not open the tab',
  elsewhere: 'the file is open in another window',
  typing: 'the user is typing in this tab',
  unsaved: 'the tab has unsaved changes',
  untitled: 'an agent never closes an untitled tab',
  notOpen: 'file is not open in this window',
  targetNotFound: 'target not found',
  editorNotReady: 'editor not ready',
  pendingUnknown: 'could not confirm the request is still pending',
} as const;

/** Drop the records whose deadline has come: nobody waits for them any more. */
export function dropExpired<K>(records: Map<K, { deadline: number }>, now: number): void {
  for (const [key, record] of records) {
    if (now >= record.deadline) records.delete(key);
  }
}

/** The verbs a window carries out. Anything else is refused before a tab moves. */
const VERBS: ReadonlySet<string> = new Set<AiCommandPayload['cmd']>(['show', 'edit', 'ask', 'open', 'close']);

/** What of the tab controller an agent command uses — all of it inside `runExclusive`. */
export type AgentTabs = Pick<
  TabController,
  | 'list'
  | 'findByPath'
  | 'runExclusive'
  | 'activateNow'
  | 'openPathNow'
  | 'openBackgroundNow'
  | 'markUnviewedNow'
  | 'markTransientNow'
  | 'placeCaretNow'
  | 'applyToTabNow'
  | 'textForAgentNow'
  | 'closeTabNow'
>;

export interface AgentCommandDeps {
  tabs: AgentTabs;
  /**
   * Rust still has an agent waiting on `id` (`ai_is_pending`). Rejects when
   * Rust cannot be asked — never guessed either way: `true` would act for an
   * agent that may be gone, `false` would leave one waiting for nothing.
   */
  isPending(id: number): Promise<boolean>;
  respond(id: number, response: AgentResponse): Promise<void>;
  /** `typing.ts`: the human is typing in this window. */
  typing(): boolean;
  /** The active tab shows an agent's live `ask`. */
  liveAsk(): boolean;
  /** Bring this window forward (`reveal_window`). */
  revealWindow(): Promise<void>;
  now(): number;
  /**
   * The live view — CodeMirror, in App.svelte. `keepCaret` / `quiet`: the
   * human is typing here (D4, D19) — neither the caret nor the view moves.
   */
  live: {
    /** Scroll to and pulse the target; the caret follows unless `keepCaret`. */
    show(payload: AiCommandPayload, keepCaret: boolean): AgentResponse;
    /**
     * Apply the edit synchronously (no `await` between reading the doc and
     * dispatching). With `show`, the caret and the view go to the change
     * unless `keepCaret`.
     */
    edit(payload: AiCommandPayload, keepCaret: boolean): AgentResponse;
    /**
     * Place the question widget; `false` when its target is not in the
     * document. Unless `quiet`, the caret follows it and the view scrolls there.
     */
    placeAsk(
      payload: AiCommandPayload,
      deadline: number,
      onAnswer: (result: AskResult) => void,
      quiet: boolean
    ): boolean;
    /** Pulse the target without touching the caret — a background show, on entry. Unless `quiet`, may scroll to it. */
    pulse(payload: AiCommandPayload, quiet: boolean): void;
    /** Ids of the question widgets in the live view. */
    askIds(): number[];
  };
}

/** A question in the live view, and the tab it is on. */
interface Placed {
  payload: AiCommandPayload;
  deadline: number;
  tabId: string;
}

/** How a switch to the command's tab went. `opened`: the switch created the tab. */
type Switched =
  | { kind: 'shown'; tabId: string; opened: QuickLookOrigin | null }
  | { kind: 'background' }
  | { kind: 'elsewhere' }
  | { kind: 'failed' };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An agent's command in this window (spec §5): where it lands
 * (`decideLanding`), and what it does there — in the live view, or on a tab
 * in the background, which then shimmers. A question for a background tab,
 * or on a tab the human leaves, waits in the inbox and is shown when the tab
 * is; its timeout counts from the request. The controller calls
 * `leave`/`enter`/`forget` around every switch and close.
 *
 * Every tab operation and stamp runs inside `runExclusive` (D9); `leave`,
 * `enter` and `forget` run inside the controller's own queue and touch only
 * the live view and this module's records.
 */
export function createAgentCommands(deps: AgentCommandDeps) {
  const inbox = createAgentInbox();
  /** Questions in the live view, by request id: what `leave` parks and `forget` drops. */
  const placed = new Map<number, Placed>();

  const respond = (payload: AiCommandPayload, response: AgentResponse) => deps.respond(payload.id, response);
  const deadlineOf = (payload: AiCommandPayload) => deps.now() + payload.timeoutSecs * 1000;

  /** Show the question on `tabId`, the active tab. */
  function place(payload: AiCommandPayload, tabId: string, deadline: number, quiet: boolean): boolean {
    dropExpired(placed, deps.now());
    const shown = deps.live.placeAsk(
      payload,
      deadline,
      (result) => {
        placed.delete(payload.id);
        void deps.respond(payload.id, answerResponse(result));
      },
      quiet
    );
    if (shown) placed.set(payload.id, { payload, deadline, tabId });
    return shown;
  }

  /** Wait in `tabId`'s inbox — tidying away asks nobody waits for any more. */
  function park(tabId: string, item: InboxItem): void {
    inbox.park(tabId, item, deps.now());
  }

  /**
   * Unviewed unless in front of the human. A quick look only for a tab this
   * very command created — the controller's `opened`, or Rust's `fresh` for
   * a window built for it — never one the human already had (D17).
   */
  function stamp(payload: AiCommandPayload, tabId: string, opened: QuickLookOrigin | null): void {
    deps.tabs.markUnviewedNow(tabId);
    if (payload.cmd !== 'show' || !payload.transient) return;
    const origin: QuickLookOrigin | null =
      opened?.kind === 'opened' ? opened : payload.fresh ? { kind: 'fresh', tabId } : null;
    if (origin) deps.tabs.markTransientNow(origin);
  }

  /** `tabId` is the active tab: the command acts in the live view. */
  async function landLive(payload: AiCommandPayload, tabId: string, opened: QuickLookOrigin | null): Promise<void> {
    stamp(payload, tabId, opened);
    // Read once: every live action below honours the same answer.
    const typing = deps.typing();
    if (payload.cmd === 'ask') {
      // Answered from the widget.
      if (!place(payload, tabId, deadlineOf(payload), typing)) {
        await respond(payload, { ok: false, error: AGENT_ERRORS.targetNotFound });
      }
      return;
    }
    const response: AgentResponse =
      payload.cmd === 'edit'
        ? deps.live.edit(payload, typing)
        : payload.cmd === 'show'
          ? deps.live.show(payload, typing)
          : { ok: true };
    // While the human types here the window is already in front of them.
    if (response.ok && payload.focus && !typing && (payload.cmd === 'show' || payload.cmd === 'open')) {
      await deps.revealWindow();
    }
    await respond(payload, response.ok ? { ...response, focused: true } : response);
  }

  /** D8: the target is resolved now; the caret waits there, and a pulse plays on entry. */
  async function showInBackground(payload: AiCommandPayload, tabId: string, known: string | null): Promise<void> {
    if (payload.line === null && payload.find === null) return respond(payload, { ok: true, focused: false });
    const text = known ?? (await deps.tabs.textForAgentNow(tabId));
    if (text === null) return respond(payload, { ok: false, error: AGENT_ERRORS.unreadable });
    const doc = EditorState.create({ doc: text });
    const pos = resolveShowTarget(doc, payload);
    if (pos === null) return respond(payload, { ok: false, error: AGENT_ERRORS.targetNotFound });
    const line = doc.doc.lineAt(pos).number;
    deps.tabs.placeCaretNow(tabId, { cursor: pos, topLine: Math.max(1, line - CONTEXT_LINES) });
    park(tabId, { kind: 'pulse', payload });
    return respond(payload, { ok: true, focused: false });
  }

  /**
   * D7: applied to the tab's state and written at once. The edit normalizes
   * line endings (`buildAiEdit`), and what the controller writes — and keeps
   * as the baseline — is the resulting state's text, never the raw content.
   */
  async function editInBackground(payload: AiCommandPayload, tabId: string): Promise<void> {
    const result = await deps.tabs.applyToTabNow(tabId, (state) =>
      applyAiEditToState(state, payload.content ?? '', payload.show)
    );
    if (result.kind === 'failed') {
      return respond(payload, { ok: false, error: `could not save the background tab: ${result.error}` });
    }
    if (result.kind === 'unchanged') return respond(payload, { ok: true, changed_lines: [], focused: false });
    const edit = result.result;
    if (payload.show) {
      const firstLine = edit.changedLines[0]?.[0] ?? 1;
      deps.tabs.placeCaretNow(tabId, { cursor: edit.from, topLine: Math.max(1, firstLine - CONTEXT_LINES) });
    }
    return respond(payload, { ok: true, changed_lines: edit.changedLines, focused: false });
  }

  async function landBackground(payload: AiCommandPayload, known: string | undefined): Promise<void> {
    let tabId = known;
    let opened: QuickLookOrigin | null = null;
    let text: string | null = null;
    if (tabId === undefined) {
      const result = await deps.tabs.openBackgroundNow(payload.path);
      if (result.kind === 'other-window') return respond(payload, { ok: false, error: AGENT_ERRORS.elsewhere });
      if (result.kind === 'failed') return respond(payload, { ok: false, error: AGENT_ERRORS.unreadable });
      tabId = result.tabId;
      if (result.kind === 'opened') {
        opened = { kind: 'opened', tabId: result.tabId };
        text = result.text;
      } else if (tabId === deps.tabs.list.activeId) {
        // Another spelling missed the lookup: the tab is the one in front.
        return landLive(payload, tabId, null);
      }
    }
    stamp(payload, tabId, opened);
    switch (payload.cmd) {
      case 'open':
        return respond(payload, { ok: true, focused: false });
      case 'show':
        return showInBackground(payload, tabId, text);
      case 'edit':
        return editInBackground(payload, tabId);
      case 'ask':
        // Answered from the widget once the human opens the tab (`enter`).
        park(tabId, { kind: 'ask', payload, deadline: deadlineOf(payload) });
        return;
      case 'close':
        return;
    }
  }

  /**
   * Switch to the command's tab, opening it first if needed. Whether the
   * switch created the tab is the controller's answer (`opened`), never
   * inferred from the lookup here: another spelling of a path can miss a tab
   * the human already had.
   */
  async function activateFor(payload: AiCommandPayload, tabId: string | undefined): Promise<Switched> {
    if (tabId !== undefined) {
      const result = await deps.tabs.activateNow(tabId, { byAgent: true });
      if (result === 'ok' || result === 'noop') return { kind: 'shown', tabId, opened: null };
      // Refused (the active tab's save has not landed) or busy: never an error.
      return result === 'failed' ? { kind: 'failed' } : { kind: 'background' };
    }
    const result = await deps.tabs.openPathNow(payload.path);
    switch (result.kind) {
      case 'opened':
        return { kind: 'shown', tabId: result.tabId, opened: { kind: 'opened', tabId: result.tabId } };
      case 'shown':
        return { kind: 'shown', tabId: result.tabId, opened: null };
      case 'refused':
        return { kind: 'background' };
      case 'elsewhere':
        return { kind: 'elsewhere' };
      case 'failed':
        return { kind: 'failed' };
    }
  }

  /**
   * Spec §8: the ⌘W path; never while the human types in it, never an
   * untitled tab; answered before a last tab closes its window, and always
   * answered — a refusal or a failure is an error, not silence.
   */
  async function closeFor(payload: AiCommandPayload): Promise<void> {
    const tab = deps.tabs.findByPath(payload.path);
    if (!tab) return respond(payload, { ok: false, error: AGENT_ERRORS.notOpen });
    if (tab.path === null) return respond(payload, { ok: false, error: AGENT_ERRORS.untitled });
    if (tab.id === deps.tabs.list.activeId && deps.typing()) {
      return respond(payload, { ok: false, error: AGENT_ERRORS.typing });
    }
    let answered = false;
    const answer = async (response: AgentResponse) => {
      answered = true;
      await respond(payload, response);
    };
    try {
      const closed = await deps.tabs.closeTabNow(tab.id, () => answer({ ok: true }));
      if (!answered) await answer(closed ? { ok: true } : { ok: false, error: AGENT_ERRORS.unsaved });
    } catch (err) {
      console.error('Agent close failed:', err);
      if (!answered) await answer({ ok: false, error: message(err) });
    }
  }

  async function run(payload: AiCommandPayload): Promise<void> {
    const cmd = payload.cmd;
    if (cmd === 'close') return closeFor(payload);
    const tab = deps.tabs.findByPath(payload.path);
    const landing = decideLanding({
      cmd,
      active: tab !== undefined && tab.id === deps.tabs.list.activeId,
      focus: payload.focus,
      typing: deps.typing(),
      liveAsk: deps.liveAsk(),
    });
    if (landing === 'live' && tab) return landLive(payload, tab.id, null);
    if (landing === 'activate') {
      const switched = await activateFor(payload, tab?.id);
      if (switched.kind === 'shown') return landLive(payload, switched.tabId, switched.opened);
      if (switched.kind === 'failed') return respond(payload, { ok: false, error: AGENT_ERRORS.unreadable });
      if (switched.kind === 'elsewhere') return respond(payload, { ok: false, error: AGENT_ERRORS.elsewhere });
    }
    return landBackground(payload, tab?.id);
  }

  return {
    async handle(payload: AiCommandPayload): Promise<void> {
      // Before anything moves: a verb this window does not know is never
      // guessed at (it must not fall through to another verb's branch).
      if (!VERBS.has(payload.cmd)) {
        await respond(payload, { ok: false, error: `unsupported command: ${payload.cmd}` });
        return;
      }
      await deps.tabs.runExclusive(async () => {
        // A command can wait here behind a switch or past its own timeout;
        // its agent has been answered already, and acting now — a close
        // included — acts for nobody. When Rust cannot say, nothing is done
        // and the agent, if it still listens, is told why.
        let pending: boolean;
        try {
          pending = await deps.isPending(payload.id);
        } catch (err) {
          console.error('ai_is_pending failed:', err);
          await respond(payload, { ok: false, error: AGENT_ERRORS.pendingUnknown });
          return;
        }
        if (!pending) return;
        try {
          await run(payload);
        } catch (err) {
          console.error('Agent command failed:', err);
          await respond(payload, { ok: false, error: message(err) });
        }
      });
    },

    /**
     * The controller is leaving `tabId`: its live questions wait in the inbox.
     * `true` when one was parked — the tab then shimmers. A question whose
     * widget is gone, or whose deadline has passed, is dropped instead.
     */
    leave(tabId: string): boolean {
      const shown = new Set(deps.live.askIds());
      let parked = false;
      for (const [id, record] of placed) {
        if (record.tabId !== tabId) continue;
        placed.delete(id);
        if (!shown.has(id) || deps.now() >= record.deadline) continue;
        park(tabId, { kind: 'ask', payload: record.payload, deadline: record.deadline });
        parked = true;
      }
      return parked;
    },

    /**
     * `tabId` is shown: its pulse first, then the questions still waited on,
     * in the order they came — quietly while the human types (D19). Taken out
     * of the inbox at once, so each is answered here if it cannot be shown:
     * one that fails never costs the others.
     */
    async enter(tabId: string): Promise<void> {
      const items = deliverable(inbox.take(tabId), deps.now());
      const quiet = deps.typing();
      for (const item of items) {
        if (item.kind === 'pulse') deps.live.pulse(item.payload, quiet);
      }
      const asks = items.filter((item) => item.kind === 'ask');
      const pending = await Promise.all(
        asks.map((item) =>
          deps.isPending(item.payload.id).catch((err: unknown) => {
            console.error('ai_is_pending failed:', err);
            return 'unknown' as const;
          })
        )
      );
      // Typing is read again: the human may have started while Rust was asked.
      for (const [i, item] of asks.entries()) {
        const still = pending[i];
        try {
          if (still === 'unknown') {
            await respond(item.payload, { ok: false, error: AGENT_ERRORS.pendingUnknown });
          } else if (still && !place(item.payload, tabId, item.deadline, deps.typing())) {
            await respond(item.payload, { ok: false, error: AGENT_ERRORS.targetNotFound });
          }
        } catch (err) {
          console.error('Failed to show a question that waited for the tab:', err);
          await respond(item.payload, { ok: false, error: message(err) }).catch(() => {});
        }
      }
    },

    /**
     * `tabId` left the window: what waited for it goes — parked in the inbox,
     * or live on screen when it was the active tab. Rust answers its agents.
     */
    forget(tabId: string): void {
      inbox.forget(tabId);
      for (const [id, record] of placed) {
        if (record.tabId === tabId) placed.delete(id);
      }
    },
  };
}

export type AgentCommands = ReturnType<typeof createAgentCommands>;
