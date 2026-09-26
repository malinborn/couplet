import { Decoration } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import type { DecoSink } from './utils';

const headingClasses: Record<string, string> = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
};

const headingTextMark = Decoration.mark({ class: 'cm-md-heading-text' });

export function decorateHeading(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  const cls = headingClasses[node.name];
  if (!cls) return;
  if (shouldReveal(view, 'heading', node.from, node.to)) return;

  const line = view.state.doc.lineAt(node.from);
  // Line decoration FIRST (lower startSide)
  builder.add(line.from, line.from, Decoration.line({ class: cls }));

  // Then hide "## " prefix via replace (Decoration.line startSide=-200000000 < replace startSide=-1)
  const mark = node.getChild('HeaderMark');
  let textFrom = node.from;
  if (mark) {
    const hideEnd = Math.min(mark.to + 1, node.to);
    builder.add(mark.from, hideEnd, Decoration.replace({}));
    textFrom = hideEnd;
  }

  // Wrap the heading's text in an inline span. It hides nothing (so live-render's
  // `hiddenMarkRanges` has nothing to mirror); it exists only as a paint target:
  // an inline box gets one content area per line fragment, so a theme's
  // vertical gradient (`--heading-vgrad-N`, see editor.css) lands on the same
  // part of the glyphs on every wrapped line. Starts where the replace ends,
  // so it never shares a start position with it. Empty heading → no span.
  if (textFrom < node.to) {
    builder.add(textFrom, node.to, headingTextMark);
  }
}
