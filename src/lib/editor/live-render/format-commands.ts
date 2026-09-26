import { EditorSelection, EditorState } from '@codemirror/state';
import type { SelectionRange, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { markdownExtension } from '../markdown-language';
import { openInspectorFor } from './effects';

/**
 * Node-aware replacements for the text-heuristic `toggleWrap` in
 * `keybindings.ts`. That function only peeks at `startsWith`/`endsWith` on
 * the selected string and the characters just outside it — good enough for
 * a keybinding on unformatted text, but it has no idea whether the
 * selection sits inside an `Emphasis` vs. `StrongEmphasis` node, so it
 * misbehaves on nested formatting (`**a _b_ c**`). The selection toolbar
 * needs to know that structure both to decide what to do and to show which
 * button is "on", so these commands consult `syntaxTree` instead.
 *
 * `toggleWrap` itself is untouched — live-preview's Cmd+B/I/X keybindings
 * still use it and must keep behaving exactly as before.
 */

export type InlineFormatKind = 'strong' | 'emphasis' | 'strikethrough' | 'inlineCode';

const NODE_NAME: Record<InlineFormatKind, string> = {
  strong: 'StrongEmphasis',
  emphasis: 'Emphasis',
  strikethrough: 'Strikethrough',
  inlineCode: 'InlineCode',
};

// Lezer tags both Emphasis and StrongEmphasis markers as `EmphasisMark`
// (the difference is the mark's text length: `*`/`_` vs `**`/`__`) — see
// preview/inline.ts, which relies on the same node name for both.
const MARK_NAME: Record<InlineFormatKind, string> = {
  strong: 'EmphasisMark',
  emphasis: 'EmphasisMark',
  strikethrough: 'StrikethroughMark',
  inlineCode: 'CodeMark',
};

/**
 * Emphasis is `*`, not `_`, for two reasons. CommonMark's flanking rules stop
 * `_` from opening or closing emphasis inside a word, so wrapping a partial
 * word produced no `Emphasis` node at all — the unwrap path then found nothing
 * to remove and every further click wrapped again, piling up underscores
 * (`_x_`, then `__x__`, which is strong, not emphasis). It also keeps the
 * toolbar and the Cmd+I binding in `keybindings.ts` emitting the same markup.
 */
const MARKER_TEXT: Record<InlineFormatKind, string> = {
  strong: '**',
  emphasis: '*',
  strikethrough: '~~',
  inlineCode: '`',
};

/**
 * Walk up from the innermost node at `from` looking for a node of
 * `targetName` that fully covers `[from, to]`. Returns `null` if the
 * selection is not entirely contained in a single node of that kind.
 *
 * This is the "remove" decision point and nothing more. A selection that only
 * partially overlaps a node of the target kind (it starts inside `**bold**`
 * and ends past it) finds no enclosing node here and takes the "add" path —
 * which does **not** wrap the raw selected source, markers and all. That used
 * to produce crossing markup (`**a *b** c*`), and in live-render the repair
 * filter read the new pair as tearing the old one and wrote a stray `**` back.
 * `addFormat` instead merges the selection with overlapping nodes of the same
 * kind and splits it at every other span it crosses — see `planWrap`.
 */
function findEnclosingNode(tree: Tree, targetName: string, from: number, to: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(from, 1);
  while (node) {
    if (node.name === targetName && node.from <= from && node.to >= to) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/** Whether `[from, to]` sits entirely inside an existing node of `kind`. */
export function isInlineFormatActive(
  state: EditorState,
  kind: InlineFormatKind,
  from: number,
  to: number
): boolean {
  return findEnclosingNode(syntaxTree(state), NODE_NAME[kind], from, to) !== null;
}

/** Whether `[from, to]` sits entirely inside an existing `Link` node. */
export function isLinkActive(state: EditorState, from: number, to: number): boolean {
  return findEnclosingNode(syntaxTree(state), 'Link', from, to) !== null;
}

interface RangeChange {
  changes: { from: number; to: number; insert: string }[];
  range: SelectionRange;
}

/**
 * Wrap `range` in `marker`, trimming leading/trailing whitespace out of the
 * wrap so `"a "` becomes `"**a** "` rather than `"**a **"` (CommonMark
 * doesn't parse emphasis with the space adjacent to the inner side of the
 * marker). The same visible (non-whitespace) text stays selected afterwards.
 *
 * Only for a selection that crosses no other markup — `addFormat` decides.
 */
function wrapPlain(state: EditorState, marker: string, range: SelectionRange): RangeChange {
  const raw = state.sliceDoc(range.from, range.to);
  const leading = raw.match(/^\s*/)?.[0] ?? '';
  const trailing = raw.match(/\s*$/)?.[0] ?? '';
  const innerStart = leading.length;
  const innerEnd = raw.length - trailing.length;

  if (innerStart >= innerEnd) {
    // Whitespace-only or empty selection — nothing to trim around. Wrap as
    // given and select the two markers so typing continues right away.
    return {
      changes: [{ from: range.from, to: range.to, insert: `${marker}${raw}${marker}` }],
      range: EditorSelection.range(range.from + marker.length, range.from + marker.length + raw.length),
    };
  }

  const inner = raw.slice(innerStart, innerEnd);
  const insert = `${leading}${marker}${inner}${marker}${trailing}`;
  const selFrom = range.from + leading.length + marker.length;
  return {
    changes: [{ from: range.from, to: range.to, insert }],
    range: EditorSelection.range(selFrom, selFrom + inner.length),
  };
}

interface Span {
  from: number;
  to: number;
}

/** Inline spans a new pair of markers must nest with, never cross. */
const PAIRED_NODES = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Link', 'Image']);

/**
 * Nodes whose content is literal: no marker may be placed inside them, so a
 * wrap boundary that falls inside one snaps outward to the whole node.
 */
const ATOMIC_NODES = new Set(['InlineCode', 'Autolink']);

/**
 * The hidden markup of a node, as the pieces a new marker may not sit inside
 * or straddle: the opening and closing mark of an emphasis-like span, and for
 * a link or image the opening `[` / `![` and everything from `]` to the end —
 * `](url)` is hidden as one span, so it is one obstacle.
 *
 * Links count whether or not they render. Lezer resolves bracket pairs before
 * emphasis, so `*a [b* c]` yields no `Emphasis` at all — measured — even though
 * `[b* c]` is not a link and its brackets stay visible.
 */
function markupPieces(node: SyntaxNode): Span[] {
  if (node.name === 'Link' || node.name === 'Image') {
    const marks = node.getChildren('LinkMark');
    const open = marks.find((m) => m.from === node.from);
    const close = marks.find((m) => m.from > node.from);
    if (!open || !close) return [];
    return [
      { from: open.from, to: open.to },
      { from: close.from, to: node.to },
    ];
  }
  const markName = node.name === 'Strikethrough' ? 'StrikethroughMark' : node.name === 'InlineCode' ? 'CodeMark' : 'EmphasisMark';
  const marks = node.getChildren(markName);
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (!open || !close || open === close || open.from !== node.from || close.to !== node.to) return [];
  return [
    { from: open.from, to: open.to },
    { from: close.from, to: close.to },
  ];
}

interface WrapPlan {
  /** The extent being formatted, after snapping and merging. */
  from: number;
  to: number;
  /** Hidden markup of spans that cross `[from, to]`, clipped to it, sorted. */
  obstacles: Span[];
  /** Outermost nodes of the kind being applied, absorbed into the wrap. */
  merged: SyntaxNode[];
  /** Markers of every absorbed node (nested ones included) — deleted. */
  deleted: Span[];
}

/**
 * Work out how to wrap `[from, to]` in `kind` without producing crossing
 * markup, or `null` when the selection touches no other markup and the plain
 * wrap applies unchanged.
 *
 * Three rules, in this order:
 *
 * 1. **Literal nodes are atomic.** An edge strictly inside inline code (or an
 *    autolink) moves out to the node's edge — a marker in there is just text.
 * 2. **Same kind merges.** Nodes of `kind` that intersect the range extend it to
 *    their union, and their markers are dropped: the new pair covers them.
 * 3. **Other spans split.** A span of another kind that *crosses* the range —
 *    one of its markers inside, the other outside — contributes its hidden
 *    markup inside the range as an obstacle, and the wrap is emitted per
 *    segment between obstacles. A span wholly inside the range is already
 *    well-nested in the new pair and is left alone.
 */
function planWrap(tree: Tree, kind: InlineFormatKind, rangeFrom: number, rangeTo: number): WrapPlan | null {
  const targetName = NODE_NAME[kind];
  const inline: SyntaxNode[] = [];
  const atomic: SyntaxNode[] = [];

  tree.iterate({
    from: rangeFrom,
    to: rangeTo,
    enter(ref) {
      if (PAIRED_NODES.has(ref.name)) inline.push(ref.node);
      if (!ATOMIC_NODES.has(ref.name)) return undefined;
      atomic.push(ref.node);
      return false; // nothing inside a literal node is markup
    },
  });

  let from = rangeFrom;
  let to = rangeTo;

  for (const node of atomic) {
    if (node.name === targetName) continue; // inline code over inline code merges below
    if (node.from < from && from < node.to) from = node.from;
    if (node.from < to && to < node.to) to = node.to;
  }

  // Merge with every node of this kind that intersects, to a fixpoint, so the
  // range settles on the full union whatever order the nodes arrive in.
  const same = inline.filter((n) => n.name === targetName);
  const absorbed = new Set<SyntaxNode>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of same) {
      if (absorbed.has(node) || !(node.from < to && node.to > from)) continue;
      absorbed.add(node);
      if (node.from < from || node.to > to) grew = true;
      from = Math.min(from, node.from);
      to = Math.max(to, node.to);
    }
  }

  const obstacles: Span[] = [];
  for (const node of inline) {
    if (node.name === targetName || ATOMIC_NODES.has(node.name)) continue;
    const intersects = node.from < to && node.to > from;
    const inside = node.from >= from && node.to <= to;
    const encloses = node.from <= from && node.to >= to;
    if (!intersects || inside || encloses) continue;
    for (const piece of markupPieces(node)) {
      const a = Math.max(piece.from, from);
      const b = Math.min(piece.to, to);
      if (b > a) obstacles.push({ from: a, to: b });
    }
  }

  if (obstacles.length === 0 && absorbed.size === 0 && from === rangeFrom && to === rangeTo) return null;

  const all = [...absorbed];
  const merged = all.filter((n) => !all.some((o) => o !== n && o.from <= n.from && o.to >= n.to));
  const deleted = all.flatMap(markupPieces);
  obstacles.sort((a, b) => a.from - b.from);
  deleted.sort((a, b) => a.from - b.from);
  return { from, to, obstacles, merged, deleted };
}

interface Insertion {
  pos: number;
  text: string;
}

/**
 * Apply `kind` to `range` so that the result is well-nested markdown.
 *
 * A selection that crosses no markup is the plain wrap (`wrapPlain`). One that
 * does is planned by `planWrap` and emitted as follows:
 *
 * - each segment between obstacles gets its own pair, trimmed of whitespace
 *   exactly like the plain wrap (a marker against inner whitespace does not
 *   parse); a segment with nothing visible in it gets none;
 * - new markers that fall outside an absorbed node are **pure insertions**, which
 *   `markup-repair.ts` never touches (`repairChange` returns early for them);
 * - each absorbed node is rewritten by **one** change spanning it from marker to
 *   marker. The repair filter judges each change on its own, so deleting the
 *   two markers as two changes would read as two torn pairs and both would be
 *   written back; one change touching both reads as removal as a unit.
 *
 * The selection afterwards covers the same visible text: it starts after a
 * marker inserted at its start and ends before one inserted at its end.
 */
function addFormat(state: EditorState, tree: Tree, kind: InlineFormatKind, range: SelectionRange): RangeChange {
  const marker = MARKER_TEXT[kind];
  if (range.empty) return wrapPlain(state, marker, range);
  const plan = planWrap(tree, kind, range.from, range.to);
  if (!plan) return wrapPlain(state, marker, range);

  const isDeleted = (pos: number): boolean => plan.deleted.some((d) => pos >= d.from && pos < d.to);
  const isVisible = (pos: number): boolean => !isDeleted(pos) && !/\s/.test(state.sliceDoc(pos, pos + 1));

  const segments: Span[] = [];
  let cursor = plan.from;
  for (const obstacle of plan.obstacles) {
    if (obstacle.from > cursor) segments.push({ from: cursor, to: obstacle.from });
    cursor = Math.max(cursor, obstacle.to);
  }
  if (cursor < plan.to) segments.push({ from: cursor, to: plan.to });

  const insertions: Insertion[] = [];
  let visibleFrom = -1;
  let visibleTo = -1;
  for (const segment of segments) {
    let start = segment.from;
    while (start < segment.to && !isVisible(start)) start++;
    let end = segment.to;
    while (end > start && !isVisible(end - 1)) end--;
    if (start >= end) continue; // whitespace (or absorbed markers) only
    insertions.push({ pos: start, text: marker }, { pos: end, text: marker });
    if (visibleFrom < 0) visibleFrom = start;
    visibleTo = end;
  }
  if (insertions.length === 0) return { changes: [], range };

  const changes: { from: number; to: number; insert: string }[] = [];
  const used = new Set<Insertion>();
  for (const node of plan.merged) {
    let insert = '';
    for (let pos = node.from; pos <= node.to; pos++) {
      for (const ins of insertions) {
        if (ins.pos === pos && !used.has(ins)) {
          insert += ins.text;
          used.add(ins);
        }
      }
      if (pos < node.to && !isDeleted(pos)) insert += state.sliceDoc(pos, pos + 1);
    }
    changes.push({ from: node.from, to: node.to, insert });
  }
  for (const ins of insertions) {
    if (!used.has(ins)) changes.push({ from: ins.pos, to: ins.pos, insert: ins.text });
  }
  changes.sort((a, b) => a.from - b.from);

  // Positions are mapped by hand rather than through a ChangeSet: a position
  // inside a rewritten node would otherwise map to one end of the rewrite.
  const mapPos = (pos: number, assoc: -1 | 1): number => {
    let out = pos;
    for (const ins of insertions) {
      if (ins.pos < pos || (ins.pos === pos && assoc > 0)) out += ins.text.length;
    }
    for (const d of plan.deleted) out -= Math.max(0, Math.min(d.to, pos) - d.from);
    return out;
  };
  const clamp = (pos: number): number => Math.max(visibleFrom, Math.min(pos, visibleTo));
  const selFrom = mapPos(clamp(range.from), 1);
  const selTo = Math.max(selFrom, mapPos(clamp(range.to), -1));

  return { changes, range: EditorSelection.range(selFrom, selTo) };
}

/**
 * Remove the enclosing node's marker children (not a string slice — the
 * marks may be one or two characters wide) and keep the same visible text
 * selected, clamped to what survives if the selection reached into a marker.
 */
function removeFormat(node: SyntaxNode, markName: string, range: SelectionRange): RangeChange {
  const marks = node.getChildren(markName);
  const openMark = marks.find((m) => m.from === node.from);
  const closeMark = marks.find((m) => m.to === node.to && m !== openMark);

  if (!openMark || !closeMark) {
    // Unexpected structure (shouldn't happen for well-formed marks) — leave
    // the document untouched rather than guess.
    return { changes: [], range };
  }

  const openLen = openMark.to - openMark.from;
  const innerFrom = openMark.to;
  const innerTo = closeMark.from;

  const clamp = (pos: number): number => Math.max(innerFrom, Math.min(pos, innerTo));
  const newFrom = clamp(range.from) - openLen;
  const newTo = clamp(range.to) - openLen;

  return {
    changes: [
      { from: openMark.from, to: openMark.to, insert: '' },
      { from: closeMark.from, to: closeMark.to, insert: '' },
    ],
    range: EditorSelection.range(newFrom, newTo),
  };
}

/**
 * The toggle itself, as a transaction spec over whatever state it is handed.
 *
 * This is the single implementation every caller below funnels through — the
 * live view, the explicit-range widget path, and the throwaway state used for
 * a table cell's edit overlay (#60). The overlay is the reason this got its own
 * function: its text is not in the document yet, so a second string-wrapping
 * "bold" was the obvious shortcut, and two bolds would disagree the first time
 * one was asked about nested markup.
 */
function formatSpec(state: EditorState, kind: InlineFormatKind, tree: Tree): TransactionSpec {
  const targetName = NODE_NAME[kind];
  const markName = MARK_NAME[kind];

  return state.changeByRange((range) => {
    const enclosing = findEnclosingNode(tree, targetName, range.from, range.to);
    return enclosing ? removeFormat(enclosing, markName, range) : addFormat(state, tree, kind, range);
  });
}

/**
 * Toggle bold / italic / strikethrough / inline code on the current
 * selection(s), consulting the syntax tree rather than sniffing the raw
 * string. Multi-range selections are handled range-by-range, same as
 * `toggleWrap`.
 */
export function toggleInlineFormat(view: EditorView, kind: InlineFormatKind): boolean {
  view.dispatch(formatSpec(view.state, kind, syntaxTree(view.state)));
  return true;
}

/**
 * A state holding `text` with `[from, to]` selected, parsed as markdown exactly
 * the way the editor parses it (`markdownExtension`, shared with `setup.ts`).
 *
 * `ensureSyntaxTree` rather than `syntaxTree`: a freshly created state has only
 * whatever the initial budgeted parse managed, and reading the lazy tree of an
 * unparsed state answers `Tree.empty` — on which `findEnclosingNode` finds
 * nothing and every toggle would take the "add" path, so bold could be turned
 * on and never off. Cell text is a few dozen characters, so the parse is
 * immediate; the fallback exists only so a pathological input degrades to
 * "wraps instead of unwraps" rather than throwing.
 */
function scratchState(text: string, from: number, to: number): EditorState {
  return EditorState.create({
    doc: text,
    selection: EditorSelection.single(from, to),
    extensions: [markdownExtension()],
  });
}

function scratchTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
}

/** Result of a toggle applied to loose text: the new text and the same words, reselected. */
export interface TextFormatResult {
  text: string;
  from: number;
  to: number;
}

/**
 * Toggle a format over `[from, to]` of a plain string, returning the new string
 * and where the selection lands in it.
 *
 * The carrier for the table cell edit overlay, whose `value` is cell *source*
 * that the document does not hold yet. Nothing here re-decides what bold means:
 * it builds a state, runs `formatSpec`, and reads the result back out.
 */
export function toggleInlineFormatInText(
  text: string,
  kind: InlineFormatKind,
  from: number,
  to: number
): TextFormatResult | null {
  if (to <= from) return null;
  const state = scratchState(text, from, to);
  const next = state.update(formatSpec(state, kind, scratchTree(state))).state;
  if (next.doc.toString() === text) return null;
  const range = next.selection.main;
  return { text: next.doc.toString(), from: range.from, to: range.to };
}

/** `isInlineFormatActive` for text that is not in the document — see above. */
export function isInlineFormatActiveInText(
  text: string,
  kind: InlineFormatKind,
  from: number,
  to: number
): boolean {
  if (to <= from) return false;
  const state = scratchState(text, from, to);
  return findEnclosingNode(scratchTree(state), NODE_NAME[kind], from, to) !== null;
}

/**
 * Toggle a format over an explicit document range, leaving the selection alone.
 *
 * Text drawn by a widget — a table row — produces no document selection at all:
 * the widget returns `true` from `ignoreEvent`, so CM6 never sees the drag and
 * `state.selection` keeps whatever it held before. `changeByRange` therefore
 * has nothing to act on, which is why the toolbar over a cell could offer only
 * a comment button until now (#42, #55). `cell-anchor.ts` has already mapped
 * the rendered characters back to a range in the source; this applies the very
 * same add/remove decision to it, so a cell and a paragraph cannot disagree
 * about what bold means.
 *
 * No selection travels with the transaction. The row's widget is rebuilt by the
 * change (`eq()` compares every cell position), taking the DOM selection with
 * it, and a document caret dropped into the middle of a table row would be a
 * caret the user cannot see.
 */
export function toggleInlineFormatAt(
  view: EditorView,
  kind: InlineFormatKind,
  from: number,
  to: number
): boolean {
  const { state } = view;
  const tree = syntaxTree(state);
  const enclosing = findEnclosingNode(tree, NODE_NAME[kind], from, to);
  const range = EditorSelection.range(from, to);
  const { changes } = enclosing
    ? removeFormat(enclosing, MARK_NAME[kind], range)
    : addFormat(state, tree, kind, range);

  if (changes.length === 0) return false;
  view.dispatch({ changes });
  return true;
}

/**
 * Wrap the selection as `[text]()`, caret left inside the empty `()`, and
 * fire `openInspectorFor` (see `effects.ts`) so a later phase can pop open
 * the URL editor immediately. This is a one-way wrap, not a toggle — an
 * already-linked selection just gets a second, nested link; editing or
 * removing an existing link is the inspector's job (phase 7), not this
 * command's.
 */
export function toggleLink(view: EditorView): boolean {
  const { state } = view;

  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    // '[' + text + '](' puts the caret right before the closing ')'.
    const caretPos = range.from + text.length + 3;
    return {
      changes: [{ from: range.from, to: range.to, insert }],
      range: EditorSelection.cursor(caretPos),
      effects: openInspectorFor.of({ pos: range.from }),
    };
  });

  view.dispatch(tr);
  return true;
}
