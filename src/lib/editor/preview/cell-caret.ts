/**
 * Where a click inside a rendered table cell puts the caret (#53).
 *
 * ## The bug this exists to close
 *
 * A table is drawn by one `Decoration.replace` widget sitting on the header
 * line; every other row is a real document line hidden at `height: 0`. So a
 * point inside the table has no document position CM6 can resolve it to: for a
 * replaced range `posAtCoords` answers the range's `from` or its `to` depending
 * on which half of the widget was hit. Measured on `main`, clicking a cell in
 * the left half of a table put `state.selection.main.head` at the table's first
 * character and clicking one on the right put it at the end of the header line
 * — and the next keystroke wrote there, wrecking the header row.
 *
 * Clicks on the cell's *glyphs* took a different route with the same ending:
 * the text span is a nested editing host and the widget returns `true` from
 * `ignoreEvent` for it, so CM6 processed nothing at all and the document
 * selection kept whatever it held before — stale, and invisible to the user.
 *
 * ## Where the caret should go instead
 *
 * Into the cell that was clicked, at the character that was clicked. That has
 * two halves, because a table cell has two selections (see
 * `preview/CLAUDE.md`):
 *
 * - **The DOM caret** goes into the cell's text host, which is what the user
 *   sees blinking. For a click on the glyphs the browser already puts it there;
 *   for a click on the cell's padding, or on an empty cell, nothing would, so
 *   {@link placeCaretFromPoint} does it.
 * - **The document selection** follows it to the matching offset in the cell's
 *   markdown source, so that everything asking "where is the user" gets an
 *   answer inside the cell rather than a stale one somewhere else in the file.
 *
 * Neither of them makes the cell typable on its own — the host refuses every
 * input route by design. Typing is handed to the cell edit overlay, which owns
 * its text and commits it properly; `tables.ts` wires that up.
 */

import { sourceOffsetForVisibleCaret } from '../live-render/cell-anchor';

/**
 * Offset of a DOM position inside `host`, counted in rendered characters.
 *
 * Cell text is not one text node: inline formatting and comment highlights
 * split it into nested elements, so the count has to walk them.
 */
export function visibleOffsetIn(host: HTMLElement, node: Node, offset: number): number {
  if (node === host) {
    let len = 0;
    const upto = Math.max(0, Math.min(offset, host.childNodes.length));
    for (let i = 0; i < upto; i++) len += host.childNodes[i].textContent?.length ?? 0;
    return len;
  }
  if (!host.contains(node)) return 0;

  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let total = 0;
  let text = walker.nextNode();
  while (text) {
    if (text === node) return total + offset;
    total += text.textContent?.length ?? 0;
    text = walker.nextNode();
  }

  // An element node inside the host (a `<strong>`, say): count everything that
  // precedes it and treat the offset as a child index.
  if (node instanceof Element) {
    let len = 0;
    const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let t = walk.nextNode();
    while (t) {
      if (node.contains(t)) break;
      len += t.textContent?.length ?? 0;
      t = walk.nextNode();
    }
    return len;
  }
  return total;
}

/** Rendered-character offset of the collapsed DOM caret inside `host`, if any. */
export function caretOffsetIn(host: HTMLElement): number | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const { focusNode, focusOffset } = sel;
  if (!focusNode || !host.contains(focusNode)) return null;
  return visibleOffsetIn(host, focusNode, focusOffset);
}

/**
 * Put the DOM caret inside `host` at the point `(x, y)`.
 *
 * Used for the clicks the browser would not place a caret for at all: the
 * cell's padding, the gap between two cells, an empty cell. `caretRangeFromPoint`
 * answers with whatever is under the pixel, which outside the text span is some
 * other element entirely, so the result is only accepted when it lands inside
 * this host; otherwise the caret goes to the near end, chosen by which side of
 * the host's box the pointer is on.
 */
export function placeCaretFromPoint(host: HTMLElement, x: number, y: number): void {
  host.focus({ preventScroll: true });
  const sel = document.getSelection();
  if (!sel) return;

  const range = rangeFromPoint(x, y);
  if (range && host.contains(range.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }

  const rect = host.getBoundingClientRect();
  const atEnd = rect.width > 0 && x > rect.right;
  const fallback = document.createRange();
  fallback.selectNodeContents(host);
  fallback.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(fallback);
}

function rangeFromPoint(x: number, y: number): Range | null {
  // `caretRangeFromPoint` is the WebKit/Blink spelling and the only one WKWebView
  // has; `caretPositionFromPoint` is the standard one. Both are optional in the
  // DOM lib, hence the casts.
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === 'function') return doc.caretRangeFromPoint(x, y);
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/**
 * Document position for the caret currently sitting in `host`.
 *
 * `cellFrom` is `CellInfo.from`; the rendered offset is mapped through the same
 * token split that produced the DOM, so a caret drawn inside a bold word lands
 * inside the `**…**` rather than in front of it.
 */
export function docPosForCaretIn(
  host: HTMLElement,
  cellText: string,
  cellFrom: number
): number | null {
  const vis = caretOffsetIn(host);
  if (vis === null) return null;
  return cellFrom + sourceOffsetForVisibleCaret(cellText, vis);
}
