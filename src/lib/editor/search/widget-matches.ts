import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { searchMatches, searchMatchesField } from './match-count';

/**
 * Highlights for matches inside table cells.
 *
 * A table is one widget that renders its cells itself, so `@codemirror/search`'s
 * mark decorations never reach the text there: a hit in a table was counted,
 * stepped through, and shown nowhere. Each cell says which source range it
 * renders (`data-source-from`/`-to`, `widget-text-selection.ts`) and renders it
 * verbatim, so a DOM `Range` over the cell's text node can stand in for the
 * mark — painted with the CSS Custom Highlight API (`::highlight()`), which
 * styles text without touching the widget's DOM.
 *
 * Feature-detected: without `CSS.highlights` (WebKit before 17.2) the cell
 * simply stays unhighlighted, as it always was. Cells with inline formatting
 * render something other than their source and are skipped.
 */

const HIGHLIGHT = 'cm-md-search-widget-match';

interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): boolean;
}

type HighlightCtor = new (...ranges: Range[]) => object;

function registry(): { highlights: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined;
  const ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && ctor ? { highlights: css.highlights, Highlight: ctor } : null;
}

/** DOM ranges over the cell text of every match that lies inside a rendered cell. */
function cellRanges(view: EditorView): Range[] {
  const matches = searchMatches(view.state);
  if (matches.from.length === 0) return [];
  const ranges: Range[] = [];
  for (const cell of view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table [data-source-from][data-source-to]')) {
    const srcFrom = Number(cell.dataset.sourceFrom);
    const srcTo = Number(cell.dataset.sourceTo);
    const text = cell.firstChild;
    if (!(text instanceof Text) || cell.childNodes.length !== 1) continue;
    if (text.data !== view.state.sliceDoc(srcFrom, srcTo)) continue;
    // First match ending after the cell starts.
    let lo = 0;
    let hi = matches.to.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (matches.to[mid] <= srcFrom) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < matches.from.length && matches.from[i] < srcTo; i++) {
      const from = matches.from[i];
      const to = matches.to[i];
      if (from < srcFrom || to > srcTo || to === from) continue;
      const range = document.createRange();
      range.setStart(text, from - srcFrom);
      range.setEnd(text, to - srcFrom);
      ranges.push(range);
    }
  }
  return ranges;
}

export const widgetMatchHighlights = ViewPlugin.fromClass(
  class {
    private readonly api = registry();

    constructor(private readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(searchMatchesField, false) !== update.state.field(searchMatchesField, false)
      ) {
        this.schedule();
      }
    }

    destroy(): void {
      this.api?.highlights.delete(HIGHLIGHT);
    }

    /** After the update's DOM is in place: a table re-rendered by this update has new text nodes. */
    private schedule(): void {
      if (!this.api) return;
      this.view.requestMeasure({
        key: this,
        read: (view) => cellRanges(view),
        write: (ranges) => {
          if (!this.api) return;
          if (ranges.length === 0) this.api.highlights.delete(HIGHLIGHT);
          else this.api.highlights.set(HIGHLIGHT, new this.api.Highlight(...ranges));
        },
      });
    }
  }
);
