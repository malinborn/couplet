import { type StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { addAiComment, clearAiComments } from '@app/lib/editor/ai-comment';
import { clearAiHighlights, setAiHighlights } from '@app/lib/editor/ai-highlight';
import { anchorPosition, type CommentThread } from '@app/lib/comment-format';
import { mountDemoEditor, prefersReducedMotion } from './editor-demo';

/**
 * The reverse direction of the AI interface: the visitor asks, the agent
 * answers. Every artifact on screen is the real thing — the comment cards are
 * `CommentWidget` from `@app/lib/editor/ai-comment`, the anchor highlight is
 * the app's own `cm-ai-comment-anchor` mark, and every line the terminal
 * prints is a real format:
 *
 *   - the pasted prompt is the first line of `buildWatchPrompt()`
 *   - the Monitor call is what that prompt tells the agent to run
 *   - the `[mdmini] …` wake-up line is `event_line()` from src-tauri/src/watch.rs
 *   - `mdmini answer <doc> --id <id>` is the verb from docs/ai-interface.md
 *
 * Nothing here spawns or simulates an AI beyond replaying that transcript, and
 * the terminal labels the agent's rows explicitly so a visitor doesn't read
 * them as commands they have to type by hand.
 *
 * Scripted, not interactive. `.cm-ai-comment` gets `pointer-events: none` in
 * demo-comment.css for this slide only: the loop owns the timeline, so a click
 * the script then overwrote would read as a broken button. The ask slide is
 * interactive because answering *is* its subject; here the subject is the
 * round trip.
 */

// Lines stay short enough not to wrap in the card's content width, so the
// height this slide needs is predictable. Both quoted fragments are plain prose
// on purpose: a programmatic selection makes `cursorInRange()` reveal raw
// markdown wherever it lands (see site/CLAUDE.md), so a fragment containing
// `**bold**` would flash its asterisks the moment the demo selected it.
const DOC = `# Launch plan

## Rollout

We ship to ten percent on Monday.

Pricing copy is with legal.`;

/**
 * The two commented fragments. Both are <= 30 characters, which is what
 * `quotePreview()` shows whole — longer ones elide to first-15 + last-15, and
 * an elided excerpt in a demo header reads as a rendering glitch rather than as
 * the deliberate shortening it is.
 */
const QUOTE_1 = 'ten percent on Monday';
const QUOTE_2 = 'Pricing copy is with legal';

const QUESTION_1 = 'add the rollback trigger we agreed on';
const ANSWER_1 = 'Roll back if the error rate stays above 2% for five minutes.';

const QUESTION_2 = 'is legal review blocking the launch?';
const ANSWER_2 = 'No — sign-off lands Thursday.';

// `c-` plus six hex digits, the shape `comments::new_id` produces.
const ID_1 = 'c-4f2a1b';
const ID_2 = 'c-9d7e33';

// The app writes UTC and says so — see the `fmt_utc` note in CLAUDE.md.
const AT_HUMAN_1 = '2026-08-24 09:12:04 UTC';
const AT_AGENT_1 = '2026-08-24 09:12:11 UTC';
const AT_HUMAN_2 = '2026-08-24 09:12:26 UTC';
const AT_AGENT_2 = '2026-08-24 09:12:33 UTC';

const DOC_NAME = 'plan.md';
const WATCH_DIR = '~/launch';

/** The AI menu of the real app, in its real order — see src-tauri/src/menu.rs. */
const MENU_ITEMS: ReadonlyArray<{
  label: string;
  accel?: string;
  sep?: boolean;
  pick?: boolean;
}> = [
  { label: 'Getting Started' },
  { label: '', sep: true },
  { label: 'Connect AI via CLI' },
  { label: 'Connect AI via MCP' },
  { label: 'Teach your AI mdmini' },
  { label: '', sep: true },
  { label: 'Comment on Selection', accel: '⇧⌘M' },
  { label: 'Connect Agent to Doc Questions', pick: true },
  { label: '', sep: true },
  { label: 'AI Playbook' },
];

const PASTED_PROMPT = `Watch for my comments under ${WATCH_DIR} and answer them.`;
const MONITOR_CALL = `Monitor({command: "mdmini watch ${WATCH_DIR}", persistent: true})`;
const WATCHING_NOTE = 'watching — a new comment interrupts me';

/** `event_line()` from src-tauri/src/watch.rs, verbatim in shape. */
function eventLine(id: string, quote: string, question: string): string {
  return `[mdmini] ${DOC_NAME} ${id} · «${quote}» · ${question}`;
}

function answerCall(id: string): string {
  return `mdmini answer ${DOC_NAME} --id ${id}`;
}

// Typing speeds. Note there is no paste speed: the watch prompt is pasted, so
// it lands whole, in one frame, with a ⌘V keycap next to it. Typing it out
// character by character read as "write this by hand", which is the one thing
// this step is not — the prompt comes from the AI menu, already on the
// clipboard.
const MS_AGENT = 13;
const MS_HUMAN = 30;
const MS_SELECT = 15;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Watches for `el` leaving the document and runs `onRemoved` once. */
function watchRemoval(el: HTMLElement, onRemoved: () => void): void {
  const observer = new MutationObserver(() => {
    if (el.isConnected) return;
    observer.disconnect();
    onRemoved();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

type ThreadState = CommentThread;

interface TerminalDom {
  root: HTMLElement;
  body: HTMLElement;
}

type RowKind = 'in' | 'tool' | 'note' | 'event';

/**
 * The terminal in the slide's left column.
 *
 * Its body is a fixed-height scroller rather than a stack of reserved rows (the
 * shape demo-edit.css uses): this transcript grows by seven rows across the loop
 * and the `[mdmini]` wake-up line is long enough to wrap, so reserving every row
 * up front would need either a very tall panel or a truncation of the one line
 * carrying the most meaning. A fixed height with the content scrolling inside
 * keeps the panel's own box constant — the property that actually matters, since
 * a chrome panel changing height mid-loop shifts the carousel controls under a
 * stationary cursor and can permanently latch the showcase ribbon's hover-pause
 * (see site/styles/demo-edit.css).
 */
function buildTerminal(host: HTMLElement): TerminalDom {
  host.textContent = '';
  host.classList.add('cmt-term');
  host.innerHTML = `
    <div class="cmt-term-bar">
      <span class="cmt-term-dot cmt-term-dot--red"></span>
      <span class="cmt-term-dot cmt-term-dot--yellow"></span>
      <span class="cmt-term-dot cmt-term-dot--green"></span>
      <span class="cmt-term-title">claude &mdash; ${WATCH_DIR}</span>
    </div>
    <div class="cmt-term-body"></div>
  `;
  const body = host.querySelector<HTMLElement>('.cmt-term-body');
  if (!body) throw new Error('cmt-term: body missing');
  return { root: host, body };
}

/**
 * The ⌘V keycap, built to sit *at the insertion point* — inline in the row,
 * right after the `$`, exactly where the text is about to appear.
 *
 * An earlier version parked a badge in the panel's corner. It stated the fact
 * but did not read as an action: the eye had to connect a label in one place to
 * text appearing in another. Pressing a key where the text lands, and swapping
 * the two in one frame, is what makes it read as a paste rather than as typing.
 */
function makeKeycap(): HTMLElement {
  const key = document.createElement('span');
  key.className = 'cmt-term-key';
  key.setAttribute('aria-hidden', 'true');
  for (const glyph of ['⌘', 'V']) {
    const cap = document.createElement('span');
    cap.className = 'cmt-term-keycap';
    cap.textContent = glyph;
    key.appendChild(cap);
  }
  return key;
}

/** Appends a row and returns the span its text goes into. */
function addRow(term: TerminalDom, kind: RowKind): HTMLElement {
  const row = document.createElement('div');
  row.className = `cmt-term-row cmt-term-row--${kind}`;

  if (kind === 'in') {
    const prompt = document.createElement('span');
    prompt.className = 'cmt-term-prompt';
    prompt.textContent = '$';
    row.appendChild(prompt);
  } else if (kind === 'tool') {
    // Labelled, so a visitor reads this as their agent calling mdmini — not as
    // another command they are expected to type.
    const tag = document.createElement('span');
    tag.className = 'cmt-term-tag';
    tag.textContent = 'agent';
    row.appendChild(tag);
  } else if (kind === 'note') {
    const arrow = document.createElement('span');
    arrow.className = 'cmt-term-arrow';
    arrow.textContent = '→';
    row.appendChild(arrow);
  }

  const text = document.createElement('span');
  text.className = 'cmt-term-text';
  row.appendChild(text);
  term.body.appendChild(row);
  // Set once per row, not per frame — no float accumulator needed here (contrast
  // the showcase ribbon's sub-pixel scroll, where rounding ate every delta).
  term.body.scrollTop = term.body.scrollHeight;
  return text;
}

/** The cards are exhibits in this demo — see the file header. */
const INERT_ACTIONS = {
  save: () => {},
  flush: () => {},
  sendNow: () => {},
  resolve: () => {},
  handoff: () => {},
  insertIntoText: () => {},
};

export function mount(container: HTMLElement): void {
  // No `height` option: `--demo-h` is set once, in site/index.html.
  const { view, destroy } = mountDemoEditor(container, { doc: DOC });

  const slide = container.closest('.slide');
  const chromeHost = slide?.querySelector<HTMLElement>('[data-demo-chrome="comment"]');
  const terminal = chromeHost ? buildTerminal(chromeHost) : null;

  // The card is `.demo`; the editor mounts into its `.demo-body`. The menu and
  // the toast are decorative chrome (aria-hidden), so they may be built here
  // rather than in the markup — the slide's real copy carries the meaning.
  const card = container.closest<HTMLElement>('.demo');
  const overlay = card ? buildOverlay(card) : null;

  /** Parked clear of both fragments, on the blank line mountDemoEditor appends. */
  const parkAnchor = view.state.doc.length;

  const threads: ThreadState[] = [];

  function lineOf(quote: string): number {
    const doc = view.state.doc.toString();
    const at = doc.indexOf(quote);
    return at < 0 ? 1 : doc.slice(0, at).split('\n').length;
  }

  /**
   * Redraws every live card, the way the app's own `reloadComments()` does:
   * clear, then add. `addAiComment` does not replace a widget with the same id —
   * it appends another one — so re-adding without the clear would stack
   * duplicate cards on the same line.
   *
   * A redraw rebuilds the card DOM, which discards anything typed into a reply
   * input, so the sequence below never redraws while it is mid-type.
   *
   * Every thread is passed as a **snapshot**, never as the live object the
   * sequence mutates. `CommentWidget.eq()` compares thread fields, so handing
   * it the same object twice makes it compare that object with itself —
   * `a.id === b.id` and every reply check trivially pass, `eq()` returns true,
   * and CM6 keeps the widget's original DOM forever. Measured: the first card
   * stayed on `draft:1 · waiting for agent` for the whole loop while the
   * terminal happily printed its answer. The app never hits this because it
   * re-reads threads from the file, getting fresh objects each reload.
   */
  function render(): void {
    const doc = view.state.doc.toString();
    // Annotated, not inferred: the first element would otherwise fix the array
    // to `StateEffect<null>` and reject every `addAiComment` after it.
    const effects: StateEffect<unknown>[] = [clearAiComments.of(null)];
    for (const live of threads) {
      const thread: ThreadState = { ...live, replies: live.replies.map((r) => ({ ...r })) };
      const { pos, to, orphaned } = anchorPosition(doc, thread.quote, thread.line);
      effects.push(addAiComment.of({ thread, pos, to, orphaned, actions: INERT_ACTIONS }));
    }
    view.dispatch({ effects });
  }

  function cardEl(id: string): HTMLElement | null {
    return view.dom.querySelector<HTMLElement>(`[data-comment-thread="${id}"]`);
  }

  function replyInput(id: string): HTMLTextAreaElement | null {
    return cardEl(id)?.querySelector<HTMLTextAreaElement>('.cm-ai-comment-input') ?? null;
  }

  /** One of the app's own buttons, found by its label. */
  function buttonEl(id: string, label: string): HTMLElement | null {
    const buttons = cardEl(id)?.querySelectorAll<HTMLElement>('.cm-ai-comment-button');
    if (!buttons) return null;
    for (const button of buttons) {
      if (button.textContent?.trim() === label) return button;
    }
    return null;
  }

  if (prefersReducedMotion()) {
    // One settled frame: the watch armed, both questions asked and answered. No
    // typing, no loop, no scrolling.
    if (terminal) {
      addRow(terminal, 'in').textContent = PASTED_PROMPT;
      addRow(terminal, 'tool').textContent = MONITOR_CALL;
      addRow(terminal, 'note').textContent = WATCHING_NOTE;
      addRow(terminal, 'event').textContent = eventLine(ID_1, QUOTE_1, QUESTION_1);
      addRow(terminal, 'tool').textContent = answerCall(ID_1);
      addRow(terminal, 'event').textContent = eventLine(ID_2, QUOTE_2, QUESTION_2);
      addRow(terminal, 'tool').textContent = answerCall(ID_2);
    }
    threads.push(
      answeredThread(ID_1, QUOTE_1, lineOf(QUOTE_1), QUESTION_1, ANSWER_1, AT_HUMAN_1, AT_AGENT_1),
      answeredThread(ID_2, QUOTE_2, lineOf(QUOTE_2), QUESTION_2, ANSWER_2, AT_HUMAN_2, AT_AGENT_2)
    );
    render();
    watchRemoval(container, destroy);
    return;
  }

  // Generation counter: every timer captures the generation it was scheduled
  // under and no-ops once `gen` moves on (pause, restart, unmount). Same pattern
  // as site/demos/point.ts, and the reason `stop()` can be called from three
  // independent places without them fighting.
  let gen = 0;
  let timer: number | undefined;
  let raf: number | undefined;

  function sleep(ms: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      timer = window.setTimeout(() => {
        timer = undefined;
        resolve(myGen === gen);
      }, ms);
    });
  }

  function typeInto(
    write: (value: string) => void,
    text: string,
    msPerChar: number,
    myGen: number
  ): Promise<boolean> {
    write('');
    return new Promise((resolve) => {
      let i = 0;
      const step = (): void => {
        if (myGen !== gen) {
          resolve(false);
          return;
        }
        if (i >= text.length) {
          resolve(true);
          return;
        }
        i += 1;
        write(text.slice(0, i));
        timer = window.setTimeout(step, msPerChar);
      };
      step();
    });
  }

  /**
   * Animates the card's own scroller. Never `EditorView.scrollIntoView`: that
   * walks up to the nearest scrollable ancestor, finds none between the card
   * and `<body>`, and calls `window.scrollBy` — which yanks a reader back to
   * the carousel mid-read (site/CLAUDE.md documents the version of this bug
   * that shipped once already). Writing `scrollTop` directly keeps every pixel
   * of movement inside the card.
   *
   * The viewport-recompute dance point.ts needs does not apply here: this
   * document is nine lines long, so CM6 has all of it drawn and a widget never
   * lands outside the drawn range.
   */
  function scrollTo(targetTop: number, durationMs: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const scroller = view.scrollDOM;
      const startTop = scroller.scrollTop;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const endTop = Math.max(0, Math.min(targetTop, max));
      const delta = endTop - startTop;
      if (Math.abs(delta) < 1) {
        resolve(myGen === gen);
        return;
      }
      const startTime = performance.now();
      const step = (now: number): void => {
        if (myGen !== gen) {
          resolve(false);
          return;
        }
        const t = Math.min(1, (now - startTime) / durationMs);
        scroller.scrollTop = startTop + delta * easeInOutCubic(t);
        if (t < 1) {
          raf = requestAnimationFrame(step);
        } else {
          raf = undefined;
          resolve(true);
        }
      };
      raf = requestAnimationFrame(step);
    });
  }

  /** Offset of `el`'s top within the scroller's content. */
  function offsetInScroller(el: Element): number {
    const scroller = view.scrollDOM;
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  /**
   * Brings a card fully into view, preferring to show the text it is anchored
   * to above it — a card whose fragment has scrolled off is exactly the
   * "which words is this about?" confusion the anchor highlight exists to fix.
   */
  async function revealCard(id: string, myGen: number): Promise<boolean> {
    const cardNode = cardEl(id)?.closest('.cm-ai-comment-wrap');
    if (!cardNode) return myGen === gen;
    const scroller = view.scrollDOM;
    const top = offsetInScroller(cardNode);
    const height = cardNode.getBoundingClientRect().height;
    // Bottom-aligned with a small margin, then pulled back up far enough to
    // keep the anchored line above the card on screen.
    const target = Math.min(top - 34, top + height + 16 - scroller.clientHeight);
    return scrollTo(target, 520, myGen);
  }

  /** Brings a fragment into view before the demo selects it. */
  async function revealQuote(quote: string, myGen: number): Promise<boolean> {
    const doc = view.state.doc.toString();
    const at = doc.indexOf(quote);
    if (at < 0) return myGen === gen;
    const block = view.lineBlockAt(at);
    const scroller = view.scrollDOM;
    if (block.top >= scroller.scrollTop && block.bottom <= scroller.scrollTop + scroller.clientHeight) {
      return myGen === gen;
    }
    return scrollTo(block.top - 48, 460, myGen);
  }

  /** Grows a selection across `quote`, the way dragging over it would. */
  async function selectQuote(quote: string, myGen: number): Promise<boolean> {
    const doc = view.state.doc.toString();
    const from = doc.indexOf(quote);
    if (from < 0) return myGen === gen;
    for (let i = 1; i <= quote.length; i += 1) {
      if (myGen !== gen) return false;
      view.dispatch({ selection: { anchor: from, head: from + i } });
      if (!(await sleep(MS_SELECT, myGen))) return false;
    }
    return true;
  }

  /**
   * Flashes a button before the script performs its action. The cards are inert
   * here (no pointer events, no cursor on screen), so without this the document
   * would just change with nothing on screen to explain why.
   */
  async function press(id: string, label: string, myGen: number): Promise<boolean> {
    const button = buttonEl(id, label);
    button?.classList.add('cmt-press');
    if (!(await sleep(340, myGen))) return false;
    button?.classList.remove('cmt-press');
    return true;
  }

  /**
   * Tells the app's attention plugin which card is being worked in, which
   * shimmers that card's fragment in the text (the card → fragment direction of
   * the link). A synthetic `focusin` rather than a real `input.focus()`: real
   * focus inside a carousel slide scrolls the visitor's page to it.
   */
  function claimAttention(id: string): void {
    const input = replyInput(id);
    input?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  }

  async function armWatch(myGen: number): Promise<boolean> {
    if (!overlay || !terminal) return myGen === gen;

    if (!(await sleep(600, myGen))) return false;
    overlay.menu.classList.add('is-open');
    // Held long enough to actually read the item being picked — measured at
    // 1.6s total on screen first, which was not enough to find one line in a
    // ten-item menu.
    if (!(await sleep(1300, myGen))) return false;
    overlay.pick?.classList.add('is-picked');
    if (!(await sleep(950, myGen))) return false;
    overlay.menu.classList.remove('is-open');
    overlay.pick?.classList.remove('is-picked');
    overlay.toast.classList.add('is-visible');
    if (!(await sleep(500, myGen))) return false;

    // The paste, as one tactile beat: the keycap appears at the prompt, is
    // pressed, and the whole line replaces it in a single frame. Never typed
    // out character by character — the prompt came off the clipboard, put there
    // by the AI menu, and typing it would say "write this yourself".
    const pasted = addRow(terminal, 'in');
    const key = makeKeycap();
    pasted.parentElement?.appendChild(key);
    if (!(await sleep(80, myGen))) return false;
    key.classList.add('is-in');
    if (!(await sleep(420, myGen))) return false;
    key.classList.add('is-pressed');
    if (!(await sleep(190, myGen))) return false;

    key.remove();
    pasted.textContent = PASTED_PROMPT;
    pasted.parentElement?.classList.add('is-pasted');
    terminal.body.scrollTop = terminal.body.scrollHeight;
    if (!(await sleep(900, myGen))) return false;
    overlay.toast.classList.remove('is-visible');
    if (!(await sleep(260, myGen))) return false;

    const call = addRow(terminal, 'tool');
    if (
      !(await typeInto(
        (v) => {
          call.textContent = v;
        },
        MONITOR_CALL,
        MS_AGENT,
        myGen
      ))
    ) {
      return false;
    }
    if (!(await sleep(220, myGen))) return false;
    addRow(terminal, 'note').textContent = WATCHING_NOTE;
    return sleep(700, myGen);
  }

  /**
   * One question end to end: select, comment, type, send, get woken, answer.
   * The thread object is pushed into `threads` and mutated in place as its
   * status moves, so `render()` always draws the current state of every card.
   */
  async function ask(
    myGen: number,
    spec: {
      id: string;
      quote: string;
      question: string;
      answer: string;
      atHuman: string;
      atAgent: string;
      draftId: string;
    }
  ): Promise<boolean> {
    const line = lineOf(spec.quote);

    if (!(await revealQuote(spec.quote, myGen))) return false;
    if (!(await selectQuote(spec.quote, myGen))) return false;
    if (!(await sleep(300, myGen))) return false;

    // A draft carries the synthetic id the app gives it (`draft:N`) and no
    // replies — the file, and the real `c-…` id, come into existence with the
    // first text. Shown as-is rather than pre-faked, because that is the state a
    // visitor actually sees in the app.
    const draft: ThreadState = {
      id: spec.draftId,
      status: 'open',
      line,
      quote: spec.quote,
      replies: [],
    };
    threads.push(draft);
    render();
    if (!(await revealCard(spec.draftId, myGen))) return false;
    if (!(await sleep(420, myGen))) return false;

    claimAttention(spec.draftId);
    const input = replyInput(spec.draftId);
    if (input) {
      if (
        !(await typeInto(
          (v) => {
            input.value = v;
          },
          spec.question,
          MS_HUMAN,
          myGen
        ))
      ) {
        return false;
      }
    }
    if (!(await sleep(420, myGen))) return false;

    // Enter in the reply input is what creates the thread: the draft becomes a
    // real thread with the human's text as its first reply, still `open` —
    // "waiting for agent" — until an answer lands.
    draft.id = spec.id;
    draft.replies = [{ author: 'You', at: spec.atHuman, text: spec.question }];
    render();
    if (!(await sleep(520, myGen))) return false;

    if (terminal) {
      // The wake-up. This line is the whole feature: the agent's session is
      // interrupted by it, without the editor reaching into that session.
      addRow(terminal, 'event').textContent = eventLine(spec.id, spec.quote, spec.question);
      if (!(await sleep(700, myGen))) return false;
      const call = addRow(terminal, 'tool');
      if (
        !(await typeInto(
          (v) => {
            call.textContent = v;
          },
          answerCall(spec.id),
          MS_AGENT,
          myGen
        ))
      ) {
        return false;
      }
      if (!(await sleep(380, myGen))) return false;
    }

    draft.status = 'answered';
    draft.replies = [...draft.replies, { author: 'agent', at: spec.atAgent, text: spec.answer }];
    render();
    // The card just grew by a reply and a button, so what was fully visible a
    // moment ago no longer is.
    if (!(await revealCard(spec.id, myGen))) return false;
    // Long enough to actually read the answer. Measured at 600ms first, which
    // left the second answer on screen for barely a second before the resolve
    // beat scrolled away from it.
    return sleep(1400, myGen);
  }

  /** Drops a thread, the way resolving it does — a resolved thread is not drawn. */
  function drop(id: string): void {
    const at = threads.findIndex((t) => t.id === id);
    if (at >= 0) threads.splice(at, 1);
    render();
  }

  async function loop(myGen: number): Promise<void> {
    for (;;) {
      // Reset: empty terminal, no cards, the document as authored.
      if (terminal) terminal.body.textContent = '';
      overlay?.toast.classList.remove('is-visible');
      threads.length = 0;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: `${DOC}\n\n` },
        effects: [clearAiComments.of(null), clearAiHighlights.of(null)],
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.scrollDOM.scrollTop = 0;

      if (!(await armWatch(myGen))) return;

      if (
        !(await ask(myGen, {
          id: ID_1,
          quote: QUOTE_1,
          question: QUESTION_1,
          answer: ANSWER_1,
          atHuman: AT_HUMAN_1,
          atAgent: AT_AGENT_1,
          draftId: 'draft:1',
        }))
      ) {
        return;
      }

      // The second question goes out while the first answer is still on screen —
      // nothing waits for a turn.
      if (
        !(await ask(myGen, {
          id: ID_2,
          quote: QUOTE_2,
          question: QUESTION_2,
          answer: ANSWER_2,
          atHuman: AT_HUMAN_2,
          atAgent: AT_AGENT_2,
          draftId: 'draft:2',
        }))
      ) {
        return;
      }

      if (!(await sleep(900, myGen))) return;

      // The first answer asked for a change, so it is folded into the document:
      // a normal, undoable insertion at the card's own position, exactly what
      // `insertIntoText` dispatches in the app.
      if (!(await revealCard(ID_1, myGen))) return;
      if (!(await sleep(400, myGen))) return;
      claimAttention(ID_1);
      if (!(await press(ID_1, 'insert into text', myGen))) return;
      const at = commentWidgetLine(view, ID_1);
      if (at !== null) {
        // Highlighted exactly as `insertIntoText` does it in the app: text from
        // an agent reads the same whether it arrived via `mdmini edit` (the
        // edit slide, two slides back) or via a comment thread.
        view.dispatch({
          changes: { from: at, insert: `\n${ANSWER_1}\n` },
          effects: setAiHighlights.of([{ from: at + 1, to: at + 1 + ANSWER_1.length }]),
        });
      }
      if (!(await sleep(900, myGen))) return;

      if (!(await press(ID_1, 'resolve', myGen))) return;
      drop(ID_1);
      if (!(await sleep(700, myGen))) return;

      // The second was a question, not an edit request — resolved as it stands.
      if (!(await revealCard(ID_2, myGen))) return;
      if (!(await sleep(400, myGen))) return;
      claimAttention(ID_2);
      if (!(await press(ID_2, 'resolve', myGen))) return;
      drop(ID_2);

      view.dispatch({ selection: { anchor: Math.min(parkAnchor, view.state.doc.length) } });
      // Back to the top for the held frame: with both cards gone the document
      // fits again, and it now carries the line the agent supplied.
      if (!(await scrollTo(0, 520, myGen))) return;
      if (!(await sleep(2200, myGen))) return;
    }
  }

  let running = false;

  function stop(): void {
    if (!running) return;
    running = false;
    gen += 1;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (raf !== undefined) {
      cancelAnimationFrame(raf);
      raf = undefined;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    gen += 1;
    void loop(gen);
  }

  let onScreen = false;

  function sync(): void {
    if (onScreen && !document.hidden) start();
    else stop();
  }

  const intersectionObserver = new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1]?.isIntersecting ?? false;
    sync();
  });
  intersectionObserver.observe(container);

  document.addEventListener('visibilitychange', sync);

  watchRemoval(container, () => {
    stop();
    intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', sync);
    destroy();
  });
}

/** A thread in its final state, for the reduced-motion frame. */
function answeredThread(
  id: string,
  quote: string,
  line: number,
  question: string,
  answer: string,
  atHuman: string,
  atAgent: string
): ThreadState {
  return {
    id,
    status: 'answered',
    line,
    quote,
    replies: [
      { author: 'You', at: atHuman, text: question },
      { author: 'agent', at: atAgent, text: answer },
    ],
  };
}

/**
 * Where a card currently sits, resolved from the live DOM rather than from a
 * remembered offset — the same reason the app's own `commentWidgetPos` does it
 * this way: the document has changed since the card was added.
 */
function commentWidgetLine(view: EditorView, id: string): number | null {
  const card = view.dom.querySelector<HTMLElement>(`[data-comment-thread="${id}"]`);
  const wrap = card?.closest('.cm-ai-comment-wrap');
  if (!wrap) return null;
  const pos = view.posAtDOM(wrap);
  return view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).to;
}

interface Overlay {
  menu: HTMLElement;
  pick: HTMLElement | null;
  toast: HTMLElement;
}

/**
 * The AI menu and the toast that follows picking its watch item. Decorative
 * chrome: `aria-hidden`, no tab stops, and the slide's copy says the same thing
 * in text.
 */
function buildOverlay(card: HTMLElement): Overlay {
  const menu = document.createElement('div');
  menu.className = 'cmt-menu';
  menu.setAttribute('aria-hidden', 'true');

  const bar = document.createElement('div');
  bar.className = 'cmt-menu-bar';
  bar.textContent = 'AI';
  menu.appendChild(bar);

  const list = document.createElement('div');
  list.className = 'cmt-menu-list';
  let pick: HTMLElement | null = null;
  for (const item of MENU_ITEMS) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'cmt-menu-sep';
      list.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'cmt-menu-item';
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    if (item.accel) {
      const accel = document.createElement('span');
      accel.className = 'cmt-menu-accel';
      accel.textContent = item.accel;
      row.appendChild(accel);
    }
    if (item.pick) pick = row;
    list.appendChild(row);
  }
  menu.appendChild(list);

  const toast = document.createElement('div');
  toast.className = 'cmt-toast';
  toast.setAttribute('aria-hidden', 'true');
  toast.innerHTML =
    '<strong>Watch command copied</strong><span class="cmt-toast-dim">&mdash; paste it into your agent&rsquo;s session</span>';

  card.appendChild(menu);
  card.appendChild(toast);
  return { menu, pick, toast };
}
