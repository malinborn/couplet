import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { ViewPlugin } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  toggleInlineFormat,
  toggleLink,
  isInlineFormatActive,
  isLinkActive,
  type InlineFormatKind,
} from './format-commands';
import { WIDGET_TEXT_HOST_SELECTOR } from '../widget-text-selection';
import { sourceRangeForVisible } from './cell-anchor';
import '../../../styles/live-render.css';

/**
 * Floating toolbar shown over a non-empty selection in live-render mode,
 * where markdown markers are permanently hidden and can no longer be typed
 * by hand. Same bare-DOM + `@floating-ui/dom` approach as `hover-menu.ts` —
 * this is CM6-layer UI, not a Svelte component.
 */

/**
 * What the toolbar is currently acting on.
 *
 * `doc` is the ordinary case: a selection in the document, positioned with
 * `coordsAtPos` and offering the full set of format buttons.
 *
 * `widget` is a selection inside a nested editing host — today, table cell text
 * (#31, #42). Its `from`/`to` are still document positions, resolved back
 * through `cell-anchor.ts`, but the text on screen is drawn by a widget rather
 * than by CM6, so the rect has to come from the DOM selection and the format
 * buttons have nothing to act on. Comment-only.
 */
interface ToolbarTarget {
  kind: 'doc' | 'widget';
  from: number;
  to: number;
  /** DOM rect of the selection — `widget` targets only. */
  rect?: DOMRect;
}

let activePopup: HTMLElement | null = null;
let activeButtons: HTMLButtonElement[] = [];
let activeEditorDom: HTMLElement | null = null;
let activeKind: ToolbarTarget['kind'] | null = null;
let activeTarget: ToolbarTarget | null = null;

function hidePopup(): void {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
    activeButtons = [];
  }
  activeKind = null;
  activeTarget = null;
  activeEditorDom = null;
  document.removeEventListener('click', onOutsideClick, true);
  document.removeEventListener('keydown', onKeydown, true);
}

function onOutsideClick(e: MouseEvent): void {
  if (!activePopup) return;
  const target = e.target as Node;
  if (activePopup.contains(target)) return;
  // A click inside the editor is exactly what creates or clears a selection,
  // and the plugin's update() already hides the toolbar the moment the
  // selection collapses. Counting it as an outside click closed the toolbar on
  // the very mouseup that produced the selection: drag-selecting fires
  // selectionSet on mousemove, so the listener is already armed by the time
  // the trailing click arrives, and the toolbar flashed and vanished while the
  // selection was still there.
  if (activeEditorDom?.contains(target)) return;
  hidePopup();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && activePopup) {
    e.preventDefault();
    e.stopPropagation();
    hidePopup();
  }
}

/**
 * Offsets of the DOM selection within `host`, in rendered characters.
 *
 * A `Range` collapsed onto the selection's start measures everything before it
 * in one step, which is the only reliable way to count across the element tree
 * `parseInlineMarkdown` builds (`<strong>`, `<code>`, `<a>`, bare text).
 */
function hostSelectionOffsets(host: HTMLElement): { from: number; to: number } | null {
  const doc = host.ownerDocument;
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  // A selection escaping the host has no single cell to anchor to.
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;

  const before = doc.createRange();
  before.selectNodeContents(host);
  before.setEnd(range.startContainer, range.startOffset);
  const from = before.toString().length;
  const to = from + range.toString().length;
  return to > from ? { from, to } : null;
}

/**
 * A selection living in one of this editor's nested editing hosts.
 *
 * The focus test is the whole point of this function. `view.hasFocus` requires
 * `activeElement === contentDOM`, which a nested host breaks by definition — so
 * it cannot be the question. But dropping the question entirely would pop the
 * toolbar up over a stale selection while the user is in another window or
 * another app. What is actually being asked is "does focus live in this
 * editor", which after #41 includes its hosts: the window must have focus, and
 * the focused element must be inside the host the selection is in, which in
 * turn must be inside this view.
 */
function widgetTarget(view: EditorView): ToolbarTarget | null {
  const doc = view.dom.ownerDocument;
  if (!doc.hasFocus()) return null;

  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el = node instanceof Element ? node : node.parentElement;
  const host = el?.closest<HTMLElement>(WIDGET_TEXT_HOST_SELECTOR);
  if (!host || !view.dom.contains(host)) return null;

  const active = view.root.activeElement;
  if (!active || !host.contains(active)) return null;

  // Hosts that render text from somewhere other than the document — a comment
  // card's quote — carry no source range, and nothing here can anchor to them.
  const cellFrom = Number(host.dataset.sourceFrom);
  const cellTo = Number(host.dataset.sourceTo);
  if (!Number.isFinite(cellFrom) || !Number.isFinite(cellTo)) return null;
  if (cellFrom < 0 || cellTo > view.state.doc.length || cellTo < cellFrom) return null;

  const offsets = hostSelectionOffsets(host);
  if (!offsets) return null;

  const cellText = view.state.sliceDoc(cellFrom, cellTo);
  const mapped = sourceRangeForVisible(cellText, offsets.from, offsets.to);
  if (!mapped) return null;

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return {
    kind: 'widget',
    from: cellFrom + mapped.from,
    to: cellFrom + mapped.to,
    rect,
  };
}

/** The selection the toolbar should be acting on right now, if any. */
function currentTarget(view: EditorView): ToolbarTarget | null {
  const widget = widgetTarget(view);
  if (widget) return widget;

  const range = view.state.selection.main;
  if (range.empty || !view.hasFocus) return null;
  return { kind: 'doc', from: range.from, to: range.to };
}

interface FormatButtonSpec {
  kind: InlineFormatKind;
  label: string;
  ariaLabel: string;
  cssClass: string;
}

const FORMAT_BUTTONS: FormatButtonSpec[] = [
  { kind: 'strong', label: 'B', ariaLabel: 'Bold', cssClass: 'cm-selection-toolbar-btn-bold' },
  { kind: 'emphasis', label: 'I', ariaLabel: 'Italic', cssClass: 'cm-selection-toolbar-btn-italic' },
  {
    kind: 'strikethrough',
    label: 'S',
    ariaLabel: 'Strikethrough',
    cssClass: 'cm-selection-toolbar-btn-strike',
  },
  {
    kind: 'inlineCode',
    label: '</>',
    ariaLabel: 'Code',
    cssClass: 'cm-selection-toolbar-btn-code',
  },
];

function makeButton(label: string, ariaLabel: string, cssClass: string, kind: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `cm-selection-toolbar-btn ${cssClass}`;
  btn.textContent = label;
  btn.setAttribute('aria-label', ariaLabel);
  btn.setAttribute('aria-pressed', 'false');
  btn.dataset.kind = kind;
  return btn;
}

function buildPopup(view: EditorView, kind: ToolbarTarget['kind']): HTMLElement {
  const popup = document.createElement('div');
  popup.className = 'cm-selection-toolbar-popup';
  if (kind === 'widget') popup.classList.add('cm-selection-toolbar-popup-widget');
  popup.setAttribute('role', 'toolbar');
  popup.setAttribute('aria-label', 'Text formatting');
  activeButtons = [];

  // Widget text is drawn by a widget, not by CM6: the format commands edit the
  // document through the selection, and there is no document selection here to
  // edit. Rewriting a table cell's source from a mapped range is a separate
  // feature, not a side effect of showing this toolbar — so a selection in a
  // cell gets the comment button and nothing else.
  for (const spec of kind === 'widget' ? [] : FORMAT_BUTTONS) {
    const btn = makeButton(spec.label, spec.ariaLabel, spec.cssClass, spec.kind);
    btn.addEventListener('mousedown', (e) => {
      // preventDefault keeps focus (and the selection) in the editor —
      // same trick hover-menu.ts uses for its gutter buttons.
      e.preventDefault();
      toggleInlineFormat(view, spec.kind);
      view.focus();
    });
    popup.appendChild(btn);
    activeButtons.push(btn);
  }

  if (kind !== 'widget') {
    const divider = document.createElement('div');
    divider.className = 'cm-selection-toolbar-divider';
    popup.appendChild(divider);
  }

  // Commenting on a selection belongs here more than anywhere else — this
  // toolbar is already the answer to "I have selected something, now what".
  // `dataset.kind` is deliberately left unset: `updateButtonStates` iterates
  // the buttons and asks whether each format is active, and a comment has no
  // active state to report.
  if (onCommentRef) {
    const commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.className = 'cm-selection-toolbar-btn cm-selection-toolbar-btn-comment';
    commentBtn.textContent = '💬';
    commentBtn.setAttribute('aria-label', 'Comment on selection');
    commentBtn.addEventListener('mousedown', (e) => {
      // Same preventDefault reason as the format buttons: the selection must
      // survive the click, since it is what the comment anchors to.
      e.preventDefault();
      // A widget selection is invisible to `view.state.selection`, so the
      // resolved document range travels with the call. `undefined` keeps the
      // document path reading the live selection, as it always has.
      const range =
        activeTarget?.kind === 'widget'
          ? { from: activeTarget.from, to: activeTarget.to }
          : undefined;
      onCommentRef?.(range);
      hidePopup();
    });
    popup.appendChild(commentBtn);

    if (kind !== 'widget') {
      const commentDivider = document.createElement('div');
      commentDivider.className = 'cm-selection-toolbar-divider';
      popup.appendChild(commentDivider);
    }
  }

  if (kind !== 'widget') {
    const linkBtn = makeButton('Link', 'Link', 'cm-selection-toolbar-btn-link', 'link');
    linkBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      toggleLink(view);
      view.focus();
    });
    popup.appendChild(linkBtn);
    activeButtons.push(linkBtn);
  }

  return popup;
}

function updateButtonStates(view: EditorView, from: number, to: number): void {
  for (const btn of activeButtons) {
    const kind = btn.dataset.kind;
    if (!kind) continue;
    const active =
      kind === 'link'
        ? isLinkActive(view.state, from, to)
        : isInlineFormatActive(view.state, kind as InlineFormatKind, from, to);
    btn.setAttribute('aria-pressed', String(active));
  }
}

/**
 * A `VirtualElement` (per `@floating-ui/dom`) spanning the current
 * selection, built from `coordsAtPos` on its two ends. Falls back to a
 * zero-size rect at the editor's top-left if either end has scrolled out
 * of the rendered viewport, so `computePosition` always has something to
 * work with.
 */
function selectionReference(
  view: EditorView,
  from: number,
  to: number
): { getBoundingClientRect(): DOMRect; contextElement: Element } {
  return {
    contextElement: view.dom,
    getBoundingClientRect(): DOMRect {
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to, -1);
      if (!start || !end) {
        const editorRect = view.dom.getBoundingClientRect();
        return new DOMRect(editorRect.left, editorRect.top, 0, 0);
      }
      const left = Math.min(start.left, end.left);
      const right = Math.max(start.right, end.right);
      const top = Math.min(start.top, end.top);
      const bottom = Math.max(start.bottom, end.bottom);
      return new DOMRect(left, top, right - left, bottom - top);
    },
  };
}

/**
 * Reference rect for a selection CM6 cannot map: the rendered text belongs to a
 * widget, so `coordsAtPos` would answer for the widget's document position —
 * the top-left of the whole table — instead of the words under the pointer.
 * The DOM selection already knows exactly where it is.
 */
function rectReference(
  view: EditorView,
  rect: DOMRect
): { getBoundingClientRect(): DOMRect; contextElement: Element } {
  return {
    contextElement: view.dom,
    getBoundingClientRect: () => rect,
  };
}

function positionPopup(view: EditorView, target: ToolbarTarget): void {
  if (!activePopup) return;
  const popup = activePopup;
  const reference =
    target.kind === 'widget' && target.rect
      ? rectReference(view, target.rect)
      : selectionReference(view, target.from, target.to);

  computePosition(reference, popup, {
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    // Popup may have been dismissed while computePosition was pending.
    if (activePopup !== popup) return;
    Object.assign(popup.style, { left: `${x}px`, top: `${y}px` });
  });
}

function showToolbar(view: EditorView, target: ToolbarTarget): void {
  // A doc toolbar cannot be reused for a widget selection or the other way
  // round — they carry different buttons.
  if (activePopup && activeKind !== target.kind) hidePopup();
  if (!activePopup) {
    activePopup = buildPopup(view, target.kind);
    activeKind = target.kind;
    activeEditorDom = view.dom;
    document.body.appendChild(activePopup);
    // Registered synchronously: onOutsideClick now ignores clicks inside the
    // editor, so there is no self-inflicted close to defer around.
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }
  activeTarget = target;
  updateButtonStates(view, target.from, target.to);
  positionPopup(view, target);
}

class SelectionToolbarPlugin {
  private readonly view: EditorView;
  private readonly onBlur = (): void => hidePopup();
  /**
   * A selection inside a nested editing host produces **no** `ViewUpdate`:
   * the widget returns `true` from `ignoreEvent`, so CM6 never processes the
   * drag and `state.selection` keeps whatever it held before (measured: still
   * the previous prose selection while a cell selection was live). `update()`
   * alone therefore cannot see this selection appear — or disappear.
   */
  private readonly onSelectionChange = (): void => this.sync();
  /**
   * The window losing focus does not reach `update()` either, for the same
   * reason, and a toolbar left over a selection the user can no longer see is
   * exactly what the focus condition exists to prevent.
   */
  private readonly onWindowBlur = (): void => this.sync();

  constructor(view: EditorView) {
    this.view = view;
    view.dom.addEventListener('blur', this.onBlur);
    view.dom.ownerDocument.addEventListener('selectionchange', this.onSelectionChange);
    view.dom.ownerDocument.defaultView?.addEventListener('blur', this.onWindowBlur);
  }

  private sync(): void {
    const target = currentTarget(this.view);
    if (!target) {
      hidePopup();
      return;
    }
    showToolbar(this.view, target);
  }

  update(update: ViewUpdate): void {
    if (!update.selectionSet && !update.docChanged && !update.focusChanged) return;
    // Deliberately routed through the same resolution as `selectionchange`:
    // a live widget selection outranks the document selection, which during a
    // cell drag is stale rather than empty, and would otherwise hide the
    // toolbar the drag just opened.
    this.sync();
  }

  destroy(): void {
    this.view.dom.removeEventListener('blur', this.onBlur);
    this.view.dom.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange);
    this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.onWindowBlur);
    hidePopup();
  }
}

/**
 * Callback for the comment button, supplied by the app.
 *
 * Module-level rather than carried on the plugin, because the popup is built
 * lazily from `buildPopup` deep inside this module and the DOM here is bare,
 * not a component tree. Set once per editor configuration; there is only ever
 * one popup on screen.
 */
let onCommentRef: ((range?: { from: number; to: number }) => void) | null = null;

export function selectionToolbar(options?: {
  onComment?: (range?: { from: number; to: number }) => void;
}): Extension {
  onCommentRef = options?.onComment ?? null;
  return ViewPlugin.fromClass(SelectionToolbarPlugin);
}
