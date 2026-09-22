import type { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { languageCompartment, previewCompartment } from '@app/lib/editor/setup';
import { livePreviewPlugin } from '@app/lib/editor/preview/plugin';
import { envPreviewPlugin } from '@app/lib/editor/preview/env';
import { shellSecretsPlugin } from '@app/lib/editor/preview/shell-secrets';
import { findCodeLanguage, isShellConfig } from '@app/lib/editor/file-language';
import { requestRender } from '@app/lib/editor/preview/mermaid';
import { mountDemoEditor, prefersReducedMotion } from './editor-demo';

// The endless ribbon (carousel slide 5) now cycles through THREE documents,
// not one, because one markdown file cannot honestly show secret masking —
// that behaviour only exists in the app's `.env` / shell-config modes. Each
// "act" below is a real document plus the real CM6 mode the app itself would
// put it in (see applyAct, which mirrors Editor.svelte's setCodeMode /
// setEnvMode almost line for line, reusing the same compartments and preview
// plugins rather than reimplementing masking or shell highlighting here).
//
// Within an act, the seam is invisible the same way the original single-doc
// ribbon made it invisible: the document is duplicated and the scroll wraps
// at exactly half the scroll height, landing on pixel-identical content.
// BETWEEN acts — where the content and the CM6 mode genuinely change, so no
// amount of clever wrapping can make it pixel-identical — the transition is
// hidden by a crossfade between two permanently-mounted, permanently
// scrolling editor "lanes" instead: both lanes are always moving, so the
// fade blends one motion into another rather than cutting from motion to a
// static frame or a jump.

interface Act {
  /** Shown in the card's title bar, exactly as the real app would name the window. */
  filename: string;
  kind: 'markdown' | 'env' | 'shell';
  /** Single copy of the document. Doubled at mount/swap time for the wrap trick. */
  body: string;
  /** Present only for the markdown act — the mermaid fence's content, verbatim. */
  mermaid?: string;
}

// The mermaid fence's content, verbatim — must match exactly what
// `decorateMermaidBlock` (src/lib/editor/preview/mermaid.ts) slices out of
// the document for this same block, character for character, since the
// render cache is keyed on this text plus the resolved theme.
const MERMAID_DIAGRAM = `flowchart LR
  A[Draft] --> B[Review]
  B --> C[Ship]
  C --> D[Watch]
  D --> E[Done]`;

const MARKDOWN_ACT: Act = {
  filename: 'README.md',
  kind: 'markdown',
  mermaid: MERMAID_DIAGRAM,
  body: `# Deploy runway

## Before you ship

Confirm the build is **reproducible** and matches the tag in \`CHANGELOG.md\`. Any heading folds its section away with a click — collapse this one once it's done.
- [x] Bump the version in \`package.json\`
- [ ] Draft the release notes

| Step | Owner | Status |
| --- | --- | --- |
| Build | CI | done |
| Notarize | CI | pending |

\`\`\`bash
npm run build:dev && open dist/md-mini-dev.app
\`\`\`

---

## Once it's out the door

The rollout is *gradual*, never **instant**, and it is ~~definitely not~~ absolutely not something we push on a Friday. Watch the crash rate in \`metrics.dashboard\`, and keep the [release notes](https://github.com/malinborn/mdmini/releases) open in a second window.

1. Announce the build
2. Watch the first hour of crash reports
3. Close the loop once it stays quiet

> If anything looks wrong, roll back first and investigate after.

\`\`\`ts
export function mountDemoEditor(parent: HTMLElement, options: DemoEditorOptions): DemoEditor {
  const view = new EditorView({ state, parent });
  return { view, destroy: () => view.destroy() };
}
\`\`\`

\`\`\`mermaid
${MERMAID_DIAGRAM}
\`\`\`

---

## While you wait

Drop this file on the Dock icon and it opens in its own window, same for a folder full of them. Quit and relaunch and every window comes back where you left it, caret included. Edit it from another terminal and couplet notices, reloading without asking — nothing here was saved on purpose, it already was. Dark got old an hour ago; one keypress and it's light again.

---`,
};

const ENV_ACT: Act = {
  filename: '.env',
  kind: 'env',
  body: `# couplet — local dev

NODE_ENV=development
PORT=4173
DATABASE_URL=postgres://localhost:5432/couplet

# third-party
STRIPE_SECRET_KEY=example-value-not-a-real-key
GITHUB_TOKEN=example-value-not-a-real-token
OPENAI_API_KEY=example-value-not-a-real-key
JWT_SECRET=example-value-not-a-real-secret

# flags
ENABLE_ANALYTICS=false
LOG_LEVEL=info`,
};

const SHELL_ACT: Act = {
  filename: '.zshrc',
  kind: 'shell',
  body: `# ~/.zshrc

export PATH="$HOME/bin:$PATH"
export EDITOR="couplet"

export OPENAI_API_KEY="example-value-not-a-real-key"

alias gs="git status"
alias ll="ls -lah"
alias md="couplet"

function mkcd() {
  mkdir -p "$1" && cd "$1"
}

if [[ -f ~/.zshrc.local ]]; then
  source ~/.zshrc.local
fi`,
};

const ACTS: readonly Act[] = [MARKDOWN_ACT, ENV_ACT, SHELL_ACT];

const SPEED_PX_PER_SEC = 26;
const CROSSFADE_MS = 700;
/** Floor so a short document (the .env / .zshrc acts) still gets a readable
 * dwell instead of flashing by the instant its short scroll height wraps. */
const MIN_DWELL_S = 6;

/**
 * Doubles the document for the wrap-in-place loop trick, then guarantees a
 * trailing blank line to park the selection on — cursorInRange() in both
 * envPreviewPlugin and shellSecretsPlugin reveals raw text under the cursor,
 * and a stray anchor on a real KV/assignment line would defeat masking.
 */
function prepareDoc(body: string): string {
  const doubled = `${body}\n\n${body}`;
  return doubled.endsWith('\n\n') ? doubled : `${doubled}\n\n`;
}

/**
 * Mirrors Editor.svelte's setCodeMode(null) / setCodeMode(ext) / setEnvMode —
 * same compartments, same preview plugins, same findCodeLanguage/isShellConfig
 * calls — so the masking and shell highlighting a visitor sees here are the
 * app's real behaviour, not a CSS impression of it. `onReady` fires once the
 * mode is actually applied (synchronously for markdown/env, after the
 * language chunk loads for shell).
 */
function applyAct(view: EditorView, act: Act, onReady: () => void): void {
  if (act.kind === 'markdown') {
    view.dispatch({
      effects: [
        languageCompartment.reconfigure(
          markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] })
        ),
        previewCompartment.reconfigure(livePreviewPlugin),
      ],
    });
    onReady();
    return;
  }

  if (act.kind === 'env') {
    view.dispatch({
      effects: [
        languageCompartment.reconfigure([]),
        previewCompartment.reconfigure(envPreviewPlugin),
      ],
    });
    onReady();
    return;
  }

  // Shell: basename doubles as both the file-language lookup key and the
  // isShellConfig() check, exactly like the real app resolving a dotfile.
  const lang = findCodeLanguage(act.filename, act.filename.replace(/^\./, ''));
  if (!lang) {
    onReady();
    return;
  }
  lang.load().then((langSupport) => {
    view.dispatch({
      effects: [
        languageCompartment.reconfigure(langSupport),
        previewCompartment.reconfigure(isShellConfig(act.filename) ? shellSecretsPlugin : []),
      ],
    });
    onReady();
  });
}

function findDemoNameEl(container: HTMLElement): HTMLElement | null {
  return container.closest('.demo')?.querySelector<HTMLElement>('.demo-name') ?? null;
}

function setTitle(el: HTMLElement | null, filename: string): void {
  if (el) el.textContent = `${filename} — couplet`;
}

interface Lane {
  el: HTMLDivElement;
  view: EditorView;
  scrollPos: number;
  actIndex: number;
  ready: boolean;
}

function stepLane(lane: Lane, dt: number): void {
  lane.scrollPos += SPEED_PX_PER_SEC * dt;
  const half = lane.view.scrollDOM.scrollHeight / 2;
  if (half > 0 && lane.scrollPos >= half) {
    lane.scrollPos -= half;
  }
  lane.view.scrollDOM.scrollTop = lane.scrollPos;
}

function passDurationS(lane: Lane): number {
  const half = lane.view.scrollDOM.scrollHeight / 2;
  return Math.max(MIN_DWELL_S, half / SPEED_PX_PER_SEC);
}

/**
 * Mounts a real app editor as a non-interactive exhibit that walks through
 * every feature the product has: the "just a good editor" ribbon now cycles
 * a markdown document, a `.env` file, and a `.zshrc` — the app's real live
 * preview, real secret masking, and real shell highlighting, each in the
 * mode the app itself would use for that file.
 */
export function mount(container: HTMLElement): void {
  if (prefersReducedMotion()) {
    // Static, scrolled to the top — no cycling, exactly like the previous
    // single-document ribbon under reduced motion. No `height` override: the
    // card's real height is the single value in site/index.html's
    // `data-demo-height`/`--demo-h` on `.demo`, which this element (a
    // descendant of it) inherits — see the identical comment below.
    const { view } = mountDemoEditor(container, { doc: prepareDoc(MARKDOWN_ACT.body) });
    requestRender(view, MERMAID_DIAGRAM);
    return;
  }

  const stage = document.createElement('div');
  stage.className = 'showcase-stage';
  container.appendChild(stage);

  const elA = document.createElement('div');
  elA.className = 'showcase-lane is-active';
  const elB = document.createElement('div');
  elB.className = 'showcase-lane';
  stage.appendChild(elA);
  stage.appendChild(elB);

  const titleEl = findDemoNameEl(container);
  setTitle(titleEl, MARKDOWN_ACT.filename);

  // No `height` override on either lane: both `elA`/`elB` are descendants of
  // `.demo`, so they inherit its `--demo-h` (set once, in site/index.html)
  // instead of duplicating the number here — the previous hardcoded 449 had
  // silently shadowed the HTML value ever since this carousel needed a
  // shorter row (see landing.css's .carousel-controls comment for why).
  // Passing no `height` at all keeps that single source of truth from
  // splitting again.
  const { view: viewA } = mountDemoEditor(elA, { doc: prepareDoc(MARKDOWN_ACT.body) });
  const { view: viewB } = mountDemoEditor(elB, { doc: prepareDoc(ENV_ACT.body) });

  const laneA: Lane = { el: elA, view: viewA, scrollPos: viewA.scrollDOM.scrollTop, actIndex: 0, ready: false };
  const laneB: Lane = { el: elB, view: viewB, scrollPos: viewB.scrollDOM.scrollTop, actIndex: 1, ready: false };

  applyAct(viewA, MARKDOWN_ACT, () => { laneA.ready = true; });
  applyAct(viewB, ENV_ACT, () => { laneB.ready = true; });
  requestRender(viewA, MERMAID_DIAGRAM);

  // Both lanes are permanently mounted and — once the pause gates below
  // allow it — permanently scrolling, whether visible or not. That is what
  // keeps the crossfade from ever looking like motion cutting to a static
  // frame: the incoming document is already moving under the fade.
  let activeIsA = true;
  let transitioning = false;
  let elapsedVisible = 0;
  let dwellTarget = 0;
  let queueIndex = 2 % ACTS.length; // laneA holds ACTS[0], laneB holds ACTS[1] — this is next up

  let pointerOver = false;
  let onScreen = true;

  container.addEventListener('pointerenter', () => {
    pointerOver = true;
  });
  container.addEventListener('pointerleave', () => {
    pointerOver = false;
  });

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) onScreen = entry.isIntersecting;
    },
    { threshold: 0 }
  );
  io.observe(container);

  function swapLaneToAct(lane: Lane, act: Act, actIndex: number): void {
    const doc = prepareDoc(act.body);
    lane.view.dispatch({
      changes: { from: 0, to: lane.view.state.doc.length, insert: doc },
      selection: { anchor: doc.length },
      annotations: Transaction.addToHistory.of(false),
    });
    lane.scrollPos = 0;
    lane.view.scrollDOM.scrollTop = 0;
    lane.actIndex = actIndex;
    lane.ready = false;
    applyAct(lane.view, act, () => {
      lane.ready = true;
    });
    if (act.mermaid) requestRender(lane.view, act.mermaid);
  }

  function startCrossfade(): void {
    transitioning = true;
    const incoming = activeIsA ? laneB : laneA;
    const outgoing = activeIsA ? laneA : laneB;
    incoming.el.classList.add('is-active');
    outgoing.el.classList.remove('is-active');
    setTitle(titleEl, ACTS[incoming.actIndex].filename);

    window.setTimeout(() => {
      activeIsA = !activeIsA;
      transitioning = false;
      elapsedVisible = 0;
      dwellTarget = 0;

      const nextAct = ACTS[queueIndex];
      queueIndex = (queueIndex + 1) % ACTS.length;
      swapLaneToAct(outgoing, nextAct, ACTS.indexOf(nextAct));
    }, CROSSFADE_MS);
  }

  let lastTs: number | null = null;

  function frame(ts: number): void {
    requestAnimationFrame(frame);

    const running = onScreen && !pointerOver && !document.hidden;
    if (!running) {
      lastTs = null; // don't count paused time once resumed
      return;
    }
    if (lastTs === null) {
      lastTs = ts;
      return;
    }

    const dt = (ts - lastTs) / 1000;
    lastTs = ts;

    stepLane(laneA, dt);
    stepLane(laneB, dt);

    if (transitioning) return;

    const active = activeIsA ? laneA : laneB;
    const idle = activeIsA ? laneB : laneA;

    // Grows (never shrinks) with the active lane's own measured height, so
    // a late-arriving mermaid SVG extending the scroll height only ever
    // lengthens the dwell — it can't cut the pass short.
    dwellTarget = Math.max(dwellTarget, passDurationS(active));
    elapsedVisible += dt;

    if (elapsedVisible >= dwellTarget && idle.ready) {
      startCrossfade();
    }
  }

  requestAnimationFrame(frame);
}
