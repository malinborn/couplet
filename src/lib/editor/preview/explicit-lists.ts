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
 * Lengths are CSS expressions, summed with `calc` at the line. The variables
 * are registered `<length>`s declared on `.cm-content` (editor.css), so they
 * are pixels by the time a line reads them: a code line at 0.9em or a heading
 * inside an item keeps the same columns and guides as its neighbours. A bare
 * `em` or `ch` here would be measured in each line's own font.
 */
export function markerBox(m: MarkerKind): string {
  switch (m.kind) {
    case 'bullet':
      return 'var(--xl-bullet-w)';
    case 'task':
      return 'var(--xl-task-w)';
    case 'ordered':
      return `(${m.columns} * var(--xl-ch))`;
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
      return `(${m.columns - m.digits / 2} * var(--xl-ch) - var(--xl-dot-w))`;
  }
}

/**
 * Same checkbox test as the classic path and `live-render/atomic.ts`: lowercase
 * `x` only — `[X]` is text there, so it is text here too.
 */
const CHECKBOX_AFTER = /^\s\[[x ]\]/;

export function markerKind(item: SyntaxNode, doc: Text, columns: number): MarkerKind {
  const mark = item.getChild('ListMark');
  if (!mark) return { kind: 'bullet' };
  const text = doc.sliceString(mark.from, mark.to);
  const after = doc.sliceString(mark.to, Math.min(mark.to + 5, doc.length));
  if (CHECKBOX_AFTER.test(after)) return { kind: 'task' };
  // `listMarkColumns` stops at 4 for the classic `min-width` box; this box
  // has a fixed width, so a `1000.` widens its own.
  if (/^\d/.test(text)) {
    return { kind: 'ordered', columns: Math.max(columns, text.length), digits: text.length - 1 };
  }
  return { kind: 'bullet' };
}

/** Where the marker's widget (or text) ends: after `[ ]` for a task. */
export function markerEnd(kind: MarkerKind, mark: SyntaxNode): number {
  return kind.kind === 'task' ? mark.to + 4 : mark.to;
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
  /** A line of a fenced block in the item: it keeps the block's own inner padding. */
  code: boolean;
}

const sum = (terms: string[]): string => (terms.length ? terms.join(' + ') : '0px');

function lineStyle(l: LineLayout): string {
  const pad = l.code ? [...l.content, 'var(--xl-code-pad)'] : l.content;
  const parts = [`padding-left: calc(var(--xl-base) + ${sum(pad)})`];
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

/** A fence delimiter: its line is hidden (`blocks.ts`), so it is no line to the reader. */
function isFenceLine(doc: Text, n: number): boolean {
  return /^\s*(```|~~~)/.test(doc.line(n).text);
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

/**
 * The item's content column in the source (CommonMark): the marker's column
 * plus the 1–4 spaces after it, or plus one when 5+ follow (indented code) or
 * nothing does. A continuation line's indent up to this column is the item's;
 * anything past it — the indentation inside a code block — is the text's own.
 */
function contentColumn(doc: Text, mark: SyntaxNode): number {
  const line = doc.lineAt(mark.from);
  const rest = line.text.slice(mark.to - line.from);
  const spaces = rest.match(/^[ \t]*/)?.[0].length ?? 0;
  const step = spaces === 0 || spaces >= 5 || spaces === rest.length ? 1 : spaces;
  return mark.to - line.from + step;
}

/** What one top-level list looks like under a layout. */
export interface ExplicitListPlan {
  lines: Map<number, LineLayout>;
  /**
   * Source whitespace drawn at zero width: the gap after each marker (the box
   * carries `--xl-gap` instead) and continuation indents up to the item's
   * content column (the padding draws them). `live-render/atomic.ts` makes the
   * same ranges atomic, so the caret never stops inside a run it cannot see.
   */
  collapsed: { from: number; to: number }[];
}

export function planExplicitList(
  doc: Text,
  list: SyntaxNode,
  layout: ListLayout,
  columnsOf: (item: SyntaxNode) => number
): ExplicitListPlan {
  const lines = new Map<number, LineLayout>();
  const collapsed: { from: number; to: number }[] = [];
  /** Per continuation line: the content column of the innermost item holding it. */
  const continuation = new Map<number, number>();
  const codeLines = new Set<number>();

  // `outer`: where this list's markers start. Strict: the parent's text
  // column. Otherwise the parent's marker plus one classic step, and a wrapped
  // line goes back to the marker — the item's own guide then starts on the
  // next source line, or it would run through the wrapped text.
  const walk = (listNode: SyntaxNode, outer: string[], guides: Guide[]): void => {
    for (let item = listNode.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const mark = item.getChild('ListMark');
      if (!mark) continue;
      const kind = markerKind(item, doc, columnsOf(item));
      const gutter = markerGutter(kind);
      const content = [...outer, gutter];
      const first = doc.lineAt(item.from).number;
      const last = lastLine(doc, item);
      const firstLine = doc.line(first);

      const end = markerEnd(kind, mark);
      const gap = firstLine.text.slice(end - firstLine.from).match(/^[ \t]*/)?.[0].length ?? 0;
      if (gap > 0) collapsed.push({ from: end, to: end + gap });

      let below = 0;
      for (let n = first + 1; n <= last && below < GUIDE_MIN_LINES; n++) {
        if (!isBlank(doc, n) && !isFenceLine(doc, n)) below++;
      }
      const own: Guide | null =
        layout.guides && below >= GUIDE_MIN_LINES
          ? { x: [...outer, markerAnchor(kind)], belowFirst: false }
          : null;

      lines.set(first, {
        content: layout.strict ? content : outer,
        hang: layout.strict ? gutter : null,
        guides: own && layout.strict ? [...guides, { ...own, belowFirst: true }] : guides,
        code: false,
      });
      continuation.delete(first);
      const inner = own ? [...guides, own] : guides;
      const column = contentColumn(doc, mark);
      for (let n = first + 1; n <= last; n++) {
        lines.set(n, { content, hang: null, guides: inner, code: false });
        continuation.set(n, column);
      }
      const childOuter = layout.strict ? content : [...outer, 'var(--xl-step)'];
      for (let child = item.firstChild; child; child = child.nextSibling) {
        if (isListNode(child)) walk(child, childOuter, inner);
        else if (child.name === 'FencedCode') {
          const a = doc.lineAt(child.from).number;
          const b = doc.lineAt(child.to).number;
          for (let n = a; n <= b; n++) codeLines.add(n);
        }
      }
    }
  };
  walk(list, [], []);

  for (const [n, column] of continuation) {
    const line = doc.line(n);
    const ws = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
    const hide = Math.min(ws, column);
    if (hide > 0 && ws < line.length) collapsed.push({ from: line.from, to: line.from + hide });
  }
  for (const n of codeLines) {
    const l = lines.get(n);
    if (l) l.code = true;
  }
  collapsed.sort((a, b) => a.from - b.from);
  return { lines, collapsed };
}

const collapse = Decoration.mark({ class: 'cm-md-list-indent' });

/**
 * Lays out one top-level list and everything nested in it. Marker boxes and
 * widgets are still `decorateListItem`'s; this pass owns the line geometry —
 * padding, the hanging indent, the guides — and the whitespace it draws at
 * zero width (`ExplicitListPlan.collapsed`).
 */
export function layoutExplicitList(
  doc: Text,
  list: SyntaxNode,
  layout: ListLayout,
  columnsOf: (item: SyntaxNode) => number,
  builder: DecoSink
): void {
  const plan = planExplicitList(doc, list, layout, columnsOf);
  for (const [n, geometry] of plan.lines) {
    const from = doc.line(n).from;
    builder.add(
      from,
      from,
      Decoration.line({ class: 'cm-md-xl-line', attributes: { style: lineStyle(geometry) } })
    );
  }
  for (const r of plan.collapsed) builder.add(r.from, r.to, collapse);
}

/** True for a list the layout pass starts from: outermost, and not in a quote. */
export function isExplicitRoot(node: SyntaxNode): boolean {
  if (!isListNode(node) || node.parent?.name === 'ListItem') return false;
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'Blockquote') return false;
  }
  return true;
}
