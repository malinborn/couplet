import { Facet, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { DecoSink } from './utils';

/**
 * List layout (View → Explicit Lists, prototype).
 *
 * `classic` — today's layout: every level steps by `--list-indent-step`,
 * wrapped lines go back to the line edge.
 *
 * `explicit` — a child sits exactly under its parent's first text character,
 * a wrapped line hangs under the item's own text, and an item that spans more
 * than one line draws a guide from its marker down to its block's last line.
 * Every ancestor's guide passes through every line it covers, so the number of
 * guides left of a line is its depth.
 */
export type ListStyle = 'classic' | 'explicit';

export const listStyleFacet: Facet<ListStyle, ListStyle> = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : 'classic'),
});

export function listStyleExtension(style: ListStyle): Extension {
  return style === 'explicit'
    ? [listStyleFacet.of('explicit'), EditorView.editorAttributes.of({ class: 'cm-xl' })]
    : [listStyleFacet.of('classic')];
}

export function isExplicitLists(state: EditorState): boolean {
  return state.facet(listStyleFacet) === 'explicit';
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
  columnsOf: (item: SyntaxNode) => number,
  builder: DecoSink
): void {
  const lines = new Map<number, LineLayout>();

  const walk = (listNode: SyntaxNode, outer: string[], guides: Guide[]): void => {
    for (let item = listNode.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const kind = markerKind(item, doc, columnsOf(item));
      const gutter = markerGutter(kind);
      const content = [...outer, gutter];
      const first = doc.lineAt(item.from).number;
      const last = lastLine(doc, item);
      const own: Guide | null =
        last > first ? { x: [...outer, markerAnchor(kind)], belowFirst: false } : null;

      lines.set(first, {
        content,
        hang: gutter,
        guides: own ? [...guides, { ...own, belowFirst: true }] : guides,
      });
      const inner = own ? [...guides, own] : guides;
      for (let n = first + 1; n <= last; n++) {
        lines.set(n, { content, hang: null, guides: inner });
      }
      for (let child = item.firstChild; child; child = child.nextSibling) {
        if (isListNode(child)) walk(child, content, inner);
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

  for (const [n, layout] of [...lines].sort((a, b) => a[0] - b[0])) {
    const line = doc.line(n);
    builder.add(
      line.from,
      line.from,
      Decoration.line({ class: 'cm-md-xl-line', attributes: { style: lineStyle(layout) } })
    );
    if (!markerLines.has(n)) {
      const ws = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
      if (ws > 0 && ws < line.length) builder.add(line.from, line.from + ws, collapse);
    }
  }
}
