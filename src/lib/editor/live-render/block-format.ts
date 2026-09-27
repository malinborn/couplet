import { syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  Prec,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Line,
} from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { markupModelField, markupPairs } from './atomic';

/**
 * Backspace-strips-block-format for live-render mode (Notion behaviour):
 * pressing Backspace at the visual start of a heading/list-item/blockquote
 * removes the block's marker instead of joining it with the previous line.
 *
 * Headings are NOT handled here — `deleteBy` in @codemirror/commands already
 * extends the deletion to the atomic-range boundary (see live-render/atomic.ts),
 * so one Backspace press removes the whole "## " prefix for free. We still
 * detect heading lines explicitly below and return null, both to document the
 * decision and so the negative case has a real test.
 *
 * Lists and blockquotes are the hard case: CommonMark lazy continuation means
 * simply deleting "- "/"> " does NOT produce a paragraph — the orphaned text
 * stays inside the block and only the marker vanishes. Verified empirically
 * against the exact @lezer/markdown config in setup.ts:44-48:
 *   "- a\nb\n"       -> ListItem[0,5] > ListMark[0,1], Paragraph[2,5] "a\nb"
 *   "- a\nb\n- c\n"  -> "b" is swallowed into item "a"'s paragraph, but a
 *                       following "- c" still opens its own ListItem (a list
 *                       marker always interrupts a paragraph)
 *   "> a\nb\n> c\n"  -> single Blockquote, Paragraph "a\nb\n> c" — even the
 *                       literal "> c" text is swallowed; blockquote markers on
 *                       a *continuation* line do NOT reopen on their own
 * So ejecting a line/item into a real paragraph requires inserting a blank
 * line on every side that still has sibling block content — but only on that
 * side. A marker-led neighbour (a following "- c" or "> c" starting a *fresh*
 * line) always reopens correctly without a blank line, since list/quote
 * markers interrupt paragraphs by themselves:
 *   "a\n- b\n"   -> Paragraph "a", BulletList "- b"   (no blank needed after)
 *   "a\n> b\n"   -> Paragraph "a", Blockquote "> b"   (no blank needed after)
 * but a marker-less neighbour (the text that remains once ITS OWN marker is
 * stripped) still needs the blank line to avoid being swallowed backward.
 */

const HEADING_NAMES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
]);

// One level of blockquote prefix: optional indentation, '>', optional single space.
const QUOTE_LEVEL = /[ \t]*>[ \t]?/g;
// The full (possibly nested) blockquote prefix at the start of a line.
const QUOTE_PREFIX = /^(?:[ \t]*>[ \t]?)+/;
// Does this line carry at least one level of blockquote prefix? Used only to
// probe a neighbouring line, so depth need not match exactly.
const QUOTE_LINE = /^[ \t]*>/;

export interface BlockFormatRemoval {
  changes: ChangeSpec[];
  /** Caret position after `changes` is applied, already mapped through them. */
  caret: number;
}

/**
 * Whether `pos` is where the caret sits at the start of a block's content *on
 * screen*. That is `contentFrom` itself, or any offset reached from it by
 * stepping over opening markers that are hidden there: in `> **bold**` the
 * content starts at 2, but the caret the user sees before "b" is at 4, and a
 * Backspace there means the same thing. Without this it fell through to the
 * default command, which deleted the hidden space after `>` (or after `-`) —
 * nothing changed on screen, and the list or quote was quietly broken.
 */
// The first character of every opening marker a pair can have.
const OPENING_MARKER_CHARS = '*_~`[';

function isContentStart(state: EditorState, contentFrom: number, pos: number): boolean {
  if (pos === contentFrom) return true;
  if (pos < contentFrom) return false;
  // Cheap bail-out first: Backspace runs this on every press, and the pairs
  // cost a whole-tree walk when live-render's cached model is not installed.
  if (!OPENING_MARKER_CHARS.includes(state.doc.sliceString(contentFrom, contentFrom + 1))) {
    return false;
  }
  const pairs = state.field(markupModelField, false)?.pairs ?? markupPairs(state);
  let at = contentFrom;
  for (let guard = 0; guard < 8; guard++) {
    const open = pairs.find((p) => p.openFrom === at);
    if (!open) return false;
    at = open.openTo;
    if (at === pos) return true;
  }
  return false;
}

/**
 * Pure planning function: given the current state, decides whether Backspace
 * should strip a block format and, if so, returns the edit to make. Returns
 * null whenever the default Backspace should run instead.
 */
export function computeBlockFormatRemoval(state: EditorState): BlockFormatRemoval | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;

  const pos = sel.head;
  const line = state.doc.lineAt(pos);

  // Headings: return null and let deleteBy's atomic-range skip handle it.
  if (isHeadingContentStart(state, pos, line)) return null;

  const listMark = findListMarkAt(state, pos, line);
  if (listMark) return computeListRemoval(state, listMark);

  return computeQuoteRemoval(state, pos, line);
}

/** The command CM6 binds to Backspace. Returns false to fall through to the default handler. */
export const removeBlockFormatBackward: Command = (view) => {
  const result = computeBlockFormatRemoval(view.state);
  if (!result) return false;

  view.dispatch({
    changes: result.changes,
    selection: EditorSelection.cursor(result.caret),
    userEvent: 'delete.backward',
    scrollIntoView: true,
  });
  return true;
};

/**
 * Must be Prec.highest, not Prec.high. Verified in a browser against a real
 * Backspace keypress: at Prec.high this command is never even entered, while
 * an otherwise identical binding at Prec.highest runs and returns true.
 *
 * Backspace is special in CM6. It appears in the view's PendingKeys table
 * paired with inputType "deleteContentBackward", so on a contenteditable it is
 * not resolved purely from keydown — the native edit is allowed to happen and
 * reconciled afterwards, with the key re-dispatched so bindings still get a
 * turn. Losing that turn is not a silent no-op: the DOM-derived change is
 * applied instead, and because the bullet is a widget the reconciliation
 * rewrote "- b" as "  b" — an outdent nobody asked for, with the text still
 * inside the list item.
 *
 * Wrapped here rather than at the call site so a caller cannot get it wrong.
 * The command returns false everywhere except the first content position of a
 * list item or blockquote, so nothing else that binds Backspace — including
 * closeBrackets' deleteBracketPair — loses a case it would otherwise handle.
 */
export const blockFormatKeymap: Extension = Prec.highest(
  keymap.of([{ key: 'Backspace', run: removeBlockFormatBackward }])
);

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

function isHeadingContentStart(state: EditorState, pos: number, line: Line): boolean {
  let result = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: pos,
    enter(node) {
      if (node.name !== 'HeaderMark') return;
      const mark = node.node;
      const heading = mark.parent;
      if (!heading || !HEADING_NAMES.has(heading.name)) return;
      const contentFrom = Math.min(mark.to + 1, heading.to);
      if (contentFrom === pos) result = true;
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function findListMarkAt(state: EditorState, pos: number, line: Line): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: pos,
    enter(nodeRef) {
      if (nodeRef.name !== 'ListMark') return;
      const mark = nodeRef.node;
      const contentFrom = mark.nextSibling?.from ?? mark.to;
      if (isContentStart(state, contentFrom, pos)) found = mark;
    },
  });
  return found;
}

function computeListRemoval(state: EditorState, mark: SyntaxNode): BlockFormatRemoval | null {
  const item = mark.parent;
  if (!item || item.name !== 'ListItem') return null;
  const list = item.parent;
  if (!list) return null;

  const line = state.doc.lineAt(mark.from);
  const indent = mark.from - line.from;
  const contentFrom = mark.nextSibling?.from ?? mark.to;

  // An item of a list that sits directly in a quote: its indent is the quote
  // prefix, not nesting, so it becomes a paragraph of that quote.
  if (list.parent?.name === 'Blockquote') {
    return computeQuotedListItemToParagraph(state, item, list, mark, contentFrom);
  }

  if (indent > 0) {
    return computeNestedOutdent(state, item, list, indent);
  }

  return computeListItemToParagraph(state, item, list, contentFrom);
}

/** How many characters of `text` the quote prefix at its start takes. */
function quotePrefixLength(text: string): number {
  return QUOTE_PREFIX.exec(text)?.[0].length ?? 0;
}

/** True when `node` sits inside a blockquote, at any distance. */
function isQuoted(node: SyntaxNode): boolean {
  for (let p: SyntaxNode | null = node.parent; p; p = p.parent) {
    if (p.name === 'Blockquote') return true;
  }
  return false;
}

/** Nested list item (indentation > 0): outdent one level, keep it as a list item. */
function computeNestedOutdent(
  state: EditorState,
  item: SyntaxNode,
  list: SyntaxNode,
  indent: number
): BlockFormatRemoval | null {
  const parentItem = list.parent;
  if (!parentItem || parentItem.name !== 'ListItem') return null;

  const parentLine = state.doc.lineAt(parentItem.from);
  const parentIndent = parentItem.from - parentLine.from;
  const removeCount = indent - parentIndent;
  if (removeCount <= 0) return null;

  const startLineNo = state.doc.lineAt(item.from).number;
  const endLineNo = state.doc.lineAt(item.to).number;
  const changes: ChangeSpec[] = [];
  // Inside a quote the indentation follows the `> ` prefix, which stays.
  const quoted = isQuoted(item);

  // Strip `removeCount` leading whitespace characters from every line the
  // item spans, so multi-line continuation content travels with it.
  for (let n = startLineNo; n <= endLineNo; n++) {
    const ln = state.doc.line(n);
    const skip = quoted ? quotePrefixLength(ln.text) : 0;
    const leading = /^[ \t]*/.exec(ln.text.slice(skip))![0].length;
    const cut = Math.min(removeCount, leading);
    if (cut > 0) changes.push({ from: ln.from + skip, to: ln.from + skip + cut, insert: '' });
  }
  if (changes.length === 0) return null;

  const caret = ChangeSet.of(changes, state.doc.length).mapPos(state.selection.main.head, -1);
  return { changes, caret };
}

/** Top-level list item: convert to a paragraph, splitting the list if the item sits in the middle. */
function computeListItemToParagraph(
  state: EditorState,
  item: SyntaxNode,
  list: SyntaxNode,
  contentFrom: number
): BlockFormatRemoval {
  const siblings = list.getChildren('ListItem');
  const idx = siblings.findIndex((n) => n.from === item.from && n.to === item.to);
  const hasBefore = idx > 0;
  const hasAfter = idx >= 0 && idx < siblings.length - 1;

  const changes: ChangeSpec[] = [
    // Remove the marker (and any indentation before it); replace with a
    // blank-line separator only if a preceding sibling item remains, so its
    // text doesn't get lazily swallowed backward into it.
    { from: item.from, to: contentFrom, insert: hasBefore ? '\n' : '' },
  ];
  if (hasAfter) {
    // The following sibling still starts with its own marker, so it would
    // reopen correctly even directly adjacent — but the plan's fixtures
    // insert a blank line here too, for symmetric spacing around the
    // ejected paragraph.
    changes.push({ from: item.to, to: item.to, insert: '\n' });
  }

  return { changes, caret: caretAfter(state, changes, contentFrom) };
}

/**
 * Where the caret goes: after `contentFrom`, by as much as it was before. The
 * two differ only when the caret stood past hidden opening markers, and those
 * are outside every change here, so the offset between them survives.
 */
function caretAfter(state: EditorState, changes: ChangeSpec[], contentFrom: number): number {
  const mapped = ChangeSet.of(changes, state.doc.length).mapPos(contentFrom, -1);
  return mapped + (state.selection.main.head - contentFrom);
}

/**
 * Item of a list directly inside a quote: strip the list marker and keep the
 * quote. A neighbouring item gets a blank quote line (`>`) between them rather
 * than a blank line, which would end the quote — and without any separator
 * the paragraph would be a lazy continuation of the item above.
 */
function computeQuotedListItemToParagraph(
  state: EditorState,
  item: SyntaxNode,
  list: SyntaxNode,
  mark: SyntaxNode,
  contentFrom: number
): BlockFormatRemoval {
  const siblings = list.getChildren('ListItem');
  const idx = siblings.findIndex((n) => n.from === item.from && n.to === item.to);
  const hasBefore = idx > 0;
  const hasAfter = idx >= 0 && idx < siblings.length - 1;

  const line = state.doc.lineAt(mark.from);
  // The prefix as a *continuation* line would carry it: an outer list marker
  // in front of the quote (`- > - a`) becomes the indent that continues its
  // item, or the separator line would open a new outer item.
  const blank = state.doc
    .sliceString(line.from, mark.from)
    .replace(/[^>\s]/g, ' ')
    .trimEnd();
  const changes: ChangeSpec[] = [];
  if (hasBefore) changes.push({ from: line.from, to: line.from, insert: `${blank}\n` });
  changes.push({ from: mark.from, to: contentFrom, insert: '' });
  if (hasAfter) changes.push({ from: item.to, to: item.to, insert: `\n${blank}` });

  return { changes, caret: caretAfter(state, changes, contentFrom) };
}

// ---------------------------------------------------------------------------
// Blockquotes
// ---------------------------------------------------------------------------

function computeQuoteRemoval(state: EditorState, pos: number, line: Line): BlockFormatRemoval | null {
  const match = QUOTE_PREFIX.exec(line.text);
  if (!match) return null;

  const contentFrom = line.from + match[0].length;
  if (!isContentStart(state, contentFrom, pos)) return null;

  // Guard against literal '>' text that isn't really a blockquote (e.g. inside
  // a fenced code block) — require an actual QuoteMark node in range.
  let hasQuoteMark = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: contentFrom,
    enter(node) {
      if (node.name === 'QuoteMark') hasQuoteMark = true;
    },
  });
  if (!hasQuoteMark) return null;

  const groups = Array.from(match[0].matchAll(QUOTE_LEVEL)).map((g) => g[0]);
  if (groups.length === 0) return null;

  if (groups.length > 1) {
    return computeNestedQuoteOutdent(state, contentFrom, groups);
  }

  return computeQuoteLineToParagraph(state, line, contentFrom);
}

/** Nested blockquote (`> > x`): strip exactly one level, closest to the content. */
function computeNestedQuoteOutdent(
  state: EditorState,
  contentFrom: number,
  groups: string[]
): BlockFormatRemoval {
  const lastGroup = groups[groups.length - 1];
  const changes: ChangeSpec[] = [
    { from: contentFrom - lastGroup.length, to: contentFrom, insert: '' },
  ];
  // The caret is at or past the removed group; map it straight through.
  const caret = ChangeSet.of(changes, state.doc.length).mapPos(state.selection.main.head, -1);
  return { changes, caret };
}

/** Top-level blockquote line: convert to a paragraph, splitting the quote if it sits in the middle. */
function computeQuoteLineToParagraph(
  state: EditorState,
  line: Line,
  contentFrom: number
): BlockFormatRemoval {
  const prevLine = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const hasBefore = !!prevLine && QUOTE_LINE.test(prevLine.text);
  const hasAfter = !!nextLine && QUOTE_LINE.test(nextLine.text);

  const changes: ChangeSpec[] = [
    { from: line.from, to: contentFrom, insert: hasBefore ? '\n' : '' },
  ];
  if (hasAfter) {
    changes.push({ from: line.to, to: line.to, insert: '\n' });
  }

  return { changes, caret: caretAfter(state, changes, contentFrom) };
}
