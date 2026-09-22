import { prefersReducedMotion } from './editor-demo';

/**
 * "It can be used any way." (carousel slide 4) — a looping, three-act mock of
 * how couplet launches: a terminal batch, a Dock launch, and a Dock-drop.
 *
 * Everything here is decorative chrome, not a real editor: the actual
 * rendering engine is on display elsewhere in the carousel (point/edit/ask/
 * showcase all mount a real CM6 instance). Mounting three more editors here
 * would only cost payload for a slide that isn't about rendering at all — so
 * every "window" is a handful of plain divs with fake skeleton content.
 *
 * Layout: every positioned element lives on a fixed DESIGN_W x DESIGN_H
 * canvas (see demo-anyway.css's header comment). `fitStage` measures the
 * real, current width of the card and picks the SMALLER of two scale
 * factors: one that fits DESIGN_W into that width (the hard cap — never
 * overflow), and one that grows DESIGN_H up to TARGET_STAGE_H (fill the
 * carousel's own ~490px row instead of sitting centered in mostly empty
 * space). The canvas is deliberately taller than it is wide so that at
 * typical desktop widths (~440-480px available) the height-based factor is
 * the one that wins, while at phone widths (~300-320px available) the
 * width-based factor takes over and shrinks it to fit. Either way it's a
 * single `transform: scale()` — so the sequence never overflows
 * horizontally and never changes the card's own box size mid-cycle (only a
 * real resize event touches sizing, never the animation loop itself).
 */

const FILES = ['README.md', 'CLAUDE.md', 'auth_spec.md'] as const;
const COMMAND = `mdmini ${FILES.join(' ')}`;

const DESIGN_W = 380;
const DESIGN_H = 400;
// The stage's desired height at desktop widths, chosen to sit well within
// the ~490px the other four (equalized) carousel slides occupy, leaving
// room for this card's own label + frame padding above and below it.
const TARGET_STAGE_H = 430;
const MIN_SCALE = 0.55;
const MAX_SCALE = 1.3;

// ms
const TERMINAL_APPEAR_MS = 320;
const CHAR_MS = 42;
const POST_TYPE_PAUSE_MS = 350;
const WINDOW_OPEN_SETTLE_MS = 700; // last cascade window's transition-delay + duration
const HOLD_AFTER_OPEN_MS = 1300;
const FADE_OUT_MS = 450;

const DOCK_APPEAR_MS = 320;
const PRECLICK_HOLD_MS = 450;
const CURSOR_TRAVEL_MS = 420;
const CLICK_PRESS_MS = 160;
const SOLO_OPEN_SETTLE_MS = 450;
const HOLD_APP_MS = 1100;

// Act 3 (dock-drop): a marquee-select gesture, then a carried stack.
const PREDRAG_HOLD_MS = 260; // desktop settles before the cursor moves in
const CURSOR_APPEAR_HOLD_MS = 280;
const CURSOR_ARM_MS = 460; // cursor travels onto the press point (>= its 0.42s transform transition)
const MARQUEE_DRAG_MS = 500; // rectangle grows + cursor rides its corner (>= 0.48s/0.42s CSS transitions)
const SELECTION_HOLD_MS = 320; // beat on the fully-selected files before lifting
const LIFT_MS = 320; // stack pops in, originals dim (>= their ~0.3s transitions)
const CARRY_MS = 480; // cursor + stack travel to the Dock icon together (>= 0.44s transform)
const DROP_PRESS_MS = 180;
const DROP_SETTLE_MS = 420; // Dock press + stack-dropped fade settle
const HOLD_DROP_MS = 1300;

const GAP_MS = 550;

const TEMPLATE = `
  <div class="anyway-label" data-el="label"></div>
  <div class="anyway-frame">
    <div class="anyway-stage-wrap" data-el="wrap">
      <div class="anyway-stage" data-el="stage">
        <div class="anyway-terminal" data-el="terminal">
          <div class="anyway-winbar">
            <span class="anyway-dot anyway-dot--red"></span>
            <span class="anyway-dot anyway-dot--yellow"></span>
            <span class="anyway-dot anyway-dot--green"></span>
            <span class="anyway-wintitle">zsh</span>
          </div>
          <div class="anyway-termbody">
            <span class="anyway-prompt">$</span>
            <span data-el="typed"></span><span class="anyway-caret" data-el="caret"></span>
          </div>
        </div>

        ${FILES.map(
          (file, i) => `
        <div class="anyway-win anyway-win--${i}" data-el="win${i}">
          <div class="anyway-winbar">
            <span class="anyway-dot anyway-dot--red"></span>
            <span class="anyway-dot anyway-dot--yellow"></span>
            <span class="anyway-dot anyway-dot--green"></span>
            <span class="anyway-wintitle">${file} — couplet</span>
          </div>
          <div class="anyway-winbody">
            <span class="anyway-skel anyway-skel--head"></span>
            <span class="anyway-skel"></span>
            <span class="anyway-skel anyway-skel--sm"></span>
            <span class="anyway-skel anyway-skel--md"></span>
          </div>
        </div>`
        ).join('')}

        <div class="anyway-win anyway-win--solo" data-el="winSolo">
          <div class="anyway-winbar">
            <span class="anyway-dot anyway-dot--red"></span>
            <span class="anyway-dot anyway-dot--yellow"></span>
            <span class="anyway-dot anyway-dot--green"></span>
            <span class="anyway-wintitle">Untitled — couplet</span>
          </div>
          <div class="anyway-winbody">
            <span class="anyway-skel anyway-skel--head"></span>
            <span class="anyway-skel"></span>
            <span class="anyway-skel anyway-skel--sm"></span>
          </div>
        </div>

        <div class="anyway-dock" data-el="dock">
          <div class="anyway-dockicon" data-el="dockicon">
            <span class="anyway-dockicon-text">md</span>
          </div>
        </div>

        ${FILES.map(
          (file, i) => `
        <div class="anyway-file anyway-file--${i}" data-el="file${i}">
          <div class="anyway-file-icon">
            <span class="anyway-file-icon-line anyway-file-icon-line--1"></span>
            <span class="anyway-file-icon-line anyway-file-icon-line--2"></span>
            <span class="anyway-file-icon-line anyway-file-icon-line--3"></span>
          </div>
          <div class="anyway-file-name">${file}</div>
        </div>`
        ).join('')}

        <div class="anyway-marquee" data-el="marquee"></div>

        <div class="anyway-stack" data-el="stack">
          <span class="anyway-stack-card anyway-stack-card--0"></span>
          <span class="anyway-stack-card anyway-stack-card--1"></span>
          <span class="anyway-stack-card anyway-stack-card--2"></span>
          <span class="anyway-stack-badge">${FILES.length}</span>
        </div>

        <div class="anyway-cursor" data-el="cursor"></div>
      </div>
    </div>
  </div>
`;

interface Dom {
  label: HTMLElement;
  wrap: HTMLElement;
  stage: HTMLElement;
  terminal: HTMLElement;
  typed: HTMLElement;
  caret: HTMLElement;
  windows: HTMLElement[];
  winSolo: HTMLElement;
  dock: HTMLElement;
  dockicon: HTMLElement;
  files: HTMLElement[];
  marquee: HTMLElement;
  stack: HTMLElement;
  cursor: HTMLElement;
}

function queryDom(root: HTMLElement): Dom | null {
  const get = (sel: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-el="${sel}"]`);

  const label = get('label');
  const wrap = get('wrap');
  const stage = get('stage');
  const terminal = get('terminal');
  const typed = get('typed');
  const caret = get('caret');
  const winSolo = get('winSolo');
  const dock = get('dock');
  const dockicon = get('dockicon');
  const marquee = get('marquee');
  const stack = get('stack');
  const cursor = get('cursor');
  const windows = FILES.map((_, i) => get(`win${i}`));
  const files = FILES.map((_, i) => get(`file${i}`));

  if (
    !label || !wrap || !stage || !terminal || !typed || !caret || !winSolo ||
    !dock || !dockicon || !marquee || !stack || !cursor ||
    windows.some((w) => !w) || files.some((f) => !f)
  ) {
    return null;
  }

  return {
    label, wrap, stage, terminal, typed, caret,
    windows: windows as HTMLElement[],
    winSolo, dock, dockicon,
    files: files as HTMLElement[],
    marquee, stack,
    cursor,
  };
}

/** Toggle classes this demo ever adds; used to fully reset the stage between cycles. */
const TOGGLE_CLASSES = [
  'is-visible', 'is-open', 'is-dropped', 'is-pressed', 'is-clicking', 'is-at-dock', 'is-blinking',
  // Act 3 (dock-drop): marquee-select → carried stack.
  'is-marquee', 'is-armed', 'is-dragging', 'is-releasing', 'is-selected', 'is-lifted', 'is-gone', 'is-carried',
];

function resetAll(root: HTMLElement): void {
  for (const cls of TOGGLE_CLASSES) {
    root.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
  }
}

/**
 * Scales the fixed DESIGN_W x DESIGN_H canvas to `dom.wrap`'s real, current
 * width, "contain"-style: never wider than the available column (the hard
 * cap that keeps this from ever overflowing), but grown up to TARGET_STAGE_H
 * tall whenever the column is wide enough to allow it, so the stage fills
 * its share of the carousel row instead of floating in empty space.
 */
function fitStage(dom: Dom): void {
  const w = dom.wrap.clientWidth;
  if (w <= 0) return;
  const widthScale = w / DESIGN_W;
  const heightScale = TARGET_STAGE_H / DESIGN_H;
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, widthScale, heightScale));
  dom.stage.style.transform = `scale(${scale})`;
  dom.wrap.style.height = `${Math.round(DESIGN_H * scale)}px`;
}

/**
 * Drives a shared timeline: `wait(ms)` only counts down while `running` is
 * true (on-screen, tab visible, not cancelled), so a single rAF loop is all
 * that's ever active — nothing burns frames in a background tab or while
 * this slide sits off-screen in the carousel.
 */
class GateClock {
  private _cancelled = false;
  private onScreen = true;
  private hidden = document.hidden;

  get cancelled(): boolean {
    return this._cancelled;
  }

  private get running(): boolean {
    return !this._cancelled && this.onScreen && !this.hidden;
  }

  cancel(): void {
    this._cancelled = true;
  }

  setOnScreen(v: boolean): void {
    this.onScreen = v;
  }

  setHidden(v: boolean): void {
    this.hidden = v;
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this._cancelled) {
        resolve();
        return;
      }
      let remaining = ms;
      let last: number | null = null;
      const frame = (now: number): void => {
        if (this._cancelled) {
          resolve();
          return;
        }
        if (this.running) {
          if (last !== null) remaining -= now - last;
          last = now;
        } else {
          last = null;
        }
        if (remaining <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }
}

async function typeText(clock: GateClock, el: HTMLElement, text: string, perCharMs: number): Promise<void> {
  for (let i = 1; i <= text.length; i++) {
    el.textContent = text.slice(0, i);
    await clock.wait(perCharMs);
    if (clock.cancelled) return;
  }
}

function setLabel(dom: Dom, text: string): void {
  dom.label.textContent = text;
}

function openWindows(windows: HTMLElement[]): void {
  for (const w of windows) w.classList.add('is-open');
}

async function clearStage(clock: GateClock, dom: Dom): Promise<void> {
  resetAll(dom.stage);
  await clock.wait(FADE_OUT_MS);
}

/** Act 1: a terminal types the batch command, then three windows cascade open. */
async function actTerminal(clock: GateClock, dom: Dom): Promise<void> {
  setLabel(dom, 'from the terminal');
  dom.terminal.classList.add('is-visible');
  await clock.wait(TERMINAL_APPEAR_MS);
  if (clock.cancelled) return;

  dom.caret.classList.add('is-blinking');
  await typeText(clock, dom.typed, COMMAND, CHAR_MS);
  if (clock.cancelled) return;

  await clock.wait(POST_TYPE_PAUSE_MS);
  if (clock.cancelled) return;

  openWindows(dom.windows);
  await clock.wait(WINDOW_OPEN_SETTLE_MS + HOLD_AFTER_OPEN_MS);
  if (clock.cancelled) return;

  await clearStage(clock, dom);
}

/** Act 2: the Dock appears, a click lands on its icon, and one window opens. */
async function actApp(clock: GateClock, dom: Dom): Promise<void> {
  setLabel(dom, 'as an app');
  dom.dock.classList.add('is-visible');
  await clock.wait(DOCK_APPEAR_MS);
  if (clock.cancelled) return;

  dom.cursor.classList.add('is-visible');
  await clock.wait(PRECLICK_HOLD_MS);
  if (clock.cancelled) return;

  dom.cursor.classList.add('is-at-dock');
  await clock.wait(CURSOR_TRAVEL_MS);
  if (clock.cancelled) return;

  dom.cursor.classList.add('is-clicking');
  dom.dockicon.classList.add('is-pressed');
  await clock.wait(CLICK_PRESS_MS);
  if (clock.cancelled) return;

  dom.dockicon.classList.remove('is-pressed');
  dom.winSolo.classList.add('is-open');
  await clock.wait(SOLO_OPEN_SETTLE_MS + HOLD_APP_MS);
  if (clock.cancelled) return;

  await clearStage(clock, dom);
}

/**
 * Act 3: a Finder-style marquee select over three document icons, then the
 * selection is picked up as a small stack (with a count badge) and carried
 * to the Dock icon.
 */
async function actDockDrop(clock: GateClock, dom: Dom): Promise<void> {
  setLabel(dom, 'dock drop');
  dom.dock.classList.add('is-visible');
  for (const file of dom.files) file.classList.add('is-visible');
  await clock.wait(DOCK_APPEAR_MS + PREDRAG_HOLD_MS);
  if (clock.cancelled) return;

  // Cursor moves in and rests just above the files, before pressing. Its
  // `is-marquee` modifier re-anchors it to this act's own coordinate space
  // (see demo-anyway.css's cursor comment) — Act 2 never sets this class,
  // so its own `is-at-dock` positioning is untouched.
  dom.cursor.classList.add('is-marquee', 'is-visible');
  await clock.wait(CURSOR_APPEAR_HOLD_MS);
  if (clock.cancelled) return;

  // Travels onto the press point (the marquee's future top-left corner).
  dom.cursor.classList.add('is-armed');
  await clock.wait(CURSOR_ARM_MS);
  if (clock.cancelled) return;

  // Presses down — the click pulse doubles as "mouse down".
  dom.cursor.classList.add('is-clicking');
  await clock.wait(CLICK_PRESS_MS);
  if (clock.cancelled) return;

  // Drags out the marquee; the cursor rides its growing bottom-right corner
  // and each file's selected look lands staggered by --select-delay, as if
  // the rectangle were sweeping over them left to right.
  dom.marquee.classList.add('is-dragging');
  dom.cursor.classList.add('is-dragging');
  for (const file of dom.files) file.classList.add('is-selected');
  await clock.wait(MARQUEE_DRAG_MS);
  if (clock.cancelled) return;

  await clock.wait(SELECTION_HOLD_MS);
  if (clock.cancelled) return;

  // Releases the marquee and picks the selection up: the stack pops in at
  // the same point the cursor's drag ended, and the original icons dim to a
  // ghost — the drag thumbnail is what actually travels.
  dom.marquee.classList.add('is-releasing');
  dom.stack.classList.add('is-visible');
  for (const file of dom.files) file.classList.add('is-lifted');
  await clock.wait(LIFT_MS);
  if (clock.cancelled) return;

  // Cursor and stack share the same travel distance, so they arrive at the
  // Dock icon together.
  dom.cursor.classList.add('is-carried');
  dom.stack.classList.add('is-carried');
  await clock.wait(CARRY_MS);
  if (clock.cancelled) return;

  dom.dockicon.classList.add('is-pressed');
  dom.stack.classList.add('is-dropped');
  for (const file of dom.files) file.classList.add('is-gone');
  await clock.wait(DROP_PRESS_MS);
  if (clock.cancelled) return;

  dom.dockicon.classList.remove('is-pressed');
  await clock.wait(DROP_SETTLE_MS);
  if (clock.cancelled) return;

  openWindows(dom.windows);
  await clock.wait(WINDOW_OPEN_SETTLE_MS + HOLD_DROP_MS);
  if (clock.cancelled) return;

  await clearStage(clock, dom);
}

async function runLoop(clock: GateClock, dom: Dom): Promise<void> {
  while (!clock.cancelled) {
    await actTerminal(clock, dom);
    if (clock.cancelled) return;
    await actApp(clock, dom);
    if (clock.cancelled) return;
    await actDockDrop(clock, dom);
    if (clock.cancelled) return;

    setLabel(dom, '');
    await clock.wait(GAP_MS);
  }
}

/** Renders the accessible, motion-free end state: everything visible, nothing moving. */
function renderStatic(dom: Dom): void {
  dom.terminal.closest('.anyway-root')?.classList.add('is-static');
  setLabel(dom, '');
  dom.terminal.classList.add('is-visible');
  dom.typed.textContent = COMMAND;
  openWindows(dom.windows);
  dom.dock.classList.add('is-visible');
  for (const file of dom.files) file.classList.add('is-visible');
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
  container.innerHTML = `<div class="anyway-root" aria-hidden="true">${TEMPLATE}</div>`;
  const root = container.querySelector<HTMLElement>('.anyway-root');
  const dom = root && queryDom(root);
  if (!root || !dom) return;

  fitStage(dom);
  const ro = new ResizeObserver(() => fitStage(dom));
  ro.observe(dom.wrap);

  if (prefersReducedMotion()) {
    renderStatic(dom);
    watchRemoval(container, () => ro.disconnect());
    return;
  }

  const clock = new GateClock();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) clock.setOnScreen(entry.isIntersecting);
    },
    { threshold: 0 }
  );
  io.observe(container);

  const onVisibilityChange = (): void => clock.setHidden(document.hidden);
  document.addEventListener('visibilitychange', onVisibilityChange);

  void runLoop(clock, dom);

  watchRemoval(container, () => {
    clock.cancel();
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });
}
