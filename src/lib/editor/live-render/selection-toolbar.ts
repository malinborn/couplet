import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { ViewPlugin } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  toggleInlineFormat,
  toggleInlineFormatAt,
  toggleInlineFormatInText,
  toggleLink,
  isInlineFormatActive,
  isInlineFormatActiveInText,
  isLinkActive,
  type InlineFormatKind,
} from './format-commands';
import { WIDGET_TEXT_HOST_SELECTOR } from '../widget-text-selection';
import { sourceRangeForVisible } from './cell-anchor';
import { INLINE_FORMAT_BINDINGS } from '../keybindings';
import {
  acceleratorAriaKeyShortcuts,
  acceleratorLabel,
  ariaKeyShortcuts,
  hotkeyLabel,
} from '../hotkey-label';
import { nativeAccelerator } from '../native-menu-accelerators';
import {
  activeCellEditSession,
  onCellEditChange,
  type CellEditSession,
} from '../cell-edit-session';
import { attachHotkeyTooltips, type TooltipHost } from './toolbar-tooltip';
import { t } from '../../i18n';
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
 * than by CM6, so the rect has to come from the DOM selection.
 *
 * `cell-edit` is a selection inside a table cell's edit overlay (#60). Its
 * `from`/`to` are offsets into the overlay's own text, which the document does
 * not hold yet — so every button here goes through `session`, not through the
 * document. Reached by double-clicking a cell, which is also the universal
 * select-a-word gesture, so it is not a mode the user has chosen to be in.
 */
type ToolbarKind = 'doc' | 'widget' | 'cell-edit';

interface ToolbarTarget {
  kind: ToolbarKind;
  from: number;
  to: number;
  /** Live reference rect — every kind CM6's `coordsAtPos` cannot answer for. */
  rect?: () => DOMRect;
  /** The open cell edit overlay — `cell-edit` targets only. */
  session?: CellEditSession;
}

let activePopup: HTMLElement | null = null;
let activeButtons: HTMLButtonElement[] = [];
let activeEditorDom: HTMLElement | null = null;
let activeKind: ToolbarKind | null = null;
let activeTarget: ToolbarTarget | null = null;
let activeTooltips: TooltipHost | null = null;

function hidePopup(): void {
  activeTooltips?.destroy();
  activeTooltips = null;
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
  // The cell edit overlay hangs off `document.body`, not off the editor, so
  // the check above does not cover it. Clicking inside the overlay is how a
  // selection is made there; treating it as an outside click closed the
  // toolbar on the very click that opened it.
  if (activeCellEditSession()?.textarea.contains(target)) return;
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

  // Snapshotted rather than re-read on demand: any change rebuilds the row's
  // widget and takes this DOM selection with it, so a live getter would answer
  // for a range that no longer exists.
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return {
    kind: 'widget',
    from: cellFrom + mapped.from,
    to: cellFrom + mapped.to,
    rect: () => rect,
  };
}

/**
 * A selection inside the open table-cell edit overlay.
 *
 * The overlay is a `<textarea>`, so its selection is invisible to both
 * `state.selection` and `document.getSelection()` — `selectionStart`/`End` are
 * the only place it exists. It is also outside `view.dom` entirely, which is
 * why the focus test here asks about the element rather than about the editor.
 */
function cellEditTarget(view: EditorView): ToolbarTarget | null {
  const session = activeCellEditSession();
  if (!session) return null;

  const ta = session.textarea;
  const doc = ta.ownerDocument;
  if (!doc.hasFocus() || doc.activeElement !== ta) return null;

  const from = ta.selectionStart;
  const to = ta.selectionEnd;
  if (to <= from) return null;

  return {
    kind: 'cell-edit',
    from,
    to,
    session,
    // Anchored to the whole overlay, not to the selected words: a textarea
    // exposes no geometry for a range, and the mirror-div trick that would
    // fake one has to re-derive wrapping from CSS to be right. The overlay is
    // cell-sized, so the toolbar still lands on the text it acts on.
    rect: () => ta.getBoundingClientRect(),
  };
}

/** The selection the toolbar should be acting on right now, if any. */
function currentTarget(view: EditorView): ToolbarTarget | null {
  // Order matters: while the overlay is open it holds both the focus and the
  // authoritative text, and the document selection underneath it is stale.
  const cellEdit = cellEditTarget(view);
  if (cellEdit) return cellEdit;

  const widget = widgetTarget(view);
  if (widget) return widget;

  const range = view.state.selection.main;
  if (range.empty || !view.hasFocus) return null;
  return { kind: 'doc', from: range.from, to: range.to };
}

interface FormatButtonSpec {
  kind: InlineFormatKind;
  label: string;
  /**
   * An i18n key, not literal text — this array is module-level, evaluated
   * before `main.ts` installs the catalog, so a literal string here would
   * freeze in whatever language happened to be active at import time
   * (normally none yet). Resolved with `t()` at the point of use, in
   * `buildPopup`, which runs well after boot.
   */
  ariaLabelKey: string;
  cssClass: string;
}

/**
 * Key spec per format, read straight out of the keymap's own table so the
 * tooltip cannot name a key the editor no longer listens for (#56).
 * `inlineCode` is absent on purpose — it has no binding, and inventing one
 * here would be exactly the drift this lookup exists to prevent.
 */
const KEY_FOR_FORMAT = new Map(INLINE_FORMAT_BINDINGS.map((b) => [b.kind as string, b.key]));

const FORMAT_BUTTONS: FormatButtonSpec[] = [
  {
    kind: 'strong',
    label: 'B',
    ariaLabelKey: 'editor.selection_toolbar.bold',
    cssClass: 'cm-selection-toolbar-btn-bold',
  },
  {
    kind: 'emphasis',
    label: 'I',
    ariaLabelKey: 'editor.selection_toolbar.italic',
    cssClass: 'cm-selection-toolbar-btn-italic',
  },
  {
    kind: 'strikethrough',
    label: 'S',
    ariaLabelKey: 'editor.selection_toolbar.strikethrough',
    cssClass: 'cm-selection-toolbar-btn-strike',
  },
  {
    kind: 'inlineCode',
    label: '</>',
    ariaLabelKey: 'editor.selection_toolbar.code',
    cssClass: 'cm-selection-toolbar-btn-code',
  },
];

/**
 * Caption for the hover tooltip.
 *
 * Buttons with no hotkey still get one. Two of them — `</>` and `💬` — are the
 * least self-explanatory things in the row, and the tooltip is the only place
 * that ever says what they are; withholding it precisely there would answer
 * the easy questions and none of the hard ones.
 */
function tooltipText(actionName: string, shortcut?: Shortcut): string {
  return shortcut ? `${actionName} ${shortcut.label}` : actionName;
}

/**
 * One rendered hotkey: what the tooltip prints and what `aria-keyshortcuts`
 * carries. Both notations in this app — the CM6 keymap's and the native menu's
 * — collapse to this before a button ever sees them, so two keys shown on the
 * same row cannot be rendered by two different rules.
 */
interface Shortcut {
  label: string;
  aria: string;
}

function fromKeymap(key: string | undefined): Shortcut | undefined {
  return key ? { label: hotkeyLabel(key), aria: ariaKeyShortcuts(key) } : undefined;
}

function fromNativeMenu(id: string): Shortcut | undefined {
  const accelerator = nativeAccelerator(id);
  return accelerator
    ? { label: acceleratorLabel(accelerator), aria: acceleratorAriaKeyShortcuts(accelerator) }
    : undefined;
}

function makeButton(
  label: string,
  ariaLabel: string,
  cssClass: string,
  kind: string,
  shortcut?: Shortcut
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `cm-selection-toolbar-btn ${cssClass}`;
  btn.textContent = label;
  btn.setAttribute('aria-label', ariaLabel);
  btn.setAttribute('aria-pressed', 'false');
  btn.dataset.kind = kind;
  btn.dataset.tooltip = tooltipText(ariaLabel, shortcut);
  // The tooltip is a pointer affordance; this is the same fact for a screen
  // reader, which never hovers anything.
  if (shortcut) btn.setAttribute('aria-keyshortcuts', shortcut.aria);
  return btn;
}

/**
 * Apply a format inside the cell edit overlay.
 *
 * The overlay's text is not in the document, so there is nothing for
 * `changeByRange` to act on — and writing a string-wrapping toggle here would
 * be a second "bold", diverging from the document's one on the first nested
 * case (#55's real objection). `toggleInlineFormatInText` instead runs the very
 * same `formatSpec` over a throwaway state built from this text.
 *
 * The toolbar deliberately stays open afterwards: unlike the widget path,
 * nothing was rebuilt, the same words are still selected, and the next click
 * should be able to put italic on top of the bold just applied.
 */
function applyFormatInOverlay(
  session: CellEditSession,
  kind: InlineFormatKind,
  from: number,
  to: number
): void {
  const result = toggleInlineFormatInText(session.textarea.value, kind, from, to);
  if (!result) return;
  session.replace(result.text, result.from, result.to);
}

function buildPopup(view: EditorView, kind: ToolbarKind): HTMLElement {
  const popup = document.createElement('div');
  popup.className = 'cm-selection-toolbar-popup';
  if (kind !== 'doc') popup.classList.add('cm-selection-toolbar-popup-widget');
  popup.setAttribute('role', 'toolbar');
  popup.setAttribute('aria-label', t('editor.selection_toolbar.group_label'));
  activeButtons = [];

  // Both kinds get the format buttons. A widget selection has no document
  // selection for `changeByRange` to act on — that is why it once got the
  // comment button and nothing else (#42) — but `cell-anchor.ts` has already
  // resolved it to a document range, and `toggleInlineFormatAt` applies the
  // same add/remove decision to an explicit range (#55).
  for (const spec of FORMAT_BUTTONS) {
    const btn = makeButton(
      spec.label,
      t(spec.ariaLabelKey),
      spec.cssClass,
      spec.kind,
      fromKeymap(KEY_FOR_FORMAT.get(spec.kind))
    );
    btn.addEventListener('mousedown', (e) => {
      // preventDefault keeps focus (and the selection) where it is — in the
      // editor, or in the cell edit overlay. Same trick hover-menu.ts uses for
      // its gutter buttons. It is also what stops the overlay's blur handler
      // from committing the cell out from under the click.
      e.preventDefault();
      const target = activeTarget;
      if (target?.kind === 'cell-edit' && target.session) {
        applyFormatInOverlay(target.session, spec.kind, target.from, target.to);
        return;
      }
      if (target?.kind === 'widget') {
        toggleInlineFormatAt(view, spec.kind, target.from, target.to);
        // The change rebuilds the row's widget, which takes the DOM selection
        // with it: the rect this popup is pinned to no longer describes
        // anything on screen. Closing is honest; `sync()` would close it a
        // moment later anyway, having flashed it over the wrong words first.
        hidePopup();
        view.focus();
        return;
      }
      toggleInlineFormat(view, spec.kind);
      view.focus();
    });
    popup.appendChild(btn);
    activeButtons.push(btn);
  }

  {
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
    commentBtn.setAttribute('aria-label', t('editor.selection_toolbar.comment'));
    // The one key on this row declared in the native menu rather than in the
    // keymap, which is why the tooltip read "Comment" with no key at all while
    // ⌘⇧M worked (#59).
    const commentShortcut = fromNativeMenu('ai_comment');
    commentBtn.dataset.tooltip = tooltipText(t('editor.selection_toolbar.comment_tooltip'), commentShortcut);
    if (commentShortcut) commentBtn.setAttribute('aria-keyshortcuts', commentShortcut.aria);
    commentBtn.addEventListener('mousedown', (e) => {
      // Same preventDefault reason as the format buttons: the selection must
      // survive the click, since it is what the comment anchors to.
      e.preventDefault();
      const target = activeTarget;
      // A comment anchors to a range in the *document*. While a cell edit
      // overlay is open the document still holds the cell's previous text, so
      // the overlay is committed first and the selection carried across the
      // encoding — otherwise the anchor names characters that are not in the
      // file, and the re-anchor search on the next open finds nothing. The
      // commit is exactly what a click anywhere else would have done anyway,
      // which is why this is not a surprise rather than a disabled button.
      if (target?.kind === 'cell-edit' && target.session) {
        const range = target.session.commitAndMap(target.from, target.to);
        hidePopup();
        onCommentRef?.(range);
        return;
      }
      // A widget selection is invisible to `view.state.selection`, so the
      // resolved document range travels with the call. `undefined` keeps the
      // document path reading the live selection, as it always has.
      const range = target?.kind === 'widget' ? { from: target.from, to: target.to } : undefined;
      onCommentRef?.(range);
      hidePopup();
    });
    popup.appendChild(commentBtn);

    if (kind === 'doc') {
      const commentDivider = document.createElement('div');
      commentDivider.className = 'cm-selection-toolbar-divider';
      popup.appendChild(commentDivider);
    }
  }

  // Link stays out of the widget toolbar, and not for want of a range to wrap.
  // `toggleLink` fires `openInspectorFor`, and the inspector pins its URL panel
  // with `view.coordsAtPos` — which for text drawn by a table-row widget
  // answers for the widget's own document position, i.e. the top-left of the
  // whole table, not the cell under the pointer. The link would be created
  // correctly and its editor would open somewhere else entirely. Giving the
  // inspector a rect-based reference, the way `positionPopup` already has one,
  // is the fix; it is a change to the inspector, not to this button.
  if (kind === 'doc') {
    const linkLabel = t('editor.selection_toolbar.link');
    const linkBtn = makeButton(linkLabel, linkLabel, 'cm-selection-toolbar-btn-link', 'link');
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

function updateButtonStates(view: EditorView, target: ToolbarTarget): void {
  const { from, to } = target;
  const overlayText =
    target.kind === 'cell-edit' ? (target.session?.textarea.value ?? null) : null;

  for (const btn of activeButtons) {
    const kind = btn.dataset.kind;
    if (!kind) continue;
    const active =
      kind === 'link'
        ? isLinkActive(view.state, from, to)
        : overlayText !== null
          ? // The same question, asked of the text the user is looking at.
            isInlineFormatActiveInText(overlayText, kind as InlineFormatKind, from, to)
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
  rect: () => DOMRect
): { getBoundingClientRect(): DOMRect; contextElement: Element } {
  return {
    contextElement: view.dom,
    getBoundingClientRect: rect,
  };
}

function positionPopup(view: EditorView, target: ToolbarTarget): void {
  if (!activePopup) return;
  const popup = activePopup;
  const reference = target.rect
    ? rectReference(view, target.rect)
    : selectionReference(view, target.from, target.to);

  computePosition(reference, popup, {
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  }).then(({ x, y, placement }) => {
    // Popup may have been dismissed while computePosition was pending.
    if (activePopup !== popup) return;
    Object.assign(popup.style, { left: `${x}px`, top: `${y}px` });
    // Tooltips follow the toolbar away from the text: when `flip()` has put
    // the toolbar below the selection, a tooltip above it would sit right on
    // the words the toolbar is there to format.
    activeTooltips?.setPlacement(placement.startsWith('bottom') ? 'bottom' : 'top');
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
    activeTooltips = attachHotkeyTooltips(activePopup);
    // Registered synchronously: onOutsideClick now ignores clicks inside the
    // editor, so there is no self-inflicted close to defer around.
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }
  activeTarget = target;
  updateButtonStates(view, target);
  positionPopup(view, target);
}

class SelectionToolbarPlugin {
  private readonly view: EditorView;
  /**
   * Focus leaving the editor normally means the toolbar has nothing left to
   * sit over — but opening a cell edit overlay moves focus out of `view.dom`
   * by design, and that is precisely when the toolbar must stay available. So
   * this re-resolves the target instead of hiding unconditionally.
   */
  private readonly onBlur = (): void => this.sync();
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
  /**
   * A cell edit overlay is a `<textarea>` outside `view.dom` entirely, so
   * neither `update()` nor `selectionchange` on the document reliably sees its
   * selection move. `cell-edit-session.ts` watches the element itself and
   * reports here — including when the overlay opens and when it closes.
   */
  private readonly unsubscribeCellEdit: () => void;

  constructor(view: EditorView) {
    this.view = view;
    view.dom.addEventListener('blur', this.onBlur);
    view.dom.ownerDocument.addEventListener('selectionchange', this.onSelectionChange);
    view.dom.ownerDocument.defaultView?.addEventListener('blur', this.onWindowBlur);
    this.unsubscribeCellEdit = onCellEditChange(() => this.sync());
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
    this.unsubscribeCellEdit();
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
