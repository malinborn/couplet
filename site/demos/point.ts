import { EditorView } from '@codemirror/view';
import { clearAiHighlights, pulseAiLine } from '@app/lib/editor/ai-highlight';
import { resolveShowTarget } from '@app/lib/ai-commands';
import { mountDemoEditor, prefersReducedMotion } from './editor-demo';

/**
 * Two short sentences that both plausibly answer "where's the rollback
 * procedure stated?" — one under "Rollback procedure", the other in the FAQ
 * near the bottom, far enough apart that reaching the second requires a real
 * scroll inside the card.
 *
 * `pulseAiLine` highlights the *entire physical source line* the target sits
 * on (`doc.lineAt(pos)` in ai-highlight.ts), not just the matched substring —
 * so it isn't enough for these two strings to be short; each must also be its
 * own whole line in DOC below, with no trailing prose sharing the line. Miss
 * that and the highlighted line is exactly as long as it would otherwise be,
 * wrapping to 2-3 rows in the card's ~383px content width and reproducing
 * the "highlight looks different" complaint this demo exists to fix (a
 * chunky wrapped block instead of the app's characteristic slim one-line
 * bar). Confirmed empirically with Playwright, not assumed — see the report.
 *
 * Both must also be unique substrings so `resolveShowTarget`'s `find`
 * matches exactly once each.
 */
const TARGET_1 = 'Rollbacks re-deploy the previous tag.';
const TARGET_2 = 'Re-deploy the previous tag, nothing else.';

// Runbook long enough that TARGET_1 and TARGET_2 are never both on screen at
// once inside the card's 410px body — see mount() for why that matters.
const DOC = `# Rollback runbook

## When to roll back

Roll back when the health check fails twice in a row after a deploy, or when
error rates jump right after a release ships.

## Rollback procedure

${TARGET_1}

The registry keeps the last five artifacts pinned, so the previous build is
always one command away.

1. Confirm the previous tag is still in the registry.
2. Flip the deployment alias back to that tag.
3. Watch the health check turn green before closing the incident.

## Database changes

Schema changes are never rolled back automatically. If the release included
a migration, check whether it needs an explicit down-migration first.

## Monitoring during a rollback

Watch the error-rate dashboard and the health check panel for five minutes
after the alias flip. If the alert doesn't clear in that window, escalate.

## Access and permissions

Only on-call engineers and the platform team can flip the deployment alias.
Everyone else should page on-call instead of trying it themselves.

## Communication

Post a one-line status update in the incident channel the moment the
rollback starts, and another once the health check turns green.

## Runbook FAQ

**Q: Where's the rollback procedure again?**
${TARGET_2}

**Q: What if the previous tag also fails health checks?**
Stop and escalate — see below.

## Escalation

Page the on-call engineer if the rollback itself fails.`;

// The chrome's tiny agent conversation: a human question typed at a readable
// pace, then a real `mdmini show` invocation (see docs/ai-interface.md) and
// its result note, both typed faster — tool traffic, not dialogue.
//
// The second and third rows are explicitly labelled "agent" (not a bare `$`
// shell prompt) and visually grouped under the human's line by a connector
// in demo-point.css, precisely so a first-time visitor doesn't read this as
// "type this command yourself" — it's the visitor's own agent (Claude Code
// or any MCP client) calling mdmini's real CLI, per docs/ai-interface.md.
//
// Kept short on purpose: this line has to fit, fully typed, inside the
// chrome panel's own narrow content width on a 390px phone viewport without
// wrapping (the panel's reserved height assumes a single line per row — see
// demo-point.css). `text-overflow: ellipsis` is a defensive fallback, not
// the plan.
const QUESTION = 'once again — where’s the rollback procedure stated?';
const COMMAND_LINE = 'mdmini show runbook.md --find "previous tag"';
const RESULT_LINE = 'found it — 2 mentions, pulsing each';

const USER_CHAR_MS = 34;
const FAST_CHAR_MS = 16;
const PAUSE_AFTER_QUESTION_MS = 350;
const PAUSE_AFTER_COMMAND_MS = 200;
const PAUSE_BEFORE_SCROLL_MS = 450;
const SCROLL_MS = 700;
// Comfortably above the 1.6s .cm-ai-pulse animation (src/styles/editor.css)
// so the fade always finishes before the next scroll starts.
const HOLD_MS = 1800;
const LOOP_GAP_MS = 700;

/** Watches for `el` leaving the document and runs `onRemoved` once, then stops watching. */
function watchRemoval(el: HTMLElement, onRemoved: () => void): void {
  const observer = new MutationObserver(() => {
    if (el.isConnected) return;
    observer.disconnect();
    onRemoved();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

interface ChromeNodes {
  user: HTMLElement;
  cmd: HTMLElement;
  note: HTMLElement;
}

/** Builds the three-line chat/tool-call chrome once. Text content is filled in by the sequence. */
function buildChrome(host: HTMLElement): ChromeNodes {
  host.textContent = '';

  function makeLine(modifier: string, tag: string): { line: HTMLElement; text: HTMLElement } {
    const line = document.createElement('div');
    line.className = `point-chrome-line point-chrome-line--${modifier}`;
    const tagEl = document.createElement('span');
    tagEl.className = 'point-chrome-tag';
    tagEl.textContent = tag;
    const text = document.createElement('span');
    text.className = 'point-chrome-text';
    line.append(tagEl, text);
    return { line, text };
  }

  const user = makeLine('user', 'you');
  // Labelled "agent" rather than a bare `$` — this line is the visitor's
  // own AI agent calling mdmini's real CLI (see docs/ai-interface.md), not
  // the person typing a shell command by hand.
  const cmd = makeLine('cmd', 'agent');
  const note = makeLine('note', '→');
  host.append(user.line, cmd.line, note.line);

  return { user: user.text, cmd: cmd.text, note: note.text };
}

/** Aligns `pos`'s line to the top of `view`'s own scroller.
 *
 * Uses `view.lineBlockAt(pos).top` (a height-map position, valid even for
 * lines CM6 hasn't drawn yet) rather than `coordsAtPos` + viewport math: this
 * demo's document is long enough that the second target sits outside CM6's
 * initially-rendered range, where `coordsAtPos` returns null. Setting
 * `scrollDOM.scrollTop` directly (as the single-target original version of
 * this demo did) is still what keeps this local to the card — see the git
 * history for the full story of why `EditorView.scrollIntoView` walks up to
 * `window.scrollBy` and yanks a visitor's page out from under them.
 */
function lineTop(view: EditorView, pos: number): number {
  return Math.max(0, view.lineBlockAt(pos).top);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function mount(container: HTMLElement): void {
  // No `height` override: `container` is a descendant of `.demo`, so it
  // inherits `--demo-h` from the single value set in site/index.html.
  const { view, destroy } = mountDemoEditor(container, { doc: DOC });

  const resolved1 = resolveShowTarget(view.state, { line: null, find: TARGET_1 });
  const resolved2 = resolveShowTarget(view.state, { line: null, find: TARGET_2 });
  if (resolved1 === null || resolved2 === null) return;
  // Re-bound to non-nullable `const`s: TS narrowing from the guard above
  // doesn't survive into the closures below (loop, start), which are defined
  // — and called — well after this point.
  const target1: number = resolved1;
  const target2: number = resolved2;

  // Parked off both pulsed lines (on the trailing blank line mountDemoEditor
  // appends) so cursorInRange() never turns a pulsed sentence back into raw
  // markdown mid-pulse.
  const parkAnchor = view.state.doc.length;

  // The chrome panel now lives in the slide's left column (under the copy),
  // as a cousin of `.demo`/`container` rather than a preceding sibling — the
  // nearest ancestor shared by both is `.slide` itself. See site/index.html.
  const chromeHost = container
    .closest('.slide')
    ?.querySelector<HTMLElement>('[data-demo-chrome="point"]');
  const chrome = chromeHost ? buildChrome(chromeHost) : null;

  /**
   * Reverts any `window.scrollY`/`scrollX` drift for `windowMs` after
   * calling `fn`, via a 'scroll' listener rather than a single before/after
   * check.
   *
   * `EditorView.scrollIntoView` (used below to fix CM6's viewport, not to
   * move anything) cascades through every scrollable ancestor up to
   * `window` — confirmed here to leak a page-level scroll on this specific
   * layout. That leak is neither synchronous nor tied to CSS
   * `scroll-behavior` (tried forcing `scroll-behavior: auto` on `<html>`
   * first — no difference): it lands 100-300ms later, from whatever
   * follow-up measure pass CM6 schedules internally. A single
   * before/after `window.scrollY` comparison right after `dispatch()`
   * therefore misses it entirely; a short-lived listener catches the leak
   * the instant it happens and snaps it back before the browser paints it,
   * regardless of timing.
   */
  function withPageScrollLock(fn: () => void, windowMs: number): void {
    const lockedX = window.scrollX;
    const lockedY = window.scrollY;
    const revert = (): void => {
      if (window.scrollX !== lockedX || window.scrollY !== lockedY) {
        window.scrollTo({ left: lockedX, top: lockedY, behavior: 'instant' });
      }
    };
    window.addEventListener('scroll', revert, { passive: true });
    fn();
    window.setTimeout(() => window.removeEventListener('scroll', revert), windowMs);
  }

  function firePulse(pos: number): void {
    // A CSS animation does not restart when an identical decoration is
    // re-added, so clear first and re-pulse on a later frame.
    view.dispatch({ effects: clearAiHighlights.of(null) });
    requestAnimationFrame(() => {
      withPageScrollLock(() => {
        // `EditorView.scrollIntoView(pos, { y: 'nearest' })` alongside the
        // pulse, not just `pulseAiLine` alone: CM6 only extends its *drawn*
        // viewport (which lines actually get a `.cm-line` DOM node) in
        // response to the native 'scroll' event our own scrollTo() animation
        // fires, and that update is one-shot per scroll gesture — it does
        // not re-fire for the *final*, settled scrollTop once the animation
        // stops writing new values. Confirmed empirically: after scrolling
        // to the second target, `aiHighlightField`'s decoration was
        // correctly present in state at the target's position, but
        // `view.viewport` stayed one character short of it — so the pulse
        // decoration existed but had no DOM line to attach its class to, and
        // nothing ever appeared. `scrollIntoView` forces CM6 to recompute
        // the viewport around `pos` as part of *this* transaction rather
        // than waiting on the scroll listener. `y: 'nearest'` computes zero
        // further scroll delta here (we already parked the line at the
        // scroller's top) — `withPageScrollLock` above is what actually
        // keeps this local to the card despite that.
        view.dispatch({
          selection: { anchor: parkAnchor },
          effects: [EditorView.scrollIntoView(pos, { y: 'nearest' }), pulseAiLine.of(pos)],
        });
      }, 600);
    });
  }

  if (prefersReducedMotion()) {
    if (chrome) {
      chrome.user.textContent = QUESTION;
      chrome.cmd.textContent = COMMAND_LINE;
      chrome.note.textContent = RESULT_LINE;
    }
    view.scrollDOM.scrollTop = lineTop(view, target1);
    firePulse(target1);
    watchRemoval(container, destroy);
    return;
  }

  // Generation counter: every timer/rAF callback below captures the
  // generation it was scheduled under and no-ops if `gen` has since moved on
  // (pause, resume-as-restart, or unmount). Simpler and more robust than
  // tracking every individual timer/rAF handle for cancellation, and it's
  // what lets `stop()` be called from three independent places (visibility,
  // intersection, unmount) without them fighting each other.
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

  function typeLine(el: HTMLElement, text: string, msPerChar: number, myGen: number): Promise<boolean> {
    el.textContent = '';
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
        el.textContent = text.slice(0, i);
        timer = window.setTimeout(step, msPerChar);
      };
      step();
    });
  }

  function scrollTo(pos: number, durationMs: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const scroller = view.scrollDOM;
      const startTop = scroller.scrollTop;
      const endTop = lineTop(view, pos);
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

  async function loop(myGen: number): Promise<void> {
    for (;;) {
      view.dispatch({ effects: clearAiHighlights.of(null) });

      if (chrome) {
        chrome.user.textContent = '';
        chrome.cmd.textContent = '';
        chrome.note.textContent = '';
        if (!(await typeLine(chrome.user, QUESTION, USER_CHAR_MS, myGen))) return;
        if (!(await sleep(PAUSE_AFTER_QUESTION_MS, myGen))) return;
        if (!(await typeLine(chrome.cmd, COMMAND_LINE, FAST_CHAR_MS, myGen))) return;
        if (!(await sleep(PAUSE_AFTER_COMMAND_MS, myGen))) return;
        if (!(await typeLine(chrome.note, RESULT_LINE, FAST_CHAR_MS, myGen))) return;
      }
      if (!(await sleep(PAUSE_BEFORE_SCROLL_MS, myGen))) return;

      if (!(await scrollTo(target1, SCROLL_MS, myGen))) return;
      firePulse(target1);
      if (!(await sleep(HOLD_MS, myGen))) return;

      if (!(await scrollTo(target2, SCROLL_MS, myGen))) return;
      firePulse(target2);
      if (!(await sleep(HOLD_MS, myGen))) return;

      if (!(await sleep(LOOP_GAP_MS, myGen))) return;
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
