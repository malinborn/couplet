import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * The selection over code, painted from inside the text.
 *
 * `drawSelection()` draws its rectangles in a layer *behind* `.cm-content`, and
 * inline code (`.cm-md-inline-code`) and fenced-code lines (`.cm-md-code-line`)
 * have an opaque `--color-code-bg` of their own — so a selection that crossed
 * code simply vanished over it. This paints it again on top: a mark over the
 * selected text of each code node, and a line class for a fenced line selected
 * from its start through its line break, which the CSS (`styles/editor.css`)
 * fills edge to edge like CM6's own rectangle for a line in the middle of a
 * selection. The CSS paints only inside rendered code, so raw code (caret
 * inside, source mode) keeps the layer's own rectangles.
 *
 * `Prec.highest`: higher-precedence marks become the INNER DOM node, so this
 * span sits inside the code span and its background lands on top of the
 * code's. Keep it out of any compartment and above other decoration sources —
 * `code-selection.dom.test.ts` checks the nesting.
 */

export interface CodeSelection {
  /** Selected text inside code nodes. */
  marks: { from: number; to: number }[];
  /** Starts of fenced-block lines selected from their start through their line break. */
  fullLines: number[];
}

/** What of the selection lies over code, within `[from, to]` (the visible range). */
export function codeSelection(state: EditorState, from: number, to: number): CodeSelection {
  const marks: { from: number; to: number }[] = [];
  const fullLines = new Set<number>();
  const { doc } = state;
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const selFrom = Math.max(range.from, from);
    const selTo = Math.min(range.to, to);
    if (selFrom >= selTo) continue;
    tree.iterate({
      from: selFrom,
      to: selTo,
      enter: (node) => {
        if (node.name !== 'InlineCode' && node.name !== 'FencedCode') return;
        const markFrom = Math.max(node.from, selFrom);
        const markTo = Math.min(node.to, selTo);
        if (markFrom >= markTo) return false;
        marks.push({ from: markFrom, to: markTo });
        if (node.name === 'FencedCode') {
          // Only the lines the selection crosses; the fence lines are filtered
          // out by the CSS (they are not `.cm-md-code-line`).
          const last = doc.lineAt(markTo).number;
          for (let n = doc.lineAt(markFrom).number; n <= last; n++) {
            const line = doc.line(n);
            // From its start (the quote prefix included) through its break —
            // a selection that merely ends at the line's start or end does
            // not reach the break, as with CM6's own rectangles.
            if (range.from <= line.from && range.to > line.to) fullLines.add(line.from);
          }
        }
        return false;
      },
    });
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  return { marks, fullLines: [...fullLines].sort((a, b) => a - b) };
}

const selectionMark = Decoration.mark({ class: 'cm-md-code-selection' });
const lineSelected = Decoration.line({ class: 'cm-md-code-line-selected' });

function build(view: EditorView): DecorationSet {
  const ranges: ReturnType<typeof selectionMark.range>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const { marks, fullLines } = codeSelection(view.state, from, to);
    for (const pos of fullLines) ranges.push(lineSelected.range(pos));
    for (const m of marks) ranges.push(selectionMark.range(m.from, m.to));
  }
  // `Decoration.set(…, true)` sorts.
  return Decoration.set(ranges, true);
}

export const codeSelectionHighlight: Extension = Prec.highest(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.selectionSet ||
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
);
