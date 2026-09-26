import { keymap } from '@codemirror/view';
import { Prec, type ChangeSpec, type Extension, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

function handleEnterInList(view: EditorView): boolean {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;

  const bulletMatch = text.match(/^(\s*)([-*+])\s(.*)$/);
  const numberedMatch = text.match(/^(\s*)(\d+)\.\s(.*)$/);
  const checkboxMatch = text.match(/^(\s*)([-*+])\s\[[ x]\]\s(.*)$/);

  if (checkboxMatch) {
    const [, indent, marker, content] = checkboxMatch;
    if (content.trim() === '') {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    const continuation = `\n${indent}${marker} [ ] `;
    view.dispatch({
      changes: { from, insert: continuation },
      selection: { anchor: from + continuation.length },
    });
    return true;
  }

  if (bulletMatch) {
    const [, indent, marker, content] = bulletMatch;
    if (content.trim() === '') {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    const continuation = `\n${indent}${marker} `;
    view.dispatch({
      changes: { from, insert: continuation },
      selection: { anchor: from + continuation.length },
    });
    return true;
  }

  if (numberedMatch) {
    const [, indent, num, content] = numberedMatch;
    if (content.trim() === '') {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
      return true;
    }
    const next = parseInt(num, 10) + 1;
    const continuation = `\n${indent}${next}. `;
    view.dispatch({
      changes: { from, insert: continuation },
      selection: { anchor: from + continuation.length },
    });
    return true;
  }

  // Code fence auto-close
  const close = computeFenceAutoClose(text, from - line.from);
  if (close) {
    view.dispatch({
      changes: { from, insert: close.insert },
      selection: { anchor: line.from + close.caret },
    });
    return true;
  }

  return false;
}

/**
 * Enter at the end of an opening fence line (`column` is the caret's offset in
 * `text`): the empty content line and the closing fence to insert after it,
 * and the caret as an offset in `text + insert` — on the empty line.
 *
 * A fence inside a blockquote carries its quote prefix onto both new lines.
 * Without it the new lines are outside the quote, which ends the quote and
 * leaves the fence unterminated. An unquoted fence has an empty prefix and is
 * closed exactly as it always was.
 */
export function computeFenceAutoClose(
  text: string,
  column: number
): { insert: string; caret: number } | null {
  if (column !== text.length) return null;
  const m = text.match(/^((?:[ \t]*>[ \t]?)*)(\s*)(`{3,})(\w*)\s*$/);
  if (!m) return null;
  const [, quote, indent, ticks] = m;
  const prefix = (quote && !/[ \t]$/.test(quote) ? `${quote} ` : quote) + indent;
  return {
    insert: `\n${prefix}\n${prefix}${ticks}`,
    caret: text.length + 1 + prefix.length,
  };
}

const LIST_LINE_RE = /^\s*([-*+]|\d+\.)\s/;
const LIST_COLUMNS_RE = /^(\s*)([-*+]|\d+\.)(\s+)/;
// Used only where a line has no item above it to nest under, where no width
// nests and the number is arbitrary.
const FALLBACK_INDENT = 2;

interface ListColumns {
  /** Column the marker starts at. */
  indent: number;
  /** Column the item's content starts at — where a child's marker must reach. */
  content: number;
}

function listColumns(text: string): ListColumns | null {
  const m = text.match(LIST_COLUMNS_RE);
  if (!m) return null;
  return { indent: m[1].length, content: m[1].length + m[2].length + m[3].length };
}

/**
 * The nearest list item above `lineNumber` that `accept` recognises as the one
 * to line up against. Stops at a blank line, which ends the list; skips lines
 * that are not list items at all (a wrapped paragraph inside an item).
 */
function findItemAbove(
  doc: Text,
  lineNumber: number,
  accept: (cols: ListColumns) => boolean
): ListColumns | null {
  for (let ln = lineNumber - 1; ln >= 1; ln--) {
    const { text } = doc.line(ln);
    if (text.trim() === '') return null;
    const cols = listColumns(text);
    if (cols && accept(cols)) return cols;
  }
  return null;
}

/**
 * How many spaces one Tab adds to the list line at `lineNumber`.
 *
 * Not a constant. CommonMark nests a sub-list only once its marker reaches the
 * parent item's *content* column, and that column depends on the marker's
 * width: 2 for `-`, 3 for `1.`, 4 for `10.`. A fixed two-space unit nests
 * bullet lists and silently fails to nest ordered ones — the sub-item stays a
 * sibling, so it renders at its parent's indent. That is #44.
 */
export function indentStepFor(doc: Text, lineNumber: number): number {
  const self = listColumns(doc.line(lineNumber).text);
  if (!self) return FALLBACK_INDENT;
  // The previous sibling, i.e. the nearest item not nested deeper than this one.
  const parent = findItemAbove(doc, lineNumber, (cols) => cols.indent <= self.indent);
  if (!parent) return FALLBACK_INDENT;
  return Math.max(parent.content - self.indent, 1);
}

/**
 * How many spaces one Shift-Tab removes from the list line at `lineNumber`:
 * enough to land on its parent item's own column, one level out.
 */
export function outdentStepFor(doc: Text, lineNumber: number): number {
  const self = listColumns(doc.line(lineNumber).text);
  if (!self || self.indent === 0) return 0;
  const parent = findItemAbove(doc, lineNumber, (cols) => cols.indent < self.indent);
  return parent ? self.indent - parent.indent : self.indent;
}

/**
 * Line numbers a selection covers, for the purpose of a block operation.
 *
 * A range that ends exactly at the start of a line does not include that line:
 * selecting three items by dragging past the third one's newline would
 * otherwise also indent the untouched fourth.
 */
export function selectedLineNumbers(
  doc: Text,
  ranges: readonly { from: number; to: number }[]
): number[] {
  const seen = new Set<number>();
  for (const range of ranges) {
    const first = doc.lineAt(range.from);
    let lastNumber = doc.lineAt(range.to).number;
    if (
      range.to > range.from &&
      lastNumber > first.number &&
      doc.line(lastNumber).from === range.to
    ) {
      lastNumber--;
    }
    for (let ln = first.number; ln <= lastNumber; ln++) seen.add(ln);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * One `changes` spec covering every list line in the selection.
 *
 * Built over all selected lines rather than the line under the main cursor:
 * with several items selected, Tab used to move only the first one. Selected
 * lines that are not list items are left alone — a wrapped paragraph inside an
 * item must not collect two stray spaces.
 *
 * Returns `null` when the selection contains no list line at all, so the
 * caller can fall through to whatever else is bound to Tab.
 *
 * Indenting uses one step for the whole selection — the step the topmost
 * selected item needs — so a nested block keeps its shape instead of having
 * each line snap to its own parent's column. Outdenting stays per line, so a
 * mixed selection moves the items that have room and leaves the rest alone.
 */
export function computeListIndentChanges(
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  indent: boolean
): ChangeSpec[] | null {
  const changes: ChangeSpec[] = [];
  let sawListLine = false;
  let step = 0;

  for (const ln of selectedLineNumbers(doc, ranges)) {
    const line = doc.line(ln);
    if (!LIST_LINE_RE.test(line.text)) continue;
    if (!sawListLine) step = indentStepFor(doc, ln);
    sawListLine = true;

    if (indent) {
      changes.push({ from: line.from, insert: ' '.repeat(step) });
      continue;
    }

    const back = outdentStepFor(doc, ln);
    if (back > 0) changes.push({ from: line.from, to: line.from + back, insert: '' });
  }

  return sawListLine ? changes : null;
}

function handleTabInList(view: EditorView, indent: boolean): boolean {
  const { state } = view;
  const changes = computeListIndentChanges(state.doc, state.selection.ranges, indent);

  // No list line in the selection — let the next binding have the key.
  if (changes === null) return false;
  // A list, but already flush left on outdent: swallow the key rather than
  // letting Tab move focus out of the editor mid-list.
  if (changes.length === 0) return true;

  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    // assoc 1 keeps a caret that sits at the very start of a line in front of
    // the marker, instead of stranding it before the spaces just inserted.
    selection: state.selection.map(changeSet, 1),
  });

  renumberOrderedListAround(view);
  return true;
}

export function computeOrderedListRenumberChanges(
  doc: Text,
  anchorLineNumber: number
): ChangeSpec[] {
  const isListLine = (s: string) => /^\s*([-*+]|\d+\.)\s/.test(s);

  let startLn = anchorLineNumber;
  while (startLn > 1) {
    const prev = doc.line(startLn - 1);
    if (prev.text.trim() === '' || !isListLine(prev.text)) break;
    startLn--;
  }
  let endLn = anchorLineNumber;
  while (endLn < doc.lines) {
    const next = doc.line(endLn + 1);
    if (next.text.trim() === '' || !isListLine(next.text)) break;
    endLn++;
  }

  const counters = new Map<number, number>();
  let lastIndent = -1;
  const changes: ChangeSpec[] = [];

  for (let ln = startLn; ln <= endLn; ln++) {
    const l = doc.line(ln);
    const m = l.text.match(/^(\s*)([-*+]|\d+\.)\s/);
    if (!m) continue;
    const indent = m[1].length;

    if (lastIndent >= 0 && indent < lastIndent) {
      for (const k of [...counters.keys()]) {
        if (k > indent) counters.delete(k);
      }
    }
    lastIndent = indent;

    const ordMatch = l.text.match(/^(\s*)(\d+)\./);
    if (!ordMatch) continue;

    const next = counters.get(indent) ?? 1;
    counters.set(indent, next + 1);

    const oldNum = parseInt(ordMatch[2], 10);
    if (oldNum === next) continue;

    const numStart = l.from + ordMatch[1].length;
    const numEnd = numStart + ordMatch[2].length;
    changes.push({ from: numStart, to: numEnd, insert: String(next) });
  }

  return changes;
}

function renumberOrderedListAround(view: EditorView): void {
  const { state } = view;
  const cursorLine = state.doc.lineAt(state.selection.main.from);
  const changes = computeOrderedListRenumberChanges(state.doc, cursorLine.number);
  if (changes.length > 0) view.dispatch({ changes });
}

export function listContinuation(): Extension {
  // Higher precedence than @codemirror/lang-markdown's insertNewlineContinueMarkup,
  // which would otherwise intercept Enter and break list continuation at deeper
  // nesting levels (CommonMark requires alignment past the parent marker; our
  // 2-space indent doesn't satisfy that for level 3+, so the Lezer-driven
  // continuation gives up while our regex still works).
  return Prec.high(
    keymap.of([
      { key: 'Enter', run: handleEnterInList },
      { key: 'Tab', run: (view) => handleTabInList(view, true) },
      { key: 'Shift-Tab', run: (view) => handleTabInList(view, false) },
    ])
  );
}
