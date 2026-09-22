import { ChangeSet, Text } from '@codemirror/state';
import { computeReplacement, type Replacement } from '@app/lib/editor/content-diff';
import { clearAiHighlights, setAiHighlights } from '@app/lib/editor/ai-highlight';
import { mountDemoEditor, prefersReducedMotion } from './editor-demo';

// Two versions of the same runbook, differing by one rewritten paragraph —
// the vaguer "some changes might undo automatically" line replaced by a
// precise one. Both already carry the trailing blank line mountDemoEditor
// parks the selection on, so diffing them against the live (padded) doc
// never disturbs that park line.
//
// Deliberately compact, and with blank lines dropped between a heading and
// the block right after it (an ATX heading is self-terminating and doesn't
// need one) — the whole point of this card is the shimmering highlighted
// paragraph under "Database changes", and at this card's fixed height
// (see landing.css --demo-h) the original longer document pushed that
// paragraph below the fold entirely, so the one thing being demonstrated
// was never actually visible.
const before = `# Rollback runbook
## Rollback procedure
Rollbacks re-deploy the previous tag. The registry keeps the last five
artifacts pinned for exactly this reason.

## Database changes
Some schema changes might undo automatically during a rollback — double-check
the migration state before assuming anything.

## Escalation

Page the on-call engineer if the rollback itself fails.

`;

const after = `# Rollback runbook
## Rollback procedure
Rollbacks re-deploy the previous tag. The registry keeps the last five
artifacts pinned for exactly this reason.

## Database changes
Database migrations are reverted only by an explicit down-migration — never
automatically.

## Escalation

Page the on-call engineer if the rollback itself fails.

`;

// The chrome panel above the editor window: a small macOS-style terminal
// that types a plausible agent invocation, then a line of real `mdmini`
// tool traffic (see docs/ai-interface.md — `cat new.md | mdmini edit
// <file> [--show]` is the documented CLI shape, verbatim apart from the
// filename), then the tool's own JSON response contract
// (`{"ok":true,"changed_lines":[[a,b]]}`).
//
// Two different actors type here, and the markup says so: the `$` line is
// the human, genuinely typing `claude "..."` into their own shell. The
// `mdmini edit` line right after it is the agent's own tool call, not a
// second thing the person typed — it carries an explicit "agent" tag (see
// buildTerminal below) and a connector in demo-edit.css so it reads as a
// hand-off, not a continuation of the same prompt.
const COMMAND_TEXT = 'claude "tighten rollback wording in runbook.md"';
const TOOL_INVOCATION = 'cat new.md | mdmini edit runbook.md --show';
const TERMINAL_TITLE = 'agent — zsh';

// Per-phase pacing for one loop. Deliberately paced like a real exchange:
// a human-speed typed command, a beat for "pressing enter", a brief
// "running" state on the tool call, then the paragraph typing itself in.
const TYPE_COMMAND_MS = 32;
const TYPE_EDIT_MS = 22;
const ENTER_PAUSE_MS = 350;
const TOOL_REVEAL_PAUSE_MS = 250;
const RUNNING_MS = 700;
const RESULT_PAUSE_MS = 550;
const READ_PAUSE_MS = 2600;
const REVERT_PAUSE_MS = 900;

interface TerminalDom {
  commandEl: HTMLElement;
  cursorEl: HTMLElement;
  toolLineEl: HTMLElement;
  toolCmdEl: HTMLElement;
  statusLineEl: HTMLElement;
  statusEl: HTMLElement;
}

/** Builds the terminal chrome DOM inside the (initially empty) chrome panel. */
function buildTerminal(chrome: HTMLElement): TerminalDom {
  chrome.classList.add('demo-terminal');
  chrome.innerHTML = `
    <div class="demo-bar">
      <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
      <span class="demo-name">${TERMINAL_TITLE}</span>
    </div>
    <div class="demo-terminal-body">
      <div class="demo-terminal-line">
        <span class="demo-terminal-prompt">$</span>
        <span class="demo-terminal-command"></span><span class="demo-terminal-cursor"></span>
      </div>
      <div class="demo-terminal-line demo-terminal-line--tool">
        <span class="demo-terminal-tag">agent</span>
        <span class="demo-terminal-arrow">&rarr;</span>
        <span class="demo-terminal-tool"></span>
      </div>
      <div class="demo-terminal-line demo-terminal-line--status">
        <span class="demo-terminal-status"></span>
      </div>
    </div>
  `;

  const commandEl = chrome.querySelector<HTMLElement>('.demo-terminal-command');
  const cursorEl = chrome.querySelector<HTMLElement>('.demo-terminal-cursor');
  const toolLineEl = chrome.querySelector<HTMLElement>('.demo-terminal-line--tool');
  const toolCmdEl = chrome.querySelector<HTMLElement>('.demo-terminal-tool');
  const statusLineEl = chrome.querySelector<HTMLElement>('.demo-terminal-line--status');
  const statusEl = chrome.querySelector<HTMLElement>('.demo-terminal-status');
  if (!commandEl || !cursorEl || !toolLineEl || !toolCmdEl || !statusLineEl || !statusEl) {
    throw new Error('demo-terminal: expected markup missing');
  }
  return { commandEl, cursorEl, toolLineEl, toolCmdEl, statusLineEl, statusEl };
}

function resetTerminal(terminal: TerminalDom): void {
  terminal.commandEl.textContent = '';
  terminal.toolCmdEl.textContent = '';
  terminal.statusEl.textContent = '';
  terminal.cursorEl.classList.remove('is-blinking');
  terminal.toolLineEl.classList.remove('is-visible');
  terminal.statusLineEl.classList.remove('is-visible');
  terminal.statusEl.classList.remove('demo-terminal-status--running', 'demo-terminal-status--ok');
}

function showToolLine(terminal: TerminalDom): void {
  terminal.toolCmdEl.textContent = TOOL_INVOCATION;
  terminal.toolLineEl.classList.add('is-visible');
  terminal.statusLineEl.classList.add('is-visible');
  terminal.statusEl.textContent = 'running…';
  terminal.statusEl.classList.remove('demo-terminal-status--ok');
  terminal.statusEl.classList.add('demo-terminal-status--running');
}

/**
 * Converts a `Replacement` (character offsets in `resultDoc`) into the
 * 1-based inclusive line span `mdmini edit`'s real JSON response reports as
 * `changed_lines` (see docs/ai-interface.md's response contract).
 */
function changedLineRange(repl: Replacement, resultDoc: string): [number, number] {
  const text = Text.of(resultDoc.split('\n'));
  const startLine = text.lineAt(repl.from).number;
  const endOffset = repl.from + repl.insert.length;
  const endLine = text.lineAt(Math.max(repl.from, endOffset - 1)).number;
  return [startLine, endLine];
}

function showResult(terminal: TerminalDom, repl: Replacement | null): void {
  const changedLines = repl ? `[[${changedLineRange(repl, after).join(', ')}]]` : '[]';
  terminal.statusEl.textContent = `{"ok": true, "changed_lines": ${changedLines}}`;
  terminal.statusEl.classList.remove('demo-terminal-status--running');
  terminal.statusEl.classList.add('demo-terminal-status--ok');
}

/** Watches for `el` leaving the document and runs `onRemoved` once, then stops watching. */
function watchRemoval(el: HTMLElement, onRemoved: () => void): void {
  const observer = new MutationObserver(() => {
    if (el.isConnected) return;
    observer.disconnect();
    onRemoved();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function mount(container: HTMLElement): void {
  // No `height` override: `container` is a descendant of `.demo`, so it
  // inherits `--demo-h` from the single value set in site/index.html.
  const { view, destroy } = mountDemoEditor(container, { doc: before });
  // The chrome panel now lives in the slide's left column (under the copy),
  // as a cousin of `.demo`/`container` rather than a preceding sibling — the
  // nearest ancestor shared by both is `.slide` itself. See site/index.html.
  const chrome = container.closest('.slide')?.querySelector<HTMLElement>('[data-demo-chrome="edit"]') ?? null;
  const terminal = chrome ? buildTerminal(chrome) : null;

  if (prefersReducedMotion()) {
    // Static final state: the real diff, applied in one shot, highlighted
    // exactly like a genuine `mdmini edit` would leave it — no typing, no
    // loop. The terminal (if present) is rendered already "done" for the
    // same reason: no animation, but the whole story is still legible.
    const repl = computeReplacement(before, after);
    if (repl) {
      view.dispatch({
        changes: ChangeSet.of(repl, view.state.doc.length),
        effects: [setAiHighlights.of([{ from: repl.from, to: repl.from + repl.insert.length }])],
      });
    }
    if (terminal) {
      terminal.commandEl.textContent = COMMAND_TEXT;
      showToolLine(terminal);
      showResult(terminal, repl);
    }
    watchRemoval(container, destroy);
    return;
  }

  let alive = true;
  let onScreen = true;
  let resumeResolvers: Array<() => void> = [];

  function runningNow(): boolean {
    return onScreen && !document.hidden;
  }

  /** Wakes anything blocked in `waitUntilRunning`, whether resuming or tearing down. */
  function flushResumeWaiters(): void {
    const waiters = resumeResolvers;
    resumeResolvers = [];
    waiters.forEach((resolve) => resolve());
  }

  function waitUntilRunning(): Promise<void> {
    if (!alive || runningNow()) return Promise.resolve();
    return new Promise((resolve) => resumeResolvers.push(resolve));
  }

  // Off-screen while another carousel slide is showing, or the section has
  // scrolled out of view entirely — no point animating a typed command
  // nobody can see, or burning timers in a background tab.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) onScreen = entry.isIntersecting;
      flushResumeWaiters();
    },
    { threshold: 0 }
  );
  io.observe(container);

  function onVisibilityChange(): void {
    flushResumeWaiters();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /** Waits out one pacing beat, gated on being on-screen and foregrounded. Returns false if torn down meanwhile. */
  async function beat(ms: number): Promise<boolean> {
    await waitUntilRunning();
    if (!alive) return false;
    await sleep(ms);
    return alive;
  }

  async function typeText(el: HTMLElement, text: string, msPerChar: number): Promise<boolean> {
    el.textContent = '';
    for (const ch of text) {
      el.textContent += ch;
      if (!(await beat(msPerChar))) return false;
    }
    return true;
  }

  // Presents a single real diff as a progressive typing effect: the old
  // span is removed once, then the new text is inserted one character at a
  // time at the same position a one-shot `ChangeSet.of(repl, ...)` would
  // use. The document converges on exactly `after` either way, so the
  // final state — and the highlight applied once it's reached — is the
  // genuine diff, not a look-alike.
  async function typeEdit(repl: Replacement | null): Promise<boolean> {
    if (!repl) return true;
    const { from, to, insert } = repl;
    view.dispatch({ changes: { from, to, insert: '' } });
    let pos = from;
    for (const ch of insert) {
      view.dispatch({ changes: { from: pos, to: pos, insert: ch } });
      pos += ch.length;
      if (!(await beat(TYPE_EDIT_MS))) return false;
    }
    view.dispatch({ effects: setAiHighlights.of([{ from, to: from + insert.length }]) });
    return true;
  }

  function revertAll(): void {
    const repl = computeReplacement(view.state.doc.toString(), before);
    if (repl) {
      view.dispatch({
        changes: ChangeSet.of(repl, view.state.doc.length),
        effects: [clearAiHighlights.of(null)],
      });
    }
    if (terminal) resetTerminal(terminal);
  }

  async function runCycle(): Promise<boolean> {
    if (terminal) terminal.cursorEl.classList.add('is-blinking');
    if (terminal && !(await typeText(terminal.commandEl, COMMAND_TEXT, TYPE_COMMAND_MS))) return false;
    if (!(await beat(ENTER_PAUSE_MS))) return false;
    if (terminal) terminal.cursorEl.classList.remove('is-blinking');

    if (!(await beat(TOOL_REVEAL_PAUSE_MS))) return false;
    if (terminal) showToolLine(terminal);

    if (!(await beat(RUNNING_MS))) return false;

    const repl = computeReplacement(view.state.doc.toString(), after);
    if (terminal) showResult(terminal, repl);

    if (!(await beat(RESULT_PAUSE_MS))) return false;
    if (!(await typeEdit(repl))) return false;
    if (!(await beat(READ_PAUSE_MS))) return false;

    revertAll();
    return beat(REVERT_PAUSE_MS);
  }

  async function loop(): Promise<void> {
    while (alive) {
      if (!(await runCycle())) return;
    }
  }

  void loop();

  watchRemoval(container, () => {
    alive = false;
    io.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    flushResumeWaiters();
    destroy();
  });
}
