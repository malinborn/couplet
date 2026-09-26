import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { RangeSetBuilder, type Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import type { DecoSink } from './utils';

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private pos: number) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-md-checkbox';
    input.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const replacement = this.checked ? '[ ]' : '[x]';
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: replacement },
      });
    });
    return input;
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked && this.pos === other.pos;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class BulletWidget extends WidgetType {
  constructor(private columns: number) {
    super();
  }

  // The glyph is a child rather than the box itself: the box's width is set in
  // `ch`, and `ch` inside the enlarged glyph would measure the enlarged font.
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-md-bullet cm-md-list-mark-w${this.columns}`;
    const glyph = document.createElement('span');
    glyph.className = 'cm-md-bullet-glyph';
    glyph.textContent = '\u2022';
    span.appendChild(glyph);
    return span;
  }

  eq(other: BulletWidget): boolean {
    return this.columns === other.columns;
  }
}

/**
 * How deep this item sits, counting from 1. Derived from the tree rather than
 * from the leading whitespace so a document written with four-space indents
 * steps by the same amount as one written with two.
 */
export function listItemDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
  }
  return depth;
}

// The line decoration carries the *whole* indent — the item's own leading
// whitespace is collapsed to zero width alongside it. Levels past this cap
// share the deepest step rather than marching off the right edge.
const MAX_INDENT_DEPTH = 6;

const depthLines: readonly Decoration[] = Array.from(
  { length: MAX_INDENT_DEPTH + 1 },
  (_, depth) => Decoration.line({ class: `cm-md-list-d${depth}` })
);

/**
 * Collapses the source indent to zero width, so the step between two levels is
 * the line decoration's padding and nothing else.
 *
 * Without this the visual step also carries the source's own indentation, which
 * CommonMark makes marker-dependent: a child of `-` starts at column 2, of `1.`
 * at 3, of `10.` at 4. That is what made ordered lists step by a different
 * amount than bullet ones, and by a different amount at each level (#44).
 */
const indentMark = Decoration.mark({ class: 'cm-md-list-indent' });

const checkedTextMark = Decoration.mark({ class: 'cm-md-task-done' });

/**
 * The checked item's own text, as one range per line it occupies.
 *
 * Bounded by the `Task` node rather than by the line, for two reasons: a
 * wrapped item keeps its continuation lines greyed, and a nested child list is
 * left alone — `Task` ends where the child `BulletList` begins, so ticking a
 * parent does not strike through its unfinished children.
 *
 * One range per line rather than one spanning range because the line-through
 * would otherwise be drawn over the indentation too: the space after `[x]` and,
 * on a wrapped item, the leading whitespace of every continuation line — a
 * stray dash hanging to the left of the text.
 */
function checkedTextRanges(
  item: SyntaxNode,
  doc: Text,
  markerEnd: number
): { from: number; to: number }[] {
  const task = item.getChild('Task');
  const end = task ? task.to : doc.lineAt(markerEnd).to;
  const out: { from: number; to: number }[] = [];
  for (let n = doc.lineAt(markerEnd).number; n <= doc.lineAt(end).number; n++) {
    const line = doc.line(n);
    const to = Math.min(line.to, end);
    const start = Math.max(line.from, markerEnd);
    const from = start + (doc.sliceString(start, to).match(/^[ \t]*/)?.[0].length ?? 0);
    if (to > from) out.push({ from, to });
  }
  return out;
}

// `999.` is where sanity ends; a wider marker just grows its own box.
const MAX_MARK_COLUMNS = 4;
// A bullet is one character, but reserving two keeps bullet items and
// single-digit ordered items on one text column.
const MIN_MARK_COLUMNS = 2;

const markBoxes: readonly Decoration[] = Array.from(
  { length: MAX_MARK_COLUMNS + 1 },
  (_, columns) => Decoration.mark({ class: `cm-md-list-mark cm-md-list-mark-w${columns}` })
);

function markLength(item: SyntaxNode | null, doc: Text): number {
  if (!item || item.name !== 'ListItem') return 0;
  const mark = item.getChild('ListMark');
  if (!mark) return 0;
  return doc.sliceString(mark.from, mark.to).length;
}

/**
 * Width, in characters, of the marker column for the list `item` belongs to.
 *
 * One width for the whole list, so `9.` and `10.` do not start their text in
 * different columns. Ordered numbers ascend, so the widest marker is the last
 * item's; the first is checked too for a list that starts at a wide number.
 * Reading two siblings keeps this O(1) per item — walking every sibling would
 * make a decoration build quadratic in the length of a long list.
 */
export function listMarkColumns(item: SyntaxNode, doc: Text): number {
  const list = item.parent;
  let widest = markLength(item, doc);
  if (list) {
    widest = Math.max(widest, markLength(list.firstChild, doc), markLength(list.lastChild, doc));
  }
  return Math.min(Math.max(widest, MIN_MARK_COLUMNS), MAX_MARK_COLUMNS);
}

/**
 * The run of spaces/tabs the item's marker sits behind, as an absolute range.
 *
 * Only the whitespace immediately before the marker: a list inside a blockquote
 * must not have its `>` swallowed, since that marker is revealed under the
 * caret in live-preview and would then collapse instead of appearing.
 */
function sourceIndentRange(doc: Text, markFrom: number): { from: number; to: number } {
  const line = doc.lineAt(markFrom);
  let start = markFrom - line.from;
  while (start > 0) {
    const ch = line.text[start - 1];
    if (ch !== ' ' && ch !== '\t') break;
    start--;
  }
  // The one space after a `>` is hidden by the quote already (see
  // `blockquoteLayout`); collapsing it here too would overlap the two.
  if (start > 0 && line.text[start - 1] === '>' && line.from + start < markFrom) start++;
  return { from: line.from + start, to: markFrom };
}

/**
 * Continuation lines of a quote that sits in this item (`- > x` / `  > y`).
 *
 * The first line lays out as [collapsed indent][marker box][space][text]; the
 * continuation line carries the same characters as whitespace — indent under
 * the indent, spaces under the marker, a space under the space. Giving them the
 * same treatment (depth padding, collapsed indent, a marker-sized box) puts the
 * second line's text on the first line's column. The `> ` itself is hidden by
 * `blockquoteLayout`, which leaves this indent alone inside a list item.
 *
 * Only quotes: an ordinary paragraph continuation (`- a` / `  b`) keeps its
 * layout, which is a separate decision about every list in every document.
 */
function alignQuoteContinuation(
  doc: Text,
  item: SyntaxNode,
  listMark: SyntaxNode,
  depth: number,
  indentFrom: number,
  builder: DecoSink
): void {
  const first = doc.lineAt(item.from);
  const lead = indentFrom - first.from; // where the collapsed indent starts
  const indentLength = listMark.from - indentFrom;
  const markLength = listMark.to - listMark.from;
  const columns = listMarkColumns(item, doc);

  for (const quote of item.getChildren('Blockquote')) {
    const last = doc.lineAt(quote.to).number;
    for (let n = doc.lineAt(quote.from).number + 1; n <= last; n++) {
      if (n <= first.number) continue;
      const line = doc.line(n);
      const from = line.from + lead;
      const to = from + indentLength + markLength;
      if (to > line.to || !/^[ \t]*$/.test(doc.sliceString(from, to))) continue;
      if (!/^[ \t]*$/.test(doc.sliceString(line.from, from))) continue;
      if (depth > 1) builder.add(line.from, line.from, depthLines[depth]);
      if (indentLength > 0) builder.add(from, from + indentLength, indentMark);
      builder.add(from + indentLength, to, markBoxes[columns]);
    }
  }
}

export function decorateListItem(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  const listMark = node.getChild('ListMark');
  if (!listMark) return;

  const doc = view.state.doc;

  // Emitted before every early return below, and regardless of `shouldReveal`:
  // the indent must not shift sideways when the caret lands on the line.
  const depth = Math.min(listItemDepth(node), MAX_INDENT_DEPTH);
  if (depth > 1) {
    const lineFrom = doc.lineAt(node.from).from;
    builder.add(lineFrom, lineFrom, depthLines[depth]);
  }
  const indent = sourceIndentRange(doc, listMark.from);
  if (indent.to > indent.from) builder.add(indent.from, indent.to, indentMark);

  const afterMark = doc.sliceString(listMark.to, Math.min(listMark.to + 5, doc.length));

  const checkboxMatch = afterMark.match(/^\s\[([x ])\]/);
  if (!checkboxMatch) {
    alignQuoteContinuation(doc, node, listMark, depth, indent.from, builder);
  }
  if (checkboxMatch) {
    // Always show checkbox widget — even when cursor is on this line
    const isChecked = checkboxMatch[1] === 'x';
    const checkboxStart = listMark.to + 1;
    builder.add(
      listMark.from,
      checkboxStart + 3,
      Decoration.replace({
        widget: new CheckboxWidget(isChecked, checkboxStart),
      })
    );
    if (isChecked) {
      for (const r of checkedTextRanges(node, doc, checkboxStart + 3)) {
        builder.add(r.from, r.to, checkedTextMark);
      }
    }
    return;
  }

  // A fixed-width marker column, applied whether or not the marker is revealed
  // and whatever the marker is, so every item of a list starts its text in the
  // same place — `9.` and `10.` included.
  const columns = listMarkColumns(node, doc);
  builder.add(listMark.from, listMark.to, markBoxes[columns]);

  // Bullet markers: only replace when cursor is NOT in range
  if (shouldReveal(view, 'listBullet', node.from, node.to)) return;

  const markText = doc.sliceString(listMark.from, listMark.to);
  if (markText === '-' || markText === '*' || markText === '+') {
    builder.add(
      listMark.from,
      listMark.to,
      Decoration.replace({ widget: new BulletWidget(columns) })
    );
  }
}

/** True when `node` sits inside a blockquote, at any distance. */
export function insideBlockquote(node: SyntaxNode): boolean {
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'Blockquote') return true;
  }
  return false;
}

// Levels past this share the deepest step rather than marching off the edge.
const MAX_QUOTE_DEPTH = 4;

const quoteLines: readonly Decoration[] = Array.from(
  { length: MAX_QUOTE_DEPTH + 1 },
  (_, depth) => Decoration.line({ class: `cm-md-blockquote cm-md-blockquote-d${depth}` })
);

/** What an outermost blockquote draws: a depth per line, and the markers to hide. */
export interface BlockquoteLayout {
  /** Every line of the quote: its start, and the depth of the innermost quote on it. */
  lines: { from: number; depth: number }[];
  /**
   * The markers to hide — each a `>` plus the one space or tab after it.
   * Markers that touch are merged, so `> > x` is one range and not two: in
   * live-render a boundary between them would be an atomic stop printing at
   * the same pixel as its neighbours, and typing there splits the quote.
   */
  hidden: { from: number; to: number }[];
}

/**
 * One marker's hidden range: the `>`, the single space or tab after it, and —
 * when only indentation precedes it on its line and `hideIndent` — that
 * indentation too, as the old per-line `^\s*>\s?` did.
 *
 * `hideIndent` is false for a quote inside a list item: there the indentation
 * is the item's continuation indent, and hiding it put the second line's text
 * at the line edge while the first line's sat after the bullet.
 */
function quoteMarkHiddenRange(
  doc: Text,
  from: number,
  to: number,
  hideIndent: boolean
): { from: number; to: number } {
  const line = doc.lineAt(from);
  const next = doc.sliceString(to, Math.min(to + 1, line.to));
  const end = next === ' ' || next === '\t' ? to + 1 : to;
  const start =
    hideIndent && /^[ \t]*$/.test(doc.sliceString(line.from, from)) ? line.from : from;
  return { from: start, to: end };
}

function insideListItem(node: SyntaxNode): boolean {
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'ListItem') return true;
  }
  return false;
}

/**
 * Walks an outermost `Blockquote`'s whole subtree for its nested quotes and
 * every `QuoteMark`. The subtree, not the direct children: Lezer puts the
 * marker of a continuation line inside whatever block is open on it — a
 * paragraph, a list item, a fenced code block, a table — so a marker can sit
 * several levels below the quote it belongs to.
 *
 * `live-render/atomic.ts` hides exactly these ranges; computing them in one
 * place is what keeps the rendered text and the atomic set in step.
 */
export function blockquoteLayout(doc: Text, quote: SyntaxNode): BlockquoteLayout {
  const firstLine = doc.lineAt(quote.from).number;
  const depths = new Array<number>(doc.lineAt(quote.to).number - firstLine + 1).fill(1);
  const marks: { from: number; to: number }[] = [];
  const hideIndent = !insideListItem(quote);

  let depth = 0;
  quote.cursor().iterate(
    (node) => {
      if (node.name === 'QuoteMark') {
        marks.push(quoteMarkHiddenRange(doc, node.from, node.to, hideIndent));
        return;
      }
      if (node.name !== 'Blockquote') return;
      depth++;
      const d = Math.min(depth, MAX_QUOTE_DEPTH);
      const last = doc.lineAt(node.to).number - firstLine;
      for (let i = doc.lineAt(node.from).number - firstLine; i <= last; i++) {
        depths[i] = Math.max(depths[i], d);
      }
    },
    (node) => {
      if (node.name === 'Blockquote') depth--;
    }
  );

  marks.sort((a, b) => a.from - b.from);
  const hidden: { from: number; to: number }[] = [];
  for (const m of marks) {
    const prev = hidden[hidden.length - 1];
    if (prev && m.from <= prev.to) prev.to = Math.max(prev.to, m.to);
    else hidden.push({ from: m.from, to: m.to });
  }
  const lines = depths.map((d, i) => ({ from: doc.line(firstLine + i).from, depth: d }));
  return { lines, hidden };
}

/**
 * Quotes are decorated once, from the outermost one; a nested quote's lines
 * and markers are part of that layout. `plugin.ts` still descends into every
 * quote, so what is inside — inline formatting, lists, headings — is decorated
 * by its own decorator.
 *
 * The line decoration is emitted whether or not the markers are revealed, so
 * the caret entering a quote shows its `>` without taking the bar away. Reveal
 * is decided by the outermost quote: the caret on any of its lines shows every
 * marker in it at every level, as live-preview did when the whole block went
 * raw under the caret.
 */
export function decorateBlockquote(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (insideBlockquote(node)) return;

  const layout = blockquoteLayout(view.state.doc, node);
  for (const line of layout.lines) builder.add(line.from, line.from, quoteLines[line.depth]);

  if (shouldReveal(view, 'blockquote', node.from, node.to, true)) return;
  for (const r of layout.hidden) builder.add(r.from, r.to, Decoration.replace({}));
}
