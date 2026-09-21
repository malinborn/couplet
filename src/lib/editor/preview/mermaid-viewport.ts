import { t } from '../../i18n';

/**
 * Pan/zoom geometry for rendered mermaid diagrams.
 *
 * Everything above the "DOM controller" divider is pure: plain records in,
 * plain records out, no DOM and no CodeMirror. That is what the unit tests
 * exercise.
 *
 * Coordinate model: the canvas is the diagram at its natural size, positioned
 * with `translate(tx, ty) scale(scale)` and `transform-origin: 0 0`. A content
 * point (cx, cy) therefore lands at (tx + cx * scale, ty + cy * scale) in frame
 * coordinates.
 */

// -- Types --

export interface Size {
  width: number;
  height: number;
}

export interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

export interface Point {
  x: number;
  y: number;
}

export type WheelIntent = 'zoom' | 'pan' | 'passthrough';

interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
}

// -- Constants --

export const MAX_SCALE = 8;
export const MIN_FRAME_HEIGHT = 60;

/** Zoom floor under normal circumstances; a diagram whose fit is smaller wins. */
const SCALE_FLOOR = 0.1;

/** Scale comparisons are float-tolerant. */
const SCALE_EPSILON = 1e-4;

/** A pan honored by less than this many pixels counts as no movement at all. */
const PAN_EPSILON = 0.01;

// -- Pure geometry --

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function usable(content: Size, frame: Size): boolean {
  return content.width > 0 && content.height > 0 && frame.width > 0 && frame.height > 0;
}

/** Largest scale at which the whole diagram is visible. Never upscales. */
export function fitScale(content: Size, frame: Size): number {
  if (!usable(content, frame)) return 1;
  return Math.min(1, frame.width / content.width, frame.height / content.height);
}

export function minScale(content: Size, frame: Size): number {
  return Math.min(SCALE_FLOOR, fitScale(content, frame));
}

/** The "full view": fit scale, centered in the frame. */
export function computeFit(content: Size, frame: Size): ViewState {
  const scale = fitScale(content, frame);
  return {
    scale,
    tx: (frame.width - content.width * scale) / 2,
    ty: (frame.height - content.height * scale) / 2,
  };
}

/**
 * Frame height that shows the diagram at its width-constrained size, capped so
 * a tall diagram never swallows the document.
 */
export function autoHeight(content: Size, frameWidth: number, maxHeight: number): number {
  if (content.width <= 0 || content.height <= 0 || frameWidth <= 0) {
    return MIN_FRAME_HEIGHT;
  }
  const widthScale = Math.min(1, frameWidth / content.width);
  return clamp(content.height * widthScale, MIN_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, maxHeight));
}

/**
 * Keep the diagram honest: center it on any axis where it is smaller than the
 * frame, otherwise forbid its edges from moving inside the frame.
 */
export function clampPan(view: ViewState, content: Size, frame: Size): ViewState {
  const scaledW = content.width * view.scale;
  const scaledH = content.height * view.scale;

  const tx =
    scaledW <= frame.width
      ? (frame.width - scaledW) / 2
      : clamp(view.tx, frame.width - scaledW, 0);

  const ty =
    scaledH <= frame.height
      ? (frame.height - scaledH) / 2
      : clamp(view.ty, frame.height - scaledH, 0);

  return { scale: view.scale, tx, ty };
}

/**
 * Pan by a wheel/drag delta. Deltas follow the scroll convention: a positive
 * delta moves the content in the negative direction, as if scrolling down.
 */
export function panBy(
  view: ViewState,
  deltaX: number,
  deltaY: number,
  content: Size,
  frame: Size
): ViewState {
  return clampPan(
    { scale: view.scale, tx: view.tx - deltaX, ty: view.ty - deltaY },
    content,
    frame
  );
}

/** Zoom by `factor`, keeping the content point under `point` fixed. */
export function zoomAt(
  view: ViewState,
  factor: number,
  point: Point,
  content: Size,
  frame: Size
): ViewState {
  const scale = clamp(view.scale * factor, minScale(content, frame), MAX_SCALE);

  // Content coordinate currently under the pointer.
  const cx = (point.x - view.tx) / view.scale;
  const cy = (point.y - view.ty) / view.scale;

  return clampPan(
    { scale, tx: point.x - cx * scale, ty: point.y - cy * scale },
    content,
    frame
  );
}

/**
 * True when the diagram is showing at (or beyond) its full view — meaning there
 * is nothing to pan, so wheel events belong to the document.
 */
export function isAtFit(view: ViewState, content: Size, frame: Size): boolean {
  return view.scale <= fitScale(content, frame) + SCALE_EPSILON;
}

/**
 * Decide who owns a wheel **gesture**. Evaluated once, when a gesture starts —
 * see `GESTURE_GAP_MS`. `passthrough` is the important verdict: it is what keeps
 * a diagram from becoming a scroll trap in a long document.
 *
 * `userZoomed` is passed in rather than derived, because a frame that just got
 * smaller can leave `scale` above the new fit without the user having zoomed.
 */
export function wheelIntent(
  event: WheelLike,
  view: ViewState,
  content: Size,
  frame: Size,
  userZoomed = !isAtFit(view, content, frame)
): WheelIntent {
  if (event.ctrlKey || event.metaKey) return 'zoom';
  if (!userZoomed) return 'passthrough';

  const next = panBy(view, event.deltaX, event.deltaY, content, frame);
  const moved =
    Math.abs(next.tx - view.tx) > PAN_EPSILON || Math.abs(next.ty - view.ty) > PAN_EPSILON;

  return moved ? 'pan' : 'passthrough';
}

/** How far past its bounds a diagram may be dragged before it stops giving. */
export const OVERSCROLL_LIMIT = 72;

/**
 * Damped overscroll: unbounded input, output asymptotically approaching
 * `limit`. Gives the edge a rubber-band feel instead of a hard stop.
 */
export function rubberBand(overscroll: number, limit = OVERSCROLL_LIMIT): number {
  if (limit <= 0) return 0;
  const magnitude = Math.abs(overscroll);
  return Math.sign(overscroll) * limit * (1 - 1 / (magnitude / limit + 1));
}

/**
 * The part of a pan the clamp refused, carrying the direction the content
 * wanted to travel. Feeds the rubber band.
 */
export function panLeftover(
  view: ViewState,
  deltaX: number,
  deltaY: number,
  content: Size,
  frame: Size
): Point {
  const requestedX = view.tx - deltaX;
  const requestedY = view.ty - deltaY;
  const clamped = clampPan({ scale: view.scale, tx: requestedX, ty: requestedY }, content, frame);
  return { x: requestedX - clamped.tx, y: requestedY - clamped.ty };
}

/** Wheel delta → zoom factor, damped so a mouse wheel doesn't jump octaves. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -50, 50) * 0.01);
}

// ---------------------------------------------------------------------------
// DOM controller
// ---------------------------------------------------------------------------

/** Fraction of the window height an auto-sized frame may occupy. */
const AUTO_HEIGHT_FRACTION = 0.6;
/** Fraction of the window height a manually resized frame may occupy. */
const MANUAL_HEIGHT_FRACTION = 0.95;

const BUTTON_ZOOM_STEP = 1.4;
const DOUBLE_CLICK_ZOOM = 2;
const COMMIT_DEBOUNCE_MS = 150;

/**
 * A gap longer than this between wheel events starts a new gesture.
 *
 * Ownership of a gesture is decided once, at its start, and held until it ends
 * — so running into an edge mid-swipe makes the diagram spring back rather than
 * silently handing the scroll to the document. Trackpads emit a dense stream
 * during a swipe (including inertia), so the gap only elapses once fingers
 * have actually stopped.
 */
const GESTURE_GAP_MS = 120;
const SNAP_BACK_MS = 220;

export interface ViewportInit {
  scale: number;
  tx: number;
  ty: number;
  frameHeight: number | null;
}

export interface ViewportController {
  dom: HTMLElement;
  destroy(): void;
}

/**
 * Natural diagram size read straight out of SVG markup, without parsing it into
 * a document. Used for height estimates before the widget is ever laid out.
 */
export function parseSvgSize(markup: string): Size | null {
  const viewBox = /viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/i.exec(
    markup
  );
  if (viewBox) {
    const width = parseFloat(viewBox[3]);
    const height = parseFloat(viewBox[4]);
    if (width > 0 && height > 0) return { width, height };
  }

  const attr = (name: string): number => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, 'i').exec(markup);
    return m ? parseFloat(m[1]) : 0;
  };
  const width = attr('width');
  const height = attr('height');
  if (width > 0 && height > 0) return { width, height };

  return null;
}

/**
 * Height to give a diagram's frame before it has ever been laid out.
 *
 * Needed because the frame gets its height from an inline style, and the SVG
 * inside it is inserted at natural size — often 2000px+ tall. Any window in
 * which that height is unset is a window in which the diagram dictates the line
 * height. `remeasure` refines this once the real frame width is known.
 */
export function estimateFrameHeight(
  markup: string | null,
  storedHeight: number | null,
  frameWidth: number,
  maxHeight: number
): number {
  if (storedHeight !== null && storedHeight > 0) {
    return Math.max(MIN_FRAME_HEIGHT, storedHeight);
  }
  if (!markup) return MIN_FRAME_HEIGHT;

  const content = parseSvgSize(markup);
  if (!content) return MIN_FRAME_HEIGHT;

  // Mirrors what `remeasure` will compute once the frame has a real width.
  return autoHeight(content, frameWidth, maxHeight);
}

/** The cap `remeasure` applies to an auto-sized frame. Depends on the window. */
export function autoHeightCap(): number {
  return maxAutoHeight();
}

function maxAutoHeight(): number {
  return Math.max(MIN_FRAME_HEIGHT, window.innerHeight * AUTO_HEIGHT_FRACTION);
}

function maxManualHeight(): number {
  return Math.max(MIN_FRAME_HEIGHT, window.innerHeight * MANUAL_HEIGHT_FRACTION);
}

/**
 * Natural diagram size. The viewBox is authoritative — `clientWidth` has
 * already been distorted by mermaid's own `max-width` style.
 */
function readContentSize(svg: SVGSVGElement): Size {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    return { width: box.width, height: box.height };
  }

  const rawW = svg.getAttribute('width') ?? '';
  const rawH = svg.getAttribute('height') ?? '';
  if (!rawW.includes('%') && !rawH.includes('%')) {
    const w = parseFloat(rawW);
    const h = parseFloat(rawH);
    if (w > 0 && h > 0) return { width: w, height: h };
  }

  try {
    const bbox = svg.getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      return { width: bbox.width, height: bbox.height };
    }
  } catch {
    // getBBox throws when the element is not yet rendered
  }

  return { width: 0, height: 0 };
}

function makeButton(label: string, title: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = className;
  btn.textContent = label;
  btn.title = title;
  btn.tabIndex = -1;
  return btn;
}

/**
 * Builds the pan/zoom frame around a rendered mermaid SVG.
 *
 * Interaction writes `transform` straight to the DOM; `onCommit` is called on a
 * trailing debounce so the CodeMirror state field only sees settled values.
 */
export function createViewport(
  svgMarkup: string,
  initial: ViewportInit | null,
  onCommit: (state: ViewportInit) => void,
  /**
   * Height to give the frame immediately, before layout. Pass the same value
   * handed to `WidgetType.estimatedHeight` so CodeMirror's height map and the
   * real DOM agree from the first frame.
   */
  initialHeight: number = MIN_FRAME_HEIGHT
): ViewportController {
  const dom = document.createElement('div');
  dom.className = 'cm-md-mermaid-frame';

  const viewport = document.createElement('div');
  viewport.className = 'cm-md-mermaid-viewport';

  // Bound the frame BEFORE the SVG can influence layout. The SVG is inserted at
  // its natural size (2000px+ tall is normal), and `.cm-md-mermaid-viewport` gets
  // its height only from this inline style — so until it is set, the line is as
  // tall as the diagram. WebKit lays that intermediate state out and lets
  // CodeMirror measure it, which sends the height map and the scroll position
  // wild; the document ends up several thousand pixels too tall and then
  // collapses. Chrome happens to coalesce it into one frame, which is why this
  // only showed up in the app.
  viewport.style.height = `${Math.round(initialHeight)}px`;

  const canvas = document.createElement('div');
  canvas.className = 'cm-md-mermaid-canvas';
  canvas.innerHTML = svgMarkup;

  viewport.appendChild(canvas);
  dom.appendChild(viewport);

  // -- Controls --

  const controls = document.createElement('div');
  controls.className = 'cm-md-mermaid-controls';
  const zoomOutBtn = makeButton('−', t('editor.mermaid.zoom_out'), 'cm-md-mermaid-btn');
  const readout = document.createElement('span');
  readout.className = 'cm-md-mermaid-zoom-readout';
  const zoomInBtn = makeButton('+', t('editor.mermaid.zoom_in'), 'cm-md-mermaid-btn');
  const fitBtn = makeButton('⤢', t('editor.mermaid.fit'), 'cm-md-mermaid-btn');
  controls.append(zoomOutBtn, readout, zoomInBtn, fitBtn);
  dom.appendChild(controls);

  const handle = document.createElement('div');
  handle.className = 'cm-md-mermaid-resize';
  handle.title = t('editor.mermaid.resize_hint');
  dom.appendChild(handle);

  // -- Mutable state --

  const svg = canvas.querySelector('svg');
  let content: Size = { width: 0, height: 0 };
  let frame: Size = { width: 0, height: 0 };
  let view: ViewState = { scale: 1, tx: 0, ty: 0 };
  let frameHeight: number | null = initial?.frameHeight ?? null;
  let restored: ViewState | null = initial ? { scale: initial.scale, tx: initial.tx, ty: initial.ty } : null;
  let measured = false;
  let destroyed = false;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseDrag: (() => void) | null = null;

  /**
   * Whether the user has zoomed away from the full view. Tracked explicitly
   * rather than derived from `scale > fitScale`: shrinking the frame raises the
   * fit scale, which would otherwise make an untouched diagram look zoomed and
   * strand it there forever.
   */
  let userZoomed = false;

  // Gesture state — see GESTURE_GAP_MS
  let lastWheelAt = 0;
  let wheelOwner: 'diagram' | 'document' | null = null;
  let gestureEndTimer: ReturnType<typeof setTimeout> | null = null;
  /** Raw (undamped) overscroll accumulated past the clamp. */
  let overscroll: Point = { x: 0, y: 0 };
  let snapBackFrame: number | null = null;

  if (svg instanceof SVGSVGElement) {
    content = readContentSize(svg);
    // Natural size, so the zoom math and the rendered pixels agree.
    svg.style.maxWidth = 'none';
    svg.style.display = 'block';
    if (content.width > 0) {
      svg.setAttribute('width', String(content.width));
      svg.setAttribute('height', String(content.height));
    }
  }

  function apply(): void {
    const ox = rubberBand(overscroll.x);
    const oy = rubberBand(overscroll.y);
    canvas.style.transform = `translate(${view.tx + ox}px, ${view.ty + oy}px) scale(${view.scale})`;
    readout.textContent = `${Math.round(view.scale * 100)}%`;
    dom.classList.toggle('is-zoomed', userZoomed);
  }

  function cancelSnapBack(): void {
    if (snapBackFrame !== null) {
      cancelAnimationFrame(snapBackFrame);
      snapBackFrame = null;
    }
  }

  /** Release the rubber band once the gesture is over. */
  function startSnapBack(): void {
    cancelSnapBack();
    if (overscroll.x === 0 && overscroll.y === 0) return;

    const from = { ...overscroll };
    const start = performance.now();

    const step = () => {
      if (destroyed) return;
      const t = Math.min(1, (performance.now() - start) / SNAP_BACK_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      overscroll = { x: from.x * (1 - eased), y: from.y * (1 - eased) };
      apply();
      if (t < 1) {
        snapBackFrame = requestAnimationFrame(step);
      } else {
        snapBackFrame = null;
        overscroll = { x: 0, y: 0 };
        apply();
      }
    };

    snapBackFrame = requestAnimationFrame(step);
  }

  function endGesture(): void {
    wheelOwner = null;
    startSnapBack();
    commit();
  }

  function scheduleGestureEnd(): void {
    if (gestureEndTimer) clearTimeout(gestureEndTimer);
    gestureEndTimer = setTimeout(() => {
      gestureEndTimer = null;
      endGesture();
    }, GESTURE_GAP_MS);
  }

  /** Pan, sending whatever the clamp refuses into the rubber band. */
  function panWithRubberBand(deltaX: number, deltaY: number): void {
    const refused = panLeftover(view, deltaX, deltaY, content, frame);
    view = panBy(view, deltaX, deltaY, content, frame);
    overscroll = { x: overscroll.x + refused.x, y: overscroll.y + refused.y };
    apply();
  }

  function commit(): void {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (destroyed) return;
      onCommit({ scale: view.scale, tx: view.tx, ty: view.ty, frameHeight });
    }, COMMIT_DEBOUNCE_MS);
  }

  function setFrameHeight(px: number | null): void {
    frameHeight = px;
    const height =
      px !== null
        ? clamp(px, MIN_FRAME_HEIGHT, maxManualHeight())
        : autoHeight(content, frame.width, maxAutoHeight());
    viewport.style.height = `${Math.round(height)}px`;
    frame = { width: frame.width, height };
  }

  function fit(): void {
    cancelSnapBack();
    overscroll = { x: 0, y: 0 };
    view = computeFit(content, frame);
    userZoomed = false;
    apply();
    commit();
  }

  function zoom(factor: number, point: Point): void {
    cancelSnapBack();
    overscroll = { x: 0, y: 0 };
    view = zoomAt(view, factor, point, content, frame);
    userZoomed = !isAtFit(view, content, frame);
    apply();
    commit();
  }

  function frameCenter(): Point {
    return { x: frame.width / 2, y: frame.height / 2 };
  }

  function pointerIn(event: MouseEvent): Point {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Height the frame should have for a given width, before it is applied. */
  function targetHeight(width: number): number {
    return frameHeight !== null
      ? clamp(frameHeight, MIN_FRAME_HEIGHT, maxManualHeight())
      : autoHeight(content, width, maxAutoHeight());
  }

  /**
   * Re-measure after insertion, a width change, or a window resize. The frame
   * width only becomes known once the element is in the document, so the first
   * pass is what establishes the initial view.
   */
  function remeasure(width: number): void {
    if (width <= 0) return;

    // Both dimensions matter: the auto height depends on the window height, which
    // no observer on this element reports.
    if (
      measured &&
      Math.abs(width - frame.width) < 0.5 &&
      Math.abs(targetHeight(width) - frame.height) < 0.5
    ) {
      return;
    }

    frame = { width, height: frame.height };
    setFrameHeight(frameHeight);

    if (!measured) {
      measured = true;
      view = restored ? clampPan(restored, content, frame) : computeFit(content, frame);
      // Restored state is the only way to start out zoomed.
      userZoomed = restored ? !isAtFit(view, content, frame) : false;
      restored = null;
    } else if (userZoomed) {
      view = clampPan(view, content, frame);
    } else {
      // Untouched by the user — keep tracking the full view as the frame changes.
      view = computeFit(content, frame);
    }
    apply();
  }

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      remeasure(entry.contentRect.width);
    }
  });
  observer.observe(dom);

  // Auto height is a fraction of the window height, so a vertical-only window
  // resize has to be caught here — it never changes this element's width.
  const onWindowResize = () => remeasure(frame.width || dom.clientWidth);
  window.addEventListener('resize', onWindowResize);

  // -- Wheel: zoom, pan, or hand back to the document --

  function onWheel(event: WheelEvent): void {
    if (!measured) return;

    const now = performance.now();
    const startsGesture = now - lastWheelAt > GESTURE_GAP_MS;
    lastWheelAt = now;

    // Zoom is never latched — a pinch may interrupt anything.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      wheelOwner = 'diagram';
      zoom(wheelZoomFactor(event.deltaY), pointerIn(event));
      scheduleGestureEnd();
      return;
    }

    if (startsGesture) {
      cancelSnapBack();
      overscroll = { x: 0, y: 0 };
      // Decided once per gesture. At an edge, a *new* gesture belongs to the
      // document — which is how the user scrolls past a diagram.
      wheelOwner =
        wheelIntent(event, view, content, frame, userZoomed) === 'pan' ? 'diagram' : 'document';
    }

    if (wheelOwner !== 'diagram') return; // no preventDefault → the document scrolls

    // Held for the rest of the gesture: hitting an edge springs back instead of
    // quietly handing the scroll over mid-swipe.
    event.preventDefault();
    event.stopPropagation();
    panWithRubberBand(event.deltaX, event.deltaY);
    scheduleGestureEnd();
  }
  viewport.addEventListener('wheel', onWheel, { passive: false });

  // -- Drag to pan --

  function onMouseDown(event: MouseEvent): void {
    if (event.button !== 0 || !measured) return;
    event.preventDefault();
    event.stopPropagation();

    let lastX = event.clientX;
    let lastY = event.clientY;
    dom.classList.add('is-grabbing');
    cancelSnapBack();

    const onMove = (move: MouseEvent) => {
      // panBy follows the scroll convention, so a rightward drag is a negative delta
      panWithRubberBand(lastX - move.clientX, lastY - move.clientY);
      lastX = move.clientX;
      lastY = move.clientY;
    };

    const onUp = () => {
      release();
      startSnapBack();
      commit();
    };

    const release = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dom.classList.remove('is-grabbing');
      releaseDrag = null;
    };

    releaseDrag = release;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  viewport.addEventListener('mousedown', onMouseDown);

  // -- Double click: fit, or zoom in when already fitted --

  function onDoubleClick(event: MouseEvent): void {
    if (!measured) return;
    event.preventDefault();
    event.stopPropagation();
    if (isAtFit(view, content, frame)) {
      zoom(DOUBLE_CLICK_ZOOM, pointerIn(event));
    } else {
      fit();
    }
  }
  viewport.addEventListener('dblclick', onDoubleClick);

  // -- Control buttons (mousedown, to fire before CodeMirror sees the event) --

  function bindButton(btn: HTMLElement, action: () => void): () => void {
    const listener = (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (measured) action();
    };
    btn.addEventListener('mousedown', listener);
    return () => btn.removeEventListener('mousedown', listener);
  }

  const unbind = [
    bindButton(zoomInBtn, () => zoom(BUTTON_ZOOM_STEP, frameCenter())),
    bindButton(zoomOutBtn, () => zoom(1 / BUTTON_ZOOM_STEP, frameCenter())),
    bindButton(fitBtn, () => fit()),
  ];

  // -- Resize handle --

  function onHandleDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = frame.height;

    const onMove = (move: MouseEvent) => {
      setFrameHeight(startHeight + (move.clientY - startY));
      view = userZoomed ? clampPan(view, content, frame) : computeFit(content, frame);
      apply();
    };

    const onUp = () => {
      release();
      commit();
    };

    const release = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dom.classList.remove('is-resizing');
      releaseDrag = null;
    };

    releaseDrag = release;
    dom.classList.add('is-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  handle.addEventListener('mousedown', onHandleDown);

  function onHandleDoubleClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setFrameHeight(null);
    fit();
  }
  handle.addEventListener('dblclick', onHandleDoubleClick);

  apply();

  return {
    dom,
    destroy() {
      destroyed = true;
      if (commitTimer) clearTimeout(commitTimer);
      if (gestureEndTimer) clearTimeout(gestureEndTimer);
      cancelSnapBack();
      releaseDrag?.();
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('mousedown', onMouseDown);
      viewport.removeEventListener('dblclick', onDoubleClick);
      handle.removeEventListener('mousedown', onHandleDown);
      handle.removeEventListener('dblclick', onHandleDoubleClick);
      for (const off of unbind) off();
    },
  };
}
