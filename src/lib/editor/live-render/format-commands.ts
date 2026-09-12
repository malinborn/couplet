import { EditorSelection } from '@codemirror/state';
import type { EditorState, SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
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
 * This is the "partial overlap" decision point: a selection that only
 * partially overlaps a node of the target kind (e.g. it starts inside
 * `**bold**` and ends past it) will not find an enclosing node here and
 * therefore takes the "add" path in `toggleInlineFormat`, wrapping the
 * exact selected text — markers and all — with a fresh pair of markers.
 * That can nest awkwardly with whatever partial markup was selected, but
 * it is simple and deterministic, and matches the existing `toggleWrap`
 * heuristic's philosophy of "operate on what's selected, don't try to
 * repair surrounding markup".
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
 */
function addFormat(state: EditorState, marker: string, range: SelectionRange): RangeChange {
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
 * Toggle bold / italic / strikethrough / inline code on the current
 * selection(s), consulting the syntax tree rather than sniffing the raw
 * string. Multi-range selections are handled range-by-range, same as
 * `toggleWrap`.
 */
export function toggleInlineFormat(view: EditorView, kind: InlineFormatKind): boolean {
  const { state } = view;
  const tree = syntaxTree(state);
  const targetName = NODE_NAME[kind];
  const markName = MARK_NAME[kind];
  const marker = MARKER_TEXT[kind];

  const tr = state.changeByRange((range) => {
    const enclosing = findEnclosingNode(tree, targetName, range.from, range.to);
    return enclosing ? removeFormat(enclosing, markName, range) : addFormat(state, marker, range);
  });

  view.dispatch(tr);
  return true;
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
  const enclosing = findEnclosingNode(syntaxTree(state), NODE_NAME[kind], from, to);
  const range = EditorSelection.range(from, to);
  const { changes } = enclosing
    ? removeFormat(enclosing, MARK_NAME[kind], range)
    : addFormat(state, MARKER_TEXT[kind], range);

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
