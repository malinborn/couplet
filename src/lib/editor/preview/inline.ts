import { Decoration } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import { isRenderedLink } from './link-refs';
import type { DecoSink } from './utils';

/**
 * CRITICAL: Decoration ordering rules for RangeSetBuilder.
 *
 * RangeSetBuilder requires decorations in ascending (from, startSide) order.
 * - Decoration.replace() has startSide = -1
 * - Decoration.mark() has startSide = 0
 *
 * At the same `from` position: replace() MUST go BEFORE mark().
 *
 * Pattern: add replace for opening marker first, then mark for full range,
 * then replace for remaining markers.
 */

export function decorateEmphasis(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'emphasis', node.from, node.to)) return;
  const marks = node.getChildren('EmphasisMark');
  // Replace at node.from first (startSide=-1 < mark's startSide=0)
  for (const mark of marks) {
    if (mark.from === node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
  builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-italic' }));
  // Then replace remaining markers (at later positions)
  for (const mark of marks) {
    if (mark.from !== node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
}

export function decorateStrongEmphasis(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'strongEmphasis', node.from, node.to)) return;
  const marks = node.getChildren('EmphasisMark');
  for (const mark of marks) {
    if (mark.from === node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
  builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-bold' }));
  for (const mark of marks) {
    if (mark.from !== node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
}

export function decorateStrikethrough(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'strikethrough', node.from, node.to)) return;
  const marks = node.getChildren('StrikethroughMark');
  for (const mark of marks) {
    if (mark.from === node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
  builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-strikethrough' }));
  for (const mark of marks) {
    if (mark.from !== node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
}

export function decorateInlineCode(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'inlineCode', node.from, node.to)) return;
  const marks = node.getChildren('CodeMark');
  for (const mark of marks) {
    if (mark.from === node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
  builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-inline-code' }));
  for (const mark of marks) {
    if (mark.from !== node.from) {
      builder.add(mark.from, mark.to, Decoration.replace({}));
    }
  }
}

export function decorateLink(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  // A `Link` node is not necessarily a link (#51). `@lezer/markdown` produces
  // one for every bracket pair, so `see [1] here` and `dict["k"]` arrive as
  // Link nodes; hiding their brackets removes characters the user typed.
  if (!isRenderedLink(view.state.doc, node)) return;
  if (shouldReveal(view, 'link', node.from, node.to)) return;

  const url = node.getChild('URL');
  const linkMarks = node.getChildren('LinkMark');

  // Find the opening [ mark
  const openMark = linkMarks.find((m) => m.from === node.from);

  // Find where the label text ends: the ] mark right before (url)
  // We need the position of ] to know where to split label from url portion
  const closeBracket = url
    ? linkMarks.find((m) => m.to <= url.from && m.from > node.from)
    : linkMarks.find((m) => m.from > node.from);

  // 1. Replace opening [ (startSide=-1, before mark at same position)
  if (openMark) {
    builder.add(openMark.from, openMark.to, Decoration.replace({}));
  }

  // 2. Mark the full node range for link styling
  builder.add(node.from, node.to, Decoration.mark({ class: 'cm-md-link' }));

  // 3. Single replace for everything from ] to end of node: ](url)
  if (closeBracket) {
    builder.add(closeBracket.from, node.to, Decoration.replace({}));
  }
}
