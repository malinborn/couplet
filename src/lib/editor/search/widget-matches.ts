import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { matchIndexAt, searchMatches, searchMatchesField } from './match-count';

/**
 * Highlights for matches inside table cells.
 *
 * A table is one widget that renders its cells itself, so `@codemirror/search`'s
 * mark decorations never reach the text there: a hit in a table used to be
 * counted, stepped through, and shown nowhere. Each cell says which source
 * range it renders (`data-source-from`/`-to`, `widget-text-selection.ts`) and
 * renders it verbatim, so a DOM `Range` over the cell's text node can stand in
 * for the mark — painted with the CSS Custom Highlight API (`::highlight()`),
 * which styles text without touching the widget's DOM.
 *
 * Two highlights, like the marks: every match, and the current one — the match
 * the selection is exactly on. Stepping onto a match in a body row keeps the
 * selection there while the Find panel is open (`preview/table-selection.ts`
 * exempts `select.search` from its snap-out), so the current match can be in a
 * cell; the veil's hole and halo then come from the same cell text
 * (`spotlight.ts`, `widgetRects`).
 *
 * Feature-detected: without `CSS.highlights` (WebKit before 17.2) the cells
 * stay unhighlighted. Cells with inline formatting render something other than
 * their source and are skipped.
 */

const HIGHLIGHT = 'cm-md-search-widget-match';
const CURRENT = 'cm-md-search-widget-current';

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

/** DOM ranges over the cell text of every match inside a rendered cell, and the current one's. */
function cellRanges(view: EditorView): { all: Range[]; current: Range[] } {
  const matches = searchMatches(view.state);
  const out = { all: [] as Range[], current: [] as Range[] };
  if (matches.from.length === 0) return out;
  const main = view.state.selection.main;
  const current = matchIndexAt(matches, main.from, main.to);
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
      (i === current ? out.current : out.all).push(range);
    }
  }
  return out;
}

export const widgetMatchHighlights = ViewPlugin.fromClass(
  class {
    private readonly api = registry();
    /** Whether this view has highlights registered — nothing to clear otherwise. */
    private painted = false;

    constructor(private readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.startState.field(searchMatchesField, false) !== update.state.field(searchMatchesField, false)
      ) {
        this.schedule();
      }
    }

    /**
     * The table widget's DOM can be rebuilt for reasons none of the above
     * notice — an engine switch, a compartment reconfigure, the table's wrap
     * toggle — and a highlight over removed text nodes paints nothing.
     */
    docViewUpdate(): void {
      if (searchMatches(this.view.state).from.length > 0) this.schedule();
    }

    destroy(): void {
      if (this.painted) this.clear();
    }

    private clear(): void {
      this.api?.highlights.delete(HIGHLIGHT);
      this.api?.highlights.delete(CURRENT);
      this.painted = false;
    }

    /** After the update's DOM is in place: a table re-rendered by this update has new text nodes. */
    private schedule(): void {
      if (!this.api) return;
      // Panel closed or no hits: no DOM walk, and nothing to delete twice.
      if (searchMatches(this.view.state).from.length === 0) {
        if (this.painted) this.clear();
        return;
      }
      this.view.requestMeasure({
        key: this,
        read: (view) => cellRanges(view),
        write: ({ all, current }) => {
          if (!this.api) return;
          if (all.length === 0 && current.length === 0) {
            if (this.painted) this.clear();
            return;
          }
          this.api.highlights.set(HIGHLIGHT, new this.api.Highlight(...all));
          this.api.highlights.set(CURRENT, new this.api.Highlight(...current));
          this.painted = true;
        },
      });
    }
  }
);
