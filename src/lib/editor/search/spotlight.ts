import { EditorSelection, StateEffect, type EditorState, type Extension, type Line } from '@codemirror/state';
import { EditorView, RectangleMarker, ViewPlugin, layer, type LayerMarker, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { getSearchQuery } from '@codemirror/search';
import { matchIndexAt, searchMatches, searchMatchesExtension, searchMatchesField, type MatchList } from './match-count';
import { searchFocusField } from './panel-focus';
import { tableConfig, tableFitsCap } from '../preview/table-config';

/**
 * The search spotlight: while the human is typing in the Find panel, the
 * document dims and the matches stay at full strength, so "where are the
 * hits?" is answered at a glance instead of by reading.
 *
 * It is a veil: one translucent sheet of the page colour above the content,
 * with a hole cut out at every visible match. Everything dims the same way —
 * text, gradient headings, tables, diagrams, checkboxes — because nothing in
 * the document is restyled; the veil only covers it. The current match also
 * gets a soft halo drawn above the veil. (Fading whole lines and a single hole
 * at the current match were tried on a stand against it and dropped.)
 *
 * Active only while focus is in the panel's query or replace field, the query
 * is valid and has at least one match. Clicking back into the text turns the
 * dimming off; the match highlights stay as long as the panel is open.
 */

/** Whether the veil should be showing right now. */
export function spotlightOn(state: EditorState): boolean {
  if (!state.field(searchFocusField, false)) return false;
  if (!getSearchQuery(state).valid) return false;
  const matches = searchMatches(state);
  // Past the cap the matches beyond it are not listed, so they would get no
  // hole and sit dimmed like everything else — the veil would hide hits.
  return matches.from.length > 0 && !matches.capped;
}

/**
 * More visible matches than this and the veil is not drawn: with hits on every
 * line there is nothing to dim, and each one costs a measured rectangle and a
 * mask shape per redraw (a one-letter query in a long document).
 */
export const MAX_VEIL_HOLES = 300;

/** Asks the veil to measure again though nothing in the state changed. */
const remeasureVeil = StateEffect.define<null>();

/** Everything the spotlight draws from. A change in any of them redraws it. */
function inputsChanged(update: ViewUpdate): boolean {
  return (
    update.transactions.some((tr) => tr.effects.some((e) => e.is(remeasureVeil))) ||
    update.docChanged ||
    update.selectionSet ||
    update.viewportChanged ||
    update.startState.field(searchFocusField, false) !== update.state.field(searchFocusField, false) ||
    update.startState.field(searchMatchesField, false) !== update.state.field(searchMatchesField, false)
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
export function widgetHostLine(state: EditorState, pos: number): Line | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'Table') {
      // Over the cap a table stays raw markdown: the match is on its own line.
      const fits = tableFitsCap(state.doc, node.from, node.to, state.facet(tableConfig).maxLines);
      return fits ? state.doc.lineAt(node.from) : null;
    }
    if (node.name === 'FencedCode') {
      const info = node.getChild('CodeInfo');
      const lang = info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : '';
      return lang === 'mermaid' ? state.doc.lineAt(node.from) : null;
    }
  }
  return null;
}

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

/**
 * Boxes of `[from, to)` in layer coordinates, dropping degenerate ones.
 *
 * The common case — a match on one visual line — is two `coordsAtPos` calls.
 * `RectangleMarker.forRange` handles wrapping and bidi, but measures the line
 * box and walks the line's bidi spans for every match, so it is kept for the
 * matches that need it.
 */
function rangeBoxes(view: EditorView, from: number, to: number, base: { left: number; top: number }): Hole[] {
  const doc = view.state.doc;
  if (doc.lineAt(from).number === doc.lineAt(to).number) {
    const a = view.coordsAtPos(from, 1);
    const b = view.coordsAtPos(to, -1);
    if (a && b && Math.abs(a.top - b.top) < 1 && b.right - a.left > 0.5) {
      const top = Math.min(a.top, b.top);
      const bottom = Math.max(a.bottom, b.bottom);
      if (bottom - top > 0.5) return [{ x: a.left - base.left, y: top - base.top, w: b.right - a.left, h: bottom - top }];
    }
  }
  return RectangleMarker.forRange(view, '', EditorSelection.range(from, to))
    .filter((r) => r.width !== null && r.width > 0.5 && r.height > 0.5)
    .map((r) => ({ x: r.left, y: r.top, w: r.width ?? 0, h: r.height }));
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
  if (!spotlightOn(state)) return [];

  const matches = searchMatches(state);
  const main = state.selection.main;
  const current = matchIndexAt(matches, main.from, main.to);
  const base = layerBase(view);

  // The sheet: the viewport's blocks, stretched to the very top and bottom of
  // the scroll area when the viewport reaches the document's ends (the
  // content's own padding lives there).
  //
  // Sized only from things the veil itself cannot stretch: the content box
  // and the scroller's client box. Not `scrollWidth`/`scrollHeight` — the
  // layer's `contain` does not clip, so those include the veil's own previous
  // size, and after the scroller shrinks (a narrower window, the replace row
  // opening under a short document) the veil would keep its old size and pin
  // a scrollbar in place.
  const scroller = view.scrollDOM;
  const content = view.contentDOM.getBoundingClientRect();
  const docTop = view.documentTop - base.top;
  const viewport = view.viewport;
  const top = viewport.from === 0 ? 0 : docTop + view.lineBlockAt(viewport.from).top * view.scaleY;
  const bottom =
    viewport.to === state.doc.length
      ? Math.max(scroller.clientHeight * view.scaleY, content.bottom - base.top)
      : docTop + view.lineBlockAt(viewport.to).bottom * view.scaleY;
  const left = 0;
  const width = Math.max(scroller.clientWidth * view.scaleX, content.right - base.left);
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

  const visible = visibleMatches(view, matches);
  if (visible.length > MAX_VEIL_HOLES) return [];
  for (const match of visible) {
    const isCurrent = match.index === current;
    let boxes: Hole[] = match.to > match.from ? rangeBoxes(view, match.from, match.to, base) : [];
    // No text on screen for it: the match is inside a table or a diagram (or
    // it is an empty regexp match).
    if (boxes.length === 0) boxes = widgetRects(view, match.from, match.to, base);
    for (const b of boxes) {
      addHole(b.x, b.y, b.w, b.h);
      // The halo hugs the match itself; the hole's padding is what keeps the
      // match's own ring (search.css) out from under the veil.
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

/**
 * Fonts load lazily — JetBrains Mono the first time inline code or a code
 * block is on screen — and a late font changes glyph widths without changing
 * any line's height, so CM6 sees no geometry change (it re-measures for fonts
 * only once, at construction). The holes then stay at the fallback font's
 * widths and clip the last letter of a match in code. Measured in the browser.
 * A font load is rare, so one transaction per load is cheap.
 */
const fontWatch = ViewPlugin.fromClass(
  class {
    private readonly onFonts = (): void => {
      if (spotlightOn(this.view.state)) this.view.dispatch({ effects: remeasureVeil.of(null) });
    };

    constructor(private readonly view: EditorView) {
      document.fonts?.addEventListener('loadingdone', this.onFonts);
    }

    destroy(): void {
      document.fonts?.removeEventListener('loadingdone', this.onFonts);
    }
  }
);

/** The veil, with the state it reads. */
export function searchSpotlight(): Extension {
  return [searchFocusField, searchMatchesExtension, veilLayer, fontWatch];
}
