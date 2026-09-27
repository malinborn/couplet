import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  type EditorView,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { decorateHeading } from './headings';
import {
  decorateEmphasis,
  decorateStrongEmphasis,
  decorateStrikethrough,
  decorateInlineCode,
  decorateLink,
} from './inline';
import { decorateListItem, decorateBlockquote, insideBlockquote } from './lists';
import { decorateHorizontalRule, decorateFencedCode } from './blocks';
import { decorateTable } from './tables';
import { decorateMermaidBlock, mermaidRendered } from './mermaid';
import { toggleTableMode } from './table-state';
import { flavourFacet } from './flavour';
import { aiCommentField } from '../ai-comment';
import { isRenderedLink } from './link-refs';
import type { DecoSink } from './utils';

/**
 * Collects decorations and sorts them before handing them to a real
 * `RangeSetBuilder`, which requires ascending `(from, startSide)` and throws
 * otherwise. Needed because the pass descends into nested inline nodes: an
 * outer span emits its closing marker after the inner span's decorations, so
 * emission order is no longer document order.
 *
 * The sort is stable, so decorators that rely on their own emission order at
 * one position — a `replace` before a `mark`, per the rule in inline.ts — keep
 * it. `startSide` handles the rest: line (-2e8) before replace (-1) before
 * mark (0).
 */
class SortingSink implements DecoSink {
  private readonly items: { from: number; to: number; value: Decoration }[] = [];

  add(from: number, to: number, value: Decoration): void {
    this.items.push({ from, to, value });
  }

  finish(): DecorationSet {
    this.items.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    const builder = new RangeSetBuilder<Decoration>();
    for (const item of this.items) builder.add(item.from, item.to, item.value);
    return builder.finish();
  }
}

export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new SortingSink();

  syntaxTree(view.state).iterate({
    enter(node) {
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6':
          decorateHeading(view, node.node, builder);
          // Descend into inline children (InlineCode, Emphasis, etc.)
          // so they get decorated inside headings too.
          break;
        // These three descend. `***bold italic***` nests StrongEmphasis inside
        // Emphasis (or the reverse), and returning false here left the inner
        // markers on screen as literal text — the outer span rendered, the
        // inner one showed its asterisks. Same for bold inside strikethrough.
        case 'Emphasis':
          decorateEmphasis(view, node.node, builder);
          break;
        case 'StrongEmphasis':
          decorateStrongEmphasis(view, node.node, builder);
          break;
        case 'Strikethrough':
          decorateStrikethrough(view, node.node, builder);
          break;
        case 'InlineCode':
          decorateInlineCode(view, node.node, builder);
          return false;
        case 'Link':
          // Not every `Link` node is a link (#51) — see `isRenderedLink`. When
          // it is not one, add nothing and descend, so inline formatting the
          // user wrote inside the brackets still renders: `[**bold** text]`
          // keeps its brackets AND its bold.
          if (!isRenderedLink(view.state.doc, node.node)) break;
          decorateLink(view, node.node, builder);
          return false;
        case 'FencedCode': {
          const doc = view.state.doc;
          const fenceLine = doc.lineAt(node.from);
          const fenceText = doc.sliceString(fenceLine.from, fenceLine.to);
          const langMatch = fenceText.match(/^`{3,}(\w+)/);
          // Never inside a quote: `langMatch` reads the line, which there
          // starts with `>`, so a quoted mermaid fence is a code block.
          if (langMatch && langMatch[1].toLowerCase() === 'mermaid') {
            decorateMermaidBlock(view, node.node, builder);
          } else {
            decorateFencedCode(view, node.node, builder);
          }
          return false;
        }
        case 'Table':
          // A table inside a quote stays raw text. Its rows carry `> `, which
          // the widget would render as part of the first cell, and every
          // table operation rewrites the source without the prefix — deleting
          // a row would take the table out of the quote.
          if (!insideBlockquote(node.node)) decorateTable(view, node.node, builder);
          return false;
        case 'HorizontalRule':
          decorateHorizontalRule(view, node.node, builder);
          return false;
        case 'ListItem':
          decorateListItem(view, node.node, builder);
          break;
        case 'Blockquote':
          // Descends: what is inside a quote is decorated by its own case,
          // exactly as it would be outside one. `decorateBlockquote` draws the
          // bars and hides the markers of the whole quote from its outermost
          // node, and does nothing for a nested one.
          decorateBlockquote(view, node.node, builder);
          break;
      }
    },
  });

  return builder.finish();
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      try {
        this.decorations = buildDecorations(view);
      } catch (e) {
        console.warn('Live preview decoration error:', e);
        this.decorations = Decoration.none;
      }
    }

    update(update: ViewUpdate) {
      const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState);
      const mermaidUpdate = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(mermaidRendered))
      );
      const tableModeUpdate = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(toggleTableMode))
      );
      // Switching flavour must rebuild. A compartment reconfigure hands CM6 the
      // same `livePreviewPlugin` value, so it reuses this instance along with
      // its cached DecorationSet, and the reconfigure transaction changes
      // neither the document nor the selection — without this check the mode
      // switch appears to do nothing until the next keystroke.
      const flavourChanged =
        update.state.facet(flavourFacet) !== update.startState.facet(flavourFacet);
      // A table paints the highlight of a comment anchored inside a cell
      // itself, because its own source lines are hidden (#62) — so the set of
      // anchors is an input to this pass, and the pass has to run when it
      // changes. Comparing the field's value covers add, remove and reload;
      // the mapping it does on every edit is already covered by `docChanged`.
      const commentsChanged =
        update.state.field(aiCommentField, false) !==
        update.startState.field(aiCommentField, false);
      if (update.docChanged || update.viewportChanged || update.selectionSet || treeChanged || mermaidUpdate || tableModeUpdate || flavourChanged || commentsChanged) {
        try {
          this.decorations = buildDecorations(update.view);
        } catch (e) {
          console.warn('Live preview decoration error:', e);
          this.decorations = Decoration.none;
        }
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
