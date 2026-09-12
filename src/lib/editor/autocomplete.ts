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
  const fenceMatch = text.match(/^(\s*)(`{3,})(\w*)\s*$/);
  if (fenceMatch && from === line.to) {
    const [, indent, ticks] = fenceMatch;
    const insert = `\n${indent}\n${indent}${ticks}`;
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from + 1 + indent.length },
    });
    return true;
  }

  return false;
}

const LIST_LINE_RE = /^\s*([-*+]|\d+\.)\s/;
const INDENT_UNIT = '  ';

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
 */
export function computeListIndentChanges(
  doc: Text,
  ranges: readonly { from: number; to: number }[],
  indent: boolean
): ChangeSpec[] | null {
  const changes: ChangeSpec[] = [];
  let sawListLine = false;

  for (const ln of selectedLineNumbers(doc, ranges)) {
    const line = doc.line(ln);
    if (!LIST_LINE_RE.test(line.text)) continue;
    sawListLine = true;

    if (indent) {
      changes.push({ from: line.from, insert: INDENT_UNIT });
    } else if (line.text.startsWith(INDENT_UNIT)) {
      changes.push({ from: line.from, to: line.from + INDENT_UNIT.length, insert: '' });
    }
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
