import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
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
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.textContent = '\u2022';
    return span;
  }

  eq(): boolean {
    return true;
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

// Two source spaces per level render as ~9px, which is too little to read as a
// hierarchy. The line decoration adds the rest; levels past this cap share the
// deepest step rather than marching off the right edge.
const MAX_INDENT_DEPTH = 6;

const depthLines: readonly Decoration[] = Array.from(
  { length: MAX_INDENT_DEPTH + 1 },
  (_, depth) => Decoration.line({ class: `cm-md-list-d${depth}` })
);

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

  const afterMark = doc.sliceString(listMark.to, Math.min(listMark.to + 5, doc.length));

  const checkboxMatch = afterMark.match(/^\s\[([x ])\]/);
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
    return;
  }

  // Bullet markers: only replace when cursor is NOT in range
  if (shouldReveal(view, 'listBullet', node.from, node.to)) return;

  const markText = doc.sliceString(listMark.from, listMark.to);
  if (markText === '-' || markText === '*' || markText === '+') {
    builder.add(
      listMark.from,
      listMark.to,
      Decoration.replace({ widget: new BulletWidget() })
    );
  }
}

export function decorateBlockquote(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'blockquote', node.from, node.to, true)) return;

  const doc = view.state.doc;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);

  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = doc.line(i);
    builder.add(line.from, line.from, Decoration.line({ class: 'cm-md-blockquote' }));

    const match = line.text.match(/^(\s*>)\s?/);
    if (match) {
      builder.add(line.from, line.from + match[0].length, Decoration.replace({}));
    }
  }
}
