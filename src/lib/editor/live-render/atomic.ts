import { EditorView } from '@codemirror/view';
import {
  EditorSelection,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateField,
  Transaction,
  type Extension,
  type Text,
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { isRenderedLink } from '../preview/link-refs';

/**
 * Lezer node names whose ranges are hidden under the live-render flavour
 * (see preview/flavour.ts — every element kind but mermaid has policy
 * 'never' there, so nothing is ever revealed on cursor).
 *
 * This list is informational / for tests. The actual hidden *ranges* are
 * NOT "every node with one of these names" — several sites hide more (or
 * less) than the bare node range, and some nodes with these names are
 * never hidden at all depending on context (an ordered-list `ListMark`,
 * a `LinkMark` that belongs to a checkbox look-alike, a `QuoteMark` on a
 * nested blockquote). `hiddenMarkRanges` below mirrors `preview/plugin.ts`'s
 * actual traversal and each decorator's actual algorithm node-by-node —
 * see the inline comments and the accompanying report for the specific
 * traps found while building this.
 */
export const HIDDEN_MARK_NODES = [
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'QuoteMark',
  'ListMark',
  'LinkMark',
] as const;

/**
 * A hidden marker range, tagged with which edge a strictly-interior caret
 * should be pushed to on an exact tie between the two edges (only possible
 * for 2+ character markers, e.g. `**`, `~~`, or a link's combined closing
 * span): `'from'` for a marker that opens a formatted span (push out to
 * *before* it — outside the whole span), `'to'` for one that closes it
 * (push out to *after* it). CM6's own `atomicRanges` consumer ignores this
 * value entirely (ties break toward `to` unconditionally there); it exists
 * only for `caretNormalizeFilter`'s "one canonical position" rule.
 */
export class HiddenMarkSpan extends RangeValue {
  constructor(readonly tieEdge: 'from' | 'to') {
    super();
  }
  eq(other: HiddenMarkSpan): boolean {
    return this.tieEdge === other.tieEdge;
  }
}

interface RawSpan {
  from: number;
  to: number;
  tieEdge: 'from' | 'to';
}

function push(spans: RawSpan[], from: number, to: number, tieEdge: 'from' | 'to'): void {
  if (to > from) spans.push({ from, to, tieEdge });
}

/**
 * Mirrors `lists.ts`'s checkbox detection exactly — same 5-char window,
 * same regex, same case-sensitivity (lowercase `x` only; `[X]` does NOT
 * match, matching `lists.ts:61` precisely even though it means uppercase
 * checkboxes get no special treatment there either). Used both to decide
 * whether a `ListMark` is swallowed by the checkbox widget, and to detect
 * the checkbox-look-alike `Link` case (see `isChecklistLookalikeLink`).
 */
const CHECKBOX_AFTER_RE = /^\s\[([x ])\]/;

function isChecklistLine(doc: Text, listMark: SyntaxNode): boolean {
  const after = doc.sliceString(listMark.to, Math.min(listMark.to + 5, doc.length));
  return CHECKBOX_AFTER_RE.test(after);
}

/**
 * True when `link` is the `- [x](url)`-shaped mis-parse described in the
 * report: GFM's TaskList block parser only fires when `[x]`/`[ ]` is
 * followed by whitespace (`@lezer/markdown`'s `TaskList.parseBlock`,
 * `/^\[[ xX]\][ \t]/`); followed by anything else (e.g. `(`), the *same*
 * text instead parses as a normal inline `Link` with the checkbox letter
 * as its label. `lists.ts`'s checkbox regex is purely textual, so it still
 * renders the `CheckboxWidget` over `[listMark.from, checkboxEnd)` in this
 * case too — meaning this Link's marks must NOT be added as separate
 * hidden spans, or they'd fall inside (LinkMark spans) or straddle
 * (the URL) a region a widget already fully owns.
 */
function isChecklistLookalikeLink(doc: Text, link: SyntaxNode): boolean {
  const paragraph = link.parent;
  const listItem = paragraph?.parent;
  if (!listItem || listItem.name !== 'ListItem') return false;
  const listMark = listItem.getChild('ListMark');
  if (!listMark) return false;
  // Must be the paragraph's very first content, immediately after
  // "mark + exactly one space" — same position lists.ts's afterMark reads.
  if (link.from !== listMark.to + 1) return false;
  return isChecklistLine(doc, listMark);
}

/**
 * Walks the syntax tree exactly the way `preview/plugin.ts`'s
 * `buildDecorations` does — same switch, same descend/`return false`
 * decisions — and for every node it actually decorates with a
 * hide-the-marker `Decoration.replace`, records that *decorator's* real
 * hidden range (not the bare node range, where they differ).
 *
 * Mirroring the traversal (not just grepping the tree for node names) is
 * load-bearing: `plugin.ts` stops descending at `Emphasis`, `StrongEmphasis`,
 * `Strikethrough`, `InlineCode`, `Link`, `FencedCode`, `Table`, and
 * `Blockquote`, so content nested inside any of those is never
 * independently decorated today (see the report — this affects nested
 * inline formatting and anything inside a blockquote or table cell).
 * Atomic ranges must agree with that, or the caret would be blocked from
 * entering text that is, in fact, rendered as plain visible characters.
 */
function collectHiddenSpans(state: EditorState): RawSpan[] {
  const doc = state.doc;
  const spans: RawSpan[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          // Mirror headings.ts:30-33 — hides HeaderMark through ONE
          // trailing space, clamped to the node. No closing counterpart,
          // so a tie pushes 'from' (out before the "#").
          const mark = node.node.getChild('HeaderMark');
          if (mark) {
            const hideEnd = Math.min(mark.to + 1, node.to);
            push(spans, mark.from, hideEnd, 'from');
          }
          break; // descend — inline children inside the heading are
          // visited too, same as plugin.ts.
        }
        case 'Emphasis':
        case 'StrongEmphasis': {
          // Mirror inline.ts decorateEmphasis/decorateStrongEmphasis: every
          // EmphasisMark child is hidden individually, no combining.
          for (const mark of node.node.getChildren('EmphasisMark')) {
            push(spans, mark.from, mark.to, mark.from === node.from ? 'from' : 'to');
          }
          break; // descend — plugin.ts does too, so the inner markers of a
          // nested span like ***both*** are hidden and must be atomic as well.
          // Getting this wrong in either direction is the bug to avoid: the
          // atomic set and the rendered text have to agree.
        }
        case 'Strikethrough': {
          for (const mark of node.node.getChildren('StrikethroughMark')) {
            push(spans, mark.from, mark.to, mark.from === node.from ? 'from' : 'to');
          }
          break; // descend, same reason
        }
        case 'InlineCode': {
          for (const mark of node.node.getChildren('CodeMark')) {
            push(spans, mark.from, mark.to, mark.from === node.from ? 'from' : 'to');
          }
          return false;
        }
        case 'Link': {
          // A `Link` node that is not a link decorates nothing (#51), so
          // nothing of it is hidden and none of it may be atomic. plugin.ts
          // descends in that case; so does this, which is what `break` does.
          if (!isRenderedLink(doc, node.node)) break;
          // Mirror inline.ts decorateLink exactly: the opening `[` is
          // hidden alone; everything from the closing `]` through the end
          // of the node (`](url)`) is hidden as ONE combined span — not
          // per-LinkMark. That combined span also swallows the URL text,
          // which is why point-resolution against bare LinkMark ranges
          // alone would miss a caret landing inside the URL (see report).
          if (!isChecklistLookalikeLink(doc, node.node)) {
            const linkMarks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            const openMark = linkMarks.find((m) => m.from === node.from);
            const closeBracket = url
              ? linkMarks.find((m) => m.to <= url.from && m.from > node.from)
              : linkMarks.find((m) => m.from > node.from);
            if (openMark) push(spans, openMark.from, openMark.to, 'from');
            if (closeBracket) push(spans, closeBracket.from, node.to, 'to');
          }
          return false;
        }
        case 'FencedCode':
        case 'Table':
          // Both are always-rendered widgets over the whole block.
          // FencedCode's fence lines are hidden via a `Decoration.line`
          // CSS class (blocks.ts), not a character-level replace — the
          // fence text is still real, un-replaced content, just on a
          // zero-height line, so it must NOT be atomic. Table lines are
          // either widget-replaced (header) or hidden the same line-level
          // way; caret recovery there is `table-selection.ts`'s job, not
          // this module's. Neither contributes character-level hidden
          // spans, so just don't descend (inline markup inside a fence or
          // a table cell is never independently decorated either — same
          // "mirror the traversal" reasoning as Blockquote below).
          return false;
        case 'ListItem': {
          // Mirror lists.ts decorateListItem's actual branch order: the
          // checkbox check runs FIRST and is unconditional on bullet vs.
          // ordered marker (so "1. [x] done" is a checkbox too), then only
          // '-'/'*'/'+' bullets get hidden. Ordered markers ("1.") are
          // never hidden — out of v1 scope (plan: "Вне v1").
          const listMark = node.node.getChild('ListMark');
          if (listMark && !isChecklistLine(doc, listMark)) {
            const markText = doc.sliceString(listMark.from, listMark.to);
            if (markText === '-' || markText === '*' || markText === '+') {
              push(spans, listMark.from, listMark.to, 'from');
            }
          }
          break; // descend, same as plugin.ts (nested lists' ListItems are
          // visited too).
        }
        case 'Blockquote': {
          // Mirror lists.ts decorateBlockquote's per-line regex exactly:
          // ONE combined match per line, hiding the OUTERMOST leading `>`
          // (+ one optional trailing space). plugin.ts returns false here
          // too, so a NESTED Blockquote's own QuoteMark is never
          // independently visited/decorated — it stays visible. Mirrored,
          // not fixed; see report.
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(node.to);
          for (let i = startLine.number; i <= endLine.number; i++) {
            const line = doc.line(i);
            const match = /^(\s*>)\s?/.exec(line.text);
            if (match) push(spans, line.from, line.from + match[0].length, 'from');
          }
          return false;
        }
      }
      return undefined;
    },
  });

  return spans;
}

/**
 * The hidden-marker ranges for the current document, mirroring exactly
 * what live-render's decorators hide (see `collectHiddenSpans`). Walks the
 * *whole* tree, not the viewport — a viewport-limited set would silently
 * stop being atomic for markers the caret moves onto after they scroll out
 * of view, per `preview/plugin.ts:27`'s existing full-tree precedent.
 */
export function hiddenMarkRanges(state: EditorState): RangeSet<HiddenMarkSpan> {
  const spans = collectHiddenSpans(state).sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<HiddenMarkSpan>();
  for (const span of spans) {
    builder.add(span.from, span.to, new HiddenMarkSpan(span.tieEdge));
  }
  return builder.finish();
}

/**
 * Caches `hiddenMarkRanges` per document/tree so `liveRenderAtomicRanges`
 * doesn't re-walk the whole syntax tree on every single cursor-motion
 * query — `EditorView.atomicRanges`'s provider function runs on every
 * `moveByChar`/`moveVertically`/mouse-selection call, so an uncached full
 * tree walk there would be an O(document size) cost per keypress. Recompute
 * is keyed on tree identity rather than `docChanged` so it also catches a
 * background/incremental reparse finishing without an accompanying edit —
 * the same signal `preview/plugin.ts`'s ViewPlugin uses for `treeChanged`.
 *
 * Reading `tr.state` from within a field's own `update` is safe here (its
 * own field slot is filled in-place during the same computation pass, not
 * re-entrantly) — verified against the installed `@codemirror/state`
 * before relying on it; see the report.
 */
const hiddenRangesField = StateField.define<RangeSet<HiddenMarkSpan>>({
  create: hiddenMarkRanges,
  update(value, tr) {
    return syntaxTree(tr.startState) === syntaxTree(tr.state) ? value : hiddenMarkRanges(tr.state);
  },
});

/**
 * Covers caret motion, mouse selection, and `deleteBy`'s atomic-skip — see
 * `@codemirror/view`'s `moveByChar`/`MouseSelection`/`skipAtomic`. Does
 * NOT cover programmatic `dispatch({selection})`; that's `caretNormalizeFilter`'s
 * job below. CM6's own tie-break inside `skipAtomicRanges` ignores the
 * `HiddenMarkSpan` value and always resolves an exact tie toward `to` —
 * fine for arrow-key/mouse navigation, which never needs the opening/closing
 * distinction `caretNormalizeFilter` cares about.
 */
export const liveRenderAtomicRanges = EditorView.atomicRanges.of((view) =>
  view.state.field(hiddenRangesField)
);

/** The nearer edge of `[from, to)` to `pos`, breaking an exact tie via `tieEdge`. */
function normalize(pos: number, from: number, to: number, tieEdge: 'from' | 'to'): number {
  const distFrom = pos - from;
  const distTo = to - pos;
  if (distFrom === distTo) return tieEdge === 'from' ? from : to;
  return distFrom < distTo ? from : to;
}

/** Push `pos` out of any hidden span it sits strictly inside of. Boundary positions are left alone. */
function pushOut(hidden: RangeSet<HiddenMarkSpan>, pos: number): number {
  let result = pos;
  hidden.between(pos - 1, pos + 1, (from, to, value) => {
    if (pos > from && pos < to) {
      result = normalize(pos, from, to, value.tieEdge);
    }
  });
  return result;
}

/**
 * `EditorState.transactionFilter` that normalizes any selection endpoint a
 * transaction explicitly places inside a hidden marker — the mechanism
 * `atomicRanges` does not cover. md-mini has several such programmatic
 * paths today: `@codemirror/search` find/replace, session restore, `history()`
 * undo/redo, `table-selection.ts`'s snap-out, and slash-command/hover-menu
 * insertions. Without this, typing after one of those dispatches can
 * corrupt the source (e.g. produce `*x*bold**` from a caret that landed
 * inside a hidden `**`).
 *
 * Only acts when the transaction's spec explicitly sets `selection`
 * (`tr.selection !== undefined`) — every other transaction (the vast
 * majority: plain typing, scrolling, etc.) returns `tr` unchanged
 * immediately, which is both cheap and correct, since the resulting
 * *mapped* selection from an edit at an already-legal position stays legal
 * (see the report for why this is safe, and the one case where it isn't).
 */
export const caretNormalizeFilter = EditorState.transactionFilter.of((tr) => {
  if (tr.selection === undefined) return tr;

  // Reading tr.state here (recommended against in general — it forces
  // full state computation) is unavoidable: we need the syntax tree of
  // the transaction's *resulting* document, per the plan. Gating on an
  // explicit `tr.selection` keeps this off the hot path of ordinary typing.
  const hidden = tr.state.field(hiddenRangesField);

  let changed = false;
  const ranges = tr.selection.ranges.map((range) => {
    const anchor = pushOut(hidden, range.anchor);
    const head = pushOut(hidden, range.head);
    if (anchor === range.anchor && head === range.head) return range;
    changed = true;
    return EditorSelection.range(anchor, head);
  });

  if (!changed) return tr;

  // Return a plain spec object, NOT a `Transaction` instance: CM6's filter
  // pipeline (`filterTransaction`) runs a returned `Transaction` back
  // through the whole filter chain (loop risk), but resolves a plain spec
  // with `filter: false` — no re-entry, so this can never loop. Reusing
  // `tr.changes` (already a `ChangeSet`) and `tr.effects` keeps everything
  // about the transaction except the corrected selection. Best-effort
  // annotation forwarding: `Transaction` has no public "all annotations"
  // getter, so only the well-known ones are preserved — see the report.
  const userEvent = tr.annotation(Transaction.userEvent);
  const addToHistory = tr.annotation(Transaction.addToHistory);
  const remote = tr.annotation(Transaction.remote);
  return {
    changes: tr.changes,
    effects: tr.effects,
    selection: EditorSelection.create(ranges, tr.selection.mainIndex),
    scrollIntoView: tr.scrollIntoView,
    userEvent,
    annotations: [
      ...(addToHistory !== undefined ? [Transaction.addToHistory.of(addToHistory)] : []),
      ...(remote !== undefined ? [Transaction.remote.of(remote)] : []),
    ],
  };
});

/** Extension bundle — drop into `previewCompartment` for the live-render flavour. */
export const liveRenderAtomic: Extension[] = [hiddenRangesField, liveRenderAtomicRanges, caretNormalizeFilter];
