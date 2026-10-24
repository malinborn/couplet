import { Facet, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { DecoSink } from './utils';

/**
 * View → Lists. Two switches and two looks:
 *
 * - `guides` — an item with at least `GUIDE_MIN_LINES` lines under its marker
 *   draws a line from the marker down to its block's last line. Every
 *   ancestor's line passes through every line it covers, so the number of
 *   lines left of a line is its depth.
 * - `strict` — a child sits exactly under its parent's first text character,
 *   and a wrapped line hangs under the item's own text: no letter ever goes
 *   left of its item's text column.
 * - `guideStyle`, `density` — how the guide is drawn, how much room the marker
 *   column takes. Not switches: the presets leave them alone.
 *
 * With both switches off the classic layout is untouched (`lists.ts`'s depth
 * steps); `density` then only scales its step. With either on, this module
 * owns the geometry of every list line not inside a quote.
 */
export interface ListLayout {
  guides: boolean;
  strict: boolean;
  guideStyle: GuideStyle;
  density: ListDensity;
}
export type GuideStyle = 'solid' | 'dashed' | 'dotted';
export type ListDensity = 'compact' | 'standard' | 'sparse';
export type ListPreset = 'standard' | 'explicit';

export const GUIDE_STYLES: readonly GuideStyle[] = ['solid', 'dashed', 'dotted'];
export const LIST_DENSITIES: readonly ListDensity[] = ['compact', 'standard', 'sparse'];

export const DEFAULT_LIST_LAYOUT: ListLayout = {
  guides: false,
  strict: false,
  guideStyle: 'solid',
  density: 'standard',
};

/** A preset sets the switches and nothing else. */
export function applyListPreset(layout: ListLayout, preset: ListPreset): ListLayout {
  const on = preset === 'explicit';
  return { ...layout, guides: on, strict: on };
}

/** The preset the switches currently match, if any (the menu checks it). */
export function listPresetOf(layout: ListLayout): ListPreset | null {
  if (layout.guides && layout.strict) return 'explicit';
  if (!layout.guides && !layout.strict) return 'standard';
  return null;
}

/** Whether this module lays the lists out, rather than the classic depth steps. */
export function ownsListGeometry(layout: ListLayout): boolean {
  return layout.guides || layout.strict;
}

/**
 * A stored value as a layout: anything missing or unknown takes its default,
 * so a setting written by another build never breaks the editor.
 */
export function normalizeListLayout(raw: unknown): ListLayout {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    guides: typeof r.guides === 'boolean' ? r.guides : DEFAULT_LIST_LAYOUT.guides,
    strict: typeof r.strict === 'boolean' ? r.strict : DEFAULT_LIST_LAYOUT.strict,
    guideStyle: GUIDE_STYLES.includes(r.guideStyle as GuideStyle)
      ? (r.guideStyle as GuideStyle)
      : DEFAULT_LIST_LAYOUT.guideStyle,
    density: LIST_DENSITIES.includes(r.density as ListDensity)
      ? (r.density as ListDensity)
      : DEFAULT_LIST_LAYOUT.density,
  };
}

/**
 * View → Lists menu ids (`menu.rs`). Every one carries its value — a preset, a
 * style, `:on`/`:off` for the two switches (`toggle_value` in `lib.rs`) — so N
 * windows applying the same event agree. `null`: not a list action.
 */
export function listLayoutFromMenu(layout: ListLayout, id: string): ListLayout | null {
  if (id === 'list_preset_standard') return applyListPreset(layout, 'standard');
  if (id === 'list_preset_explicit') return applyListPreset(layout, 'explicit');
  const toggle = /^toggle_list_(guides|strict):(on|off)$/.exec(id);
  if (toggle) return { ...layout, [toggle[1]]: toggle[2] === 'on' };
  const style = /^list_guide_(\w+)$/.exec(id);
  if (style && GUIDE_STYLES.includes(style[1] as GuideStyle)) {
    return { ...layout, guideStyle: style[1] as GuideStyle };
  }
  const density = /^list_density_(\w+)$/.exec(id);
  if (density && LIST_DENSITIES.includes(density[1] as ListDensity)) {
    return { ...layout, density: density[1] as ListDensity };
  }
  return null;
}

/** Fewer lines than this under a marker draw no guide: one line needs no line. */
export const GUIDE_MIN_LINES = 2;

export const listLayoutFacet: Facet<ListLayout, ListLayout> = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : DEFAULT_LIST_LAYOUT),
});

export function listLayoutExtension(layout: ListLayout): Extension {
  const classes = [`cm-list-${layout.density}`];
  if (ownsListGeometry(layout)) classes.push('cm-xl');
  if (layout.strict) classes.push('cm-xl-strict');
  classes.push(`cm-xl-guide-${layout.guideStyle}`);
  return [listLayoutFacet.of(layout), EditorView.editorAttributes.of({ class: classes.join(' ') })];
}

export function listLayoutOf(state: EditorState): ListLayout {
  return state.facet(listLayoutFacet);
}

/** True when `lists.ts` must leave line geometry to `layoutExplicitList`. */
export function isExplicitLists(state: EditorState): boolean {
  return ownsListGeometry(listLayoutOf(state));
}

/** What the marker of an item is, as far as layout cares. */
export type MarkerKind =
  | { kind: 'bullet' }
  | { kind: 'task' }
  | { kind: 'ordered'; columns: number; digits: number };

/**
 * Lengths are CSS expressions, summed with `calc` at the line. They mix `em`,
 * `ch` and `px` — the marker of an ordered list is measured in digits, a
 * checkbox in pixels — so they cannot be added up in JS.
 */
export function markerBox(m: MarkerKind): string {
  switch (m.kind) {
    case 'bullet':
      return 'var(--xl-bullet-w)';
    case 'task':
      return 'var(--xl-task-w)';
    case 'ordered':
      return `${m.columns}ch`;
  }
}

/** Box plus the gap before the text: how far this item's text sits from its marker's left edge. */
export function markerGutter(m: MarkerKind): string {
  return `(${markerBox(m)} + var(--xl-gap))`;
}

/**
 * Where the guide leaves the marker, from the marker box's left edge. A
 * number is right aligned in its box (so `9.` and `10.` share a text column),
 * which puts its digits at the right minus the dot: the guide hangs from the
 * middle of the digits, not from the middle of the box.
 */
function markerAnchor(m: MarkerKind): string {
  switch (m.kind) {
    case 'bullet':
      return '(var(--xl-bullet-w) / 2)';
    case 'task':
      return '(var(--xl-task-w) / 2)';
    case 'ordered':
      return `(${m.columns}ch - var(--xl-dot-w) - ${m.digits / 2}ch)`;
  }
}

export function markerKind(item: SyntaxNode, doc: Text, columns: number): MarkerKind {
  const mark = item.getChild('ListMark');
  if (!mark) return { kind: 'bullet' };
  const text = doc.sliceString(mark.from, mark.to);
  if (/^\d/.test(text)) return { kind: 'ordered', columns, digits: text.length - 1 };
  const after = doc.sliceString(mark.to, Math.min(mark.to + 5, doc.length));
  if (/^\s\[[xX ]\]/.test(after)) return { kind: 'task' };
  return { kind: 'bullet' };
}

interface Guide {
  /** Terms of the guide's x, summed after the base line padding. */
  x: string[];
  /** Starts below the first visual line rather than at the top: the marker's own line. */
  belowFirst: boolean;
}

interface LineLayout {
  /** Terms of the text start, summed after the base line padding. */
  content: string[];
  /** The item's own gutter on its marker line: the line hangs back by this much. */
  hang: string | null;
  guides: Guide[];
}

const sum = (terms: string[]): string => (terms.length ? terms.join(' + ') : '0px');

function lineStyle(l: LineLayout): string {
  const parts = [`padding-left: calc(var(--xl-base) + ${sum(l.content)})`];
  if (l.hang) parts.push(`text-indent: calc(-1 * ${l.hang})`);
  if (l.guides.length) {
    parts.push(`background-image: ${l.guides.map(() => 'var(--xl-guide)').join(', ')}`);
    parts.push(
      `background-position: ${l.guides
        .map(
          (g) =>
            `calc(var(--xl-base) + ${sum(g.x)} - var(--xl-guide-w) / 2) ${g.belowFirst ? 'var(--xl-guide-start)' : '0'}`
        )
        .join(', ')}`
    );
    parts.push(`background-size: ${l.guides.map(() => 'var(--xl-guide-w) 100%').join(', ')}`);
  }
  return parts.join('; ');
}

function isBlank(doc: Text, n: number): boolean {
  return /^\s*$/.test(doc.line(n).text);
}

/** Last line that belongs to `item`, trailing blank lines dropped (a loose list keeps them in the item). */
function lastLine(doc: Text, item: SyntaxNode): number {
  const first = doc.lineAt(item.from).number;
  let last = doc.lineAt(Math.max(item.from, item.to - 1)).number;
  while (last > first && isBlank(doc, last)) last--;
  return last;
}

function isListNode(n: SyntaxNode): boolean {
  return n.name === 'BulletList' || n.name === 'OrderedList';
}

const collapse = Decoration.mark({ class: 'cm-md-list-indent' });

/**
 * Lays out one top-level list and everything nested in it. Marker boxes and
 * widgets are still `decorateListItem`'s; this pass owns the line geometry —
 * padding, the hanging indent, the guides — and the leading whitespace of
 * continuation lines, which only it knows the meaning of.
 */
export function layoutExplicitList(
  doc: Text,
  list: SyntaxNode,
  layout: ListLayout,
  columnsOf: (item: SyntaxNode) => number,
  builder: DecoSink
): void {
  const lines = new Map<number, LineLayout>();

  // `outer`: where this list's markers start. Strict: the parent's text
  // column. Otherwise the parent's marker plus one classic step, and a wrapped
  // line goes back to the marker — the item's own guide then starts on the
  // next source line, or it would run through the wrapped text.
  const walk = (listNode: SyntaxNode, outer: string[], guides: Guide[]): void => {
    for (let item = listNode.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const kind = markerKind(item, doc, columnsOf(item));
      const gutter = markerGutter(kind);
      const content = [...outer, gutter];
      const first = doc.lineAt(item.from).number;
      const last = lastLine(doc, item);
      let below = 0;
      for (let n = first + 1; n <= last && below < GUIDE_MIN_LINES; n++) {
        if (!isBlank(doc, n)) below++;
      }
      const own: Guide | null =
        layout.guides && below >= GUIDE_MIN_LINES
          ? { x: [...outer, markerAnchor(kind)], belowFirst: false }
          : null;

      lines.set(first, {
        content: layout.strict ? content : outer,
        hang: layout.strict ? gutter : null,
        guides: own && layout.strict ? [...guides, { ...own, belowFirst: true }] : guides,
      });
      const inner = own ? [...guides, own] : guides;
      for (let n = first + 1; n <= last; n++) {
        lines.set(n, { content, hang: null, guides: inner });
      }
      // `--list-indent-step` is declared on `.cm-content` (density scales it
      // there), so it is read at the line rather than through a variable
      // declared on `.cm-editor`, where it does not resolve.
      const childOuter = layout.strict ? content : [...outer, 'var(--list-indent-step)'];
      for (let child = item.firstChild; child; child = child.nextSibling) {
        if (isListNode(child)) walk(child, childOuter, inner);
      }
    }
  };
  walk(list, [], []);

  // Continuation lines (not a marker line): their source indent is the item's
  // content column in CommonMark, which the padding now draws — hide it.
  const markerLines = new Set<number>();
  list.cursor().iterate((n) => {
    if (n.name === 'ListItem') markerLines.add(doc.lineAt(n.from).number);
  });

  for (const [n, geometry] of [...lines].sort((a, b) => a[0] - b[0])) {
    const line = doc.line(n);
    builder.add(
      line.from,
      line.from,
      Decoration.line({ class: 'cm-md-xl-line', attributes: { style: lineStyle(geometry) } })
    );
    if (!markerLines.has(n)) {
      const ws = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
      if (ws > 0 && ws < line.length) builder.add(line.from, line.from + ws, collapse);
    }
  }
}
