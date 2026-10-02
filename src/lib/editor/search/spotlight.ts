import { EditorSelection, Facet, RangeSetBuilder, type EditorState, type Extension, type Line } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  RectangleMarker,
  ViewPlugin,
  layer,
  type DecorationSet,
  type LayerMarker,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { getSearchQuery } from '@codemirror/search';
import { matchIndexAt, searchMatches, searchMatchesField, type MatchList } from './match-count';
import { searchFocusField } from './panel-focus';

/**
 * The search spotlight: while the human is typing in the Find panel, the
 * document dims and the matches stay at full strength, so "where are the
 * hits?" is answered at a glance instead of by reading.
 *
 * Three ways of dimming are on the stand (`stand-switcher.ts`, dev only) until
 * the owner picks one:
 *
 * - `veil` (A) — one translucent sheet of the page colour above the content,
 *   with a hole cut out at every visible match. Everything dims the same way —
 *   text, gradient headings, tables, diagrams, checkboxes — because nothing in
 *   the document is restyled; the veil only covers it. The current match also
 *   gets a glow ring drawn above the veil.
 * - `lines` (B) — every visible line without a match drops to low opacity.
 * - `spotlight` (C) — the veil with a single hole, at the current match; the
 *   other matches stay highlighted underneath it.
 *
 * Active only while focus is in the panel's query or replace field, the query
 * is valid and has at least one match. Clicking back into the text turns the
 * dimming off; the match highlights stay as long as the panel is open.
 */

export type SpotlightVariant = 'veil' | 'lines' | 'spotlight' | 'off';

/** Which dimming is installed. The first provider wins; the default is the veil. */
export const spotlightVariant = Facet.define<SpotlightVariant, SpotlightVariant>({
  combine: (values) => values[0] ?? 'veil',
});

/** Whether the dimming should be showing right now, whatever its variant. */
export function spotlightOn(state: EditorState): boolean {
  if (state.facet(spotlightVariant) === 'off') return false;
  if (!state.field(searchFocusField, false)) return false;
  if (!getSearchQuery(state).valid) return false;
  return searchMatches(state).from.length > 0;
}

/** Everything the spotlight draws from. A change in any of them redraws it. */
function inputsChanged(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.selectionSet ||
    update.viewportChanged ||
    update.startState.field(searchFocusField, false) !== update.state.field(searchFocusField, false) ||
    update.startState.field(searchMatchesField, false) !== update.state.field(searchMatchesField, false) ||
    update.startState.facet(spotlightVariant) !== update.state.facet(spotlightVariant)
  );
}

/**
 * The matches that intersect a visible range, from the document-wide list the
 * counter already keeps — one scan serves both, and the holes can never
 * disagree with the count. Folded text is not in `visibleRanges`, so a match
 * inside a fold gets no hole.
 */
function visibleMatches(view: EditorView, matches: MatchList): { from: number; to: number; index: number }[] {
  const out: { from: number; to: number; index: number }[] = [];
  const { from: starts, to: ends } = matches;
  for (const range of view.visibleRanges) {
    // First match ending at or after the range start.
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] < range.from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < starts.length && starts[i] <= range.to; i++) {
      if (out.length > 0 && out[out.length - 1].index >= i) continue;
      out.push({ from: starts[i], to: ends[i], index: i });
    }
  }
  return out;
}

/**
 * The line a match is drawn on when its own text is not on screen: tables are
 * one widget on their header line with the source lines hidden, and a mermaid
 * fence is one diagram on its opening line. Null for ordinary text.
 */
function widgetHostLine(state: EditorState, pos: number): Line | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'Table') return state.doc.lineAt(node.from);
    if (node.name === 'FencedCode') {
      const info = node.getChild('CodeInfo');
      const lang = info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : '';
      return lang === 'mermaid' ? state.doc.lineAt(node.from) : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// A and C: the veil
// ---------------------------------------------------------------------------

interface Hole {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Breathing room around a hole, so the match's own rounded fill is not clipped. */
const HOLE_PAD_X = 2;
const HOLE_PAD_Y = 1;
const HOLE_RADIUS = 4;

let maskSeq = 0;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * One SVG sheet over the rendered part of the document, masked so the holes
 * show the content through at full strength.
 *
 * A mask rather than `clip-path: path(evenodd, …)`: with even-odd filling two
 * holes that overlap (adjacent matches, padded) would cancel each other out in
 * the overlap, and with non-zero filling they would not cut at all. In a mask
 * the black shapes simply union.
 *
 * The sheet covers the viewport's blocks in document coordinates, not the
 * visible window, so scrolling inside the viewport moves it with the content
 * and needs no redraw at all.
 */
class VeilMarker implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly holes: readonly Hole[]
  ) {}

  eq(other: LayerMarker): boolean {
    if (!(other instanceof VeilMarker)) return false;
    if (
      other.left !== this.left ||
      other.top !== this.top ||
      other.width !== this.width ||
      other.height !== this.height ||
      other.holes.length !== this.holes.length
    ) {
      return false;
    }
    return this.holes.every((h, i) => {
      const o = other.holes[i];
      return h.x === o.x && h.y === o.y && h.w === o.w && h.h === o.h;
    });
  }

  draw(): HTMLElement {
    // The layer API types markers as HTMLElement; an SVG root behaves the same
    // inside the absolutely positioned layer, which is all the layer needs.
    const svg = document.createElementNS(SVG_NS, 'svg') as unknown as HTMLElement;
    svg.setAttribute('class', 'cm-md-search-veil');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.mask = `cm-md-search-veil-${++maskSeq}`;
    this.paint(svg);
    return svg;
  }

  update(dom: HTMLElement, prev: LayerMarker): boolean {
    if (!(prev instanceof VeilMarker) || !dom.dataset.mask) return false;
    this.paint(dom);
    return true;
  }

  private paint(svg: HTMLElement): void {
    svg.style.left = `${this.left}px`;
    svg.style.top = `${this.top}px`;
    svg.style.width = `${this.width}px`;
    svg.style.height = `${this.height}px`;
    svg.setAttribute('width', String(this.width));
    svg.setAttribute('height', String(this.height));
    const id = svg.dataset.mask as string;
    // Numbers only — nothing from the document reaches this string.
    const holes = this.holes
      .map((h) => `<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" rx="${HOLE_RADIUS}" fill="black"/>`)
      .join('');
    svg.innerHTML =
      `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${this.width}" height="${this.height}">` +
      `<rect width="${this.width}" height="${this.height}" fill="white"/>${holes}</mask></defs>` +
      `<rect class="cm-md-search-veil-fill" width="${this.width}" height="${this.height}" mask="url(#${id})"/>`;
  }
}

const round = (n: number): number => Math.round(n * 2) / 2;

/** Rectangles of `[from, to)` in layer coordinates, dropping degenerate ones. */
function rangeRects(view: EditorView, from: number, to: number): RectangleMarker[] {
  return RectangleMarker.forRange(view, '', EditorSelection.range(from, to)).filter(
    (r) => r.width !== null && r.width > 0.5 && r.height > 0.5
  );
}

/**
 * Where a match hidden behind a widget is on screen, in layer coordinates.
 * Read from the DOM: the widget's layout is whatever it rendered, which no
 * height map knows.
 *
 * A table cell renders its source text verbatim and says which source range
 * it is (`data-source-from`/`-to`, `widget-text-selection.ts`), so a match in
 * a cell gets a hole around exactly its own characters. When the cell text is
 * not a verbatim copy of the source (inline formatting inside the cell) the
 * hole is the cell; anything else — a mermaid diagram — opens the whole
 * widget.
 */
function widgetRects(view: EditorView, from: number, to: number, base: { left: number; top: number }): Hole[] {
  const host = widgetHostLine(view.state, from);
  if (!host) return [];
  const { node } = view.domAtPos(host.from);
  const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
  if (!line) return [];
  const toHole = (r: DOMRect): Hole => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
  const visible = (r: DOMRect): boolean => r.width >= 1 && r.height >= 1;

  for (const cell of line.querySelectorAll<HTMLElement>('[data-source-from][data-source-to]')) {
    const srcFrom = Number(cell.dataset.sourceFrom);
    const srcTo = Number(cell.dataset.sourceTo);
    if (from < srcFrom || to > srcTo) continue;
    const text = cell.firstChild;
    if (
      to > from &&
      text instanceof Text &&
      cell.childNodes.length === 1 &&
      text.data === view.state.sliceDoc(srcFrom, srcTo)
    ) {
      const range = document.createRange();
      range.setStart(text, from - srcFrom);
      range.setEnd(text, to - srcFrom);
      const rects = [...range.getClientRects()].filter(visible);
      if (rects.length > 0) return rects.map(toHole);
    }
    const box = cell.getBoundingClientRect();
    return visible(box) ? [toHole(box)] : [];
  }
  const box = line.getBoundingClientRect();
  return visible(box) ? [toHole(box)] : [];
}

/** The layer's origin on screen — the same arithmetic `RectangleMarker` uses. */
function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

function veilMarkers(view: EditorView): readonly LayerMarker[] {
  const { state } = view;
  const variant = state.facet(spotlightVariant);
  if ((variant !== 'veil' && variant !== 'spotlight') || !spotlightOn(state)) return [];

  const matches = searchMatches(state);
  const main = state.selection.main;
  const current = matchIndexAt(matches, main.from, main.to);
  const base = layerBase(view);

  // The sheet: the viewport's blocks, stretched to the very top and bottom of
  // the scroll area when the viewport reaches the document's ends (the
  // content's own padding lives there).
  const scroller = view.scrollDOM;
  const docTop = view.documentTop - base.top;
  const viewport = view.viewport;
  const top = viewport.from === 0 ? 0 : docTop + view.lineBlockAt(viewport.from).top * view.scaleY;
  const bottom =
    viewport.to === state.doc.length
      ? Math.max(scroller.scrollHeight * view.scaleY, docTop + view.contentHeight * view.scaleY)
      : docTop + view.lineBlockAt(viewport.to).bottom * view.scaleY;
  const left = 0;
  const width = Math.max(scroller.scrollWidth, scroller.clientWidth) * view.scaleX;
  const height = Math.max(0, bottom - top);

  const holes: Hole[] = [];
  const glow: LayerMarker[] = [];
  const seen = new Set<string>();
  const addHole = (x: number, y: number, w: number, h: number): void => {
    const hole = {
      x: round(x - left - HOLE_PAD_X),
      y: round(y - top - HOLE_PAD_Y),
      w: round(w + HOLE_PAD_X * 2),
      h: round(h + HOLE_PAD_Y * 2),
    };
    const key = `${hole.x},${hole.y},${hole.w},${hole.h}`;
    if (seen.has(key)) return;
    seen.add(key);
    holes.push(hole);
  };

  for (const match of visibleMatches(view, matches)) {
    const isCurrent = match.index === current;
    if (variant === 'spotlight' && !isCurrent) continue;
    let boxes: Hole[] =
      match.to > match.from
        ? rangeRects(view, match.from, match.to).map((r) => ({ x: r.left, y: r.top, w: r.width ?? 0, h: r.height }))
        : [];
    // No text on screen for it: the match is inside a table or a diagram (or
    // it is an empty regexp match).
    if (boxes.length === 0) boxes = widgetRects(view, match.from, match.to, base);
    for (const b of boxes) {
      addHole(b.x, b.y, b.w, b.h);
      // The ring hugs the match itself; the hole's padding is what keeps the
      // ring's own width out from under the veil.
      if (isCurrent) glow.push(new RectangleMarker('cm-md-search-glow', round(b.x), round(b.y), round(b.w), round(b.h)));
    }
  }

  return [new VeilMarker(round(left), round(top), round(width), round(height), holes), ...glow];
}

const veilLayer = layer({
  above: true,
  class: 'cm-md-search-veil-layer',
  markers: veilMarkers,
  update: (update) => inputsChanged(update),
});

// ---------------------------------------------------------------------------
// B: line focus
// ---------------------------------------------------------------------------

const dimLine = Decoration.line({ class: 'cm-md-search-dim' });

function dimDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  if (state.facet(spotlightVariant) !== 'lines' || !spotlightOn(state)) return Decoration.none;
  const lit = new Set<number>();
  for (const match of visibleMatches(view, searchMatches(state))) {
    const first = state.doc.lineAt(match.from).number;
    const last = state.doc.lineAt(match.to).number;
    for (let n = first; n <= last; n++) lit.add(n);
    // A match in a table row lives on a hidden line; the widget is drawn on
    // the header line, so that is the one to keep lit.
    const host = widgetHostLine(state, match.from);
    if (host) lit.add(host.number);
  }
  const builder = new RangeSetBuilder<Decoration>();
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      // Two visible ranges split by a fold can share a line; decorate it once.
      if (line.number > last && !lit.has(line.number)) builder.add(line.from, line.from, dimLine);
      last = Math.max(last, line.number);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const linesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = dimDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (inputsChanged(update)) this.decorations = dimDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations }
);

/** The spotlight in every variant; `spotlightVariant` picks the one that draws. */
export function searchSpotlight(): Extension {
  return [searchFocusField, searchMatchesField, veilLayer, linesPlugin];
}
