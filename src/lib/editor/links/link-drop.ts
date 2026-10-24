import { EditorSelection, StateEffect, StateField, type Extension } from '@codemirror/state';
import { RectangleMarker, layer, type EditorView } from '@codemirror/view';
import { documentPathField } from '../json-fence';
import { isMarkdownBuffer } from '../file-language';
import { linkControlOf } from './open-link';
import { linkMarkdownFor } from '../../links/link-destination';
import type { LinkProject } from '../../links/types';

/** One file a drop links to (file-links D7). `title`: a stash note's title, its label. */
export interface LinkInsertItem {
  path: string;
  title: string | null;
}

/** Where a link-mode drag would drop; `null` hides the caret. */
export const setLinkDropCaret = StateEffect.define<number | null>();

/**
 * The drop caret's position. Mapped through edits, so it also holds the
 * insertion point while the drop waits for `LinkControl.project` (R4).
 */
export const linkDropCaretField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLinkDropCaret)) return effect.value;
    }
    return value !== null && tr.docChanged ? tr.changes.mapPos(value) : value;
  },
});

/**
 * Drawn like CM6's own `dropCursor()` — a `.cm-dropCursor` marker, which the
 * editor theme already styles — but driven by our pointer drags, which are
 * not HTML5 drag-and-drop and so never reach `dropCursor()`.
 */
const linkDropCaretLayer = layer({
  above: true,
  class: 'cm-md-link-drop',
  update: (update) =>
    update.state.field(linkDropCaretField, false) !== update.startState.field(linkDropCaretField, false) ||
    update.docChanged ||
    update.geometryChanged,
  markers(view) {
    const pos = view.state.field(linkDropCaretField, false);
    if (pos === null || pos === undefined) return [];
    return RectangleMarker.forRange(view, 'cm-dropCursor', EditorSelection.cursor(pos));
  },
});

/** Installed by `createExtensions` together with a `LinkControl`. */
export const linkDropCaret: Extension = [linkDropCaretField, linkDropCaretLayer];

/** One link per item, separated by `, ` (several Finder files, several tabs). */
export function linkTextFor(items: readonly LinkInsertItem[], docPath: string | null, projectRoot: string | null): string {
  return items.map((item) => linkMarkdownFor(item, docPath, projectRoot)).join(', ');
}

/** R5: a space where the drop point touches a word — none before closing punctuation. */
export function padLink(text: string, before: string, after: string): string {
  const left = before !== '' && !/\s/.test(before) ? ' ' : '';
  const right = after !== '' && !/[\s.,;:!?)\]]/.test(after) ? ' ' : '';
  return `${left}${text}${right}`;
}

/**
 * Tauri's drop position → the page's CSS px: divide by the page zoom only.
 *
 * Typed `PhysicalPosition`, but on macOS it is logical points relative to
 * the webview: wry 0.54.4 `wkwebview/drag_drop.rs` `perform_drag_operation`
 * builds it from `draggingLocation()` in NSView points
 * (`(dl.x, frame.size.height - dl.y)`), and tauri-runtime-wry 2.10.1
 * (`with_drag_drop_handler`, lib.rs ~4684) wraps that in a
 * `PhysicalPosition` without scaling it. Dividing by the display scale put a
 * 2× screen's link at half the coordinates. Page zoom (`WKWebView.pageZoom`)
 * still sits between a point and a CSS px.
 */
export function dropPointToClient(position: { x: number; y: number }, zoom: number): { x: number; y: number } {
  const factor = zoom > 0 ? zoom : 1;
  return { x: position.x / factor, y: position.y / factor };
}

/** Insert the links at `pos`; `false` (nothing changed) for a read-only document or no items. */
export function insertLinkAt(
  view: EditorView,
  pos: number,
  items: readonly LinkInsertItem[],
  project: LinkProject
): boolean {
  if (items.length === 0 || view.state.readOnly) return false;
  const at = Math.max(0, Math.min(pos, view.state.doc.length));
  const before = at > 0 ? view.state.sliceDoc(at - 1, at) : '';
  const after = view.state.sliceDoc(at, at + 1);
  const text = padLink(linkTextFor(items, project.docPath, project.projectRoot), before, after);
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    effects: setLinkDropCaret.of(null),
    userEvent: 'input.drop',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** What the drawer and the Finder drop handler need from the editor (D7). Coordinates are CSS px. */
export interface LinkDropTarget {
  /** Is (x, y) over text a link may be dropped into (R1)? */
  over(x: number, y: number): boolean;
  /** Show the drop caret at the text position under (x, y), or hide it when there is none. */
  hover(x: number, y: number): void;
  clear(): void;
  /** Insert links to `items` at (x, y). `true`: accepted (the insert follows the project answer). */
  drop(x: number, y: number, items: readonly LinkInsertItem[]): boolean;
}

export function createLinkDropTarget(currentView: () => EditorView | undefined): LinkDropTarget {
  /** R1: a markdown buffer, writable, with a `LinkControl`. */
  function usable(): EditorView | null {
    const view = currentView();
    if (!view || view.state.readOnly || !linkControlOf(view.state)) return null;
    return isMarkdownBuffer(view.state.field(documentPathField, false) ?? null) ? view : null;
  }

  function inside(view: EditorView, x: number, y: number): boolean {
    const r = view.scrollDOM.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function hit(x: number, y: number): { view: EditorView; pos: number } | null {
    const view = usable();
    if (!view || !inside(view, x, y)) return null;
    const pos = view.posAtCoords({ x, y });
    return pos === null ? null : { view, pos };
  }

  function clear(): void {
    const view = currentView();
    if (view && (view.state.field(linkDropCaretField, false) ?? null) !== null) {
      view.dispatch({ effects: setLinkDropCaret.of(null) });
    }
  }

  return {
    over(x, y) {
      const view = usable();
      return view !== null && inside(view, x, y);
    },
    hover(x, y) {
      const at = hit(x, y);
      if (!at) {
        clear();
        return;
      }
      if (at.view.state.field(linkDropCaretField, false) !== at.pos) {
        at.view.dispatch({ effects: setLinkDropCaret.of(at.pos) });
      }
    },
    clear,
    drop(x, y, items) {
      const at = items.length > 0 ? hit(x, y) : null;
      const control = at ? linkControlOf(at.view.state) : null;
      if (!at || !control) {
        clear();
        return false;
      }
      const { view, pos } = at;
      view.dispatch({ effects: setLinkDropCaret.of(pos) });
      const docPath = view.state.field(documentPathField, false) ?? null;
      void control
        .project(docPath)
        .catch((err: unknown): LinkProject => {
          console.warn('link_project failed, linking absolutely:', err);
          return { projectRoot: null, docPath };
        })
        .then((project) => {
          // A state swapped in meanwhile (another tab) has no caret: nothing lands there.
          const held = view.state.field(linkDropCaretField, false);
          if (held === null || held === undefined) return;
          insertLinkAt(view, held, items, project);
        });
      return true;
    },
  };
}
