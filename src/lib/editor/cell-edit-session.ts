/**
 * The one table-cell edit overlay that can be open at a time, published so UI
 * outside `preview/tables.ts` can act on it.
 *
 * Today that means the live-render selection toolbar (#60): falling into edit
 * mode is a double-click, which is also the universal select-a-word gesture,
 * so a user formatting text has no reason to know which of the two surfaces
 * their selection is on — and the toolbar has to work on both.
 *
 * This module is deliberately neutral ground. `preview/tables.ts` owns the
 * overlay and `live-render/selection-toolbar.ts` acts on it; having either one
 * import the other would tie the shared table renderer to a beta-only mode.
 */

/** A cell edit overlay, as far as anything outside `tables.ts` needs it. */
export interface CellEditSession {
  /**
   * The overlay element. Its `value` is the cell's **source**, decoded for
   * editing (`table-encoding.ts`) — not the rendered text, and not what the
   * document currently holds for this cell.
   */
  textarea: HTMLTextAreaElement;
  /**
   * Replace the overlay's text and reselect `[from, to]` in the new text.
   * Goes through the browser's own editing pipeline where it can, so the
   * textarea's native undo stack survives — see `applyTextareaEdit`.
   */
  replace(text: string, from: number, to: number): void;
  /**
   * Commit the overlay into the document, then map an overlay range onto the
   * document range that text now occupies.
   *
   * The overlay is gone afterwards. This exists for the comment button, which
   * anchors to a document range: while the overlay is open the document still
   * holds the cell's previous text, so an anchor made without committing would
   * point at characters that are not in the file.
   */
  commitAndMap(from: number, to: number): { from: number; to: number };
}

/** Events that can move a selection inside a textarea, across engines. */
const SELECTION_EVENTS = [
  // Fired at the element for input/textarea per the HTML spec. Engine support
  // is uneven enough (and recent enough) that it cannot be the only source.
  'selectionchange',
  'select',
  'keyup',
  'mouseup',
  'input',
  'focus',
  'blur',
] as const;

const listeners = new Set<() => void>();
let active: CellEditSession | null = null;
let detach: (() => void) | null = null;

function emit(): void {
  for (const fn of [...listeners]) fn();
}

/** Publish (or clear) the open overlay. Notifies subscribers either way. */
export function setCellEditSession(session: CellEditSession | null): void {
  detach?.();
  detach = null;
  active = session;

  if (session) {
    const ta = session.textarea;
    const onChange = (): void => emit();
    for (const name of SELECTION_EVENTS) ta.addEventListener(name, onChange);
    detach = (): void => {
      for (const name of SELECTION_EVENTS) ta.removeEventListener(name, onChange);
    };
  }

  emit();
}

/**
 * Clear the published session, but only if `textarea` is still the published
 * one.
 *
 * Double-clicking a second cell removes the first overlay from the DOM
 * immediately, while its own blur-triggered commit is still 50ms out. An
 * unconditional clear from that late commit would unpublish the overlay the
 * user is now typing in.
 */
export function endCellEditSession(textarea: HTMLTextAreaElement): void {
  if (active?.textarea === textarea) setCellEditSession(null);
}

export function activeCellEditSession(): CellEditSession | null {
  return active;
}

/** Subscribe to "the overlay appeared, vanished, or its selection moved". */
export function onCellEditChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The smallest single replacement turning `oldText` into `newText`. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Narrow a whole-string rewrite down to the span that actually changed.
 *
 * Applied through `execCommand('insertText')` this is what keeps Cmd+Z inside
 * the overlay meaning "undo the format I just applied" rather than "restore the
 * entire cell": assigning `textarea.value` wipes the element's native undo
 * stack outright, so the user's own typing before the toggle becomes
 * un-undoable too.
 */
export function minimalEdit(oldText: string, newText: string): TextEdit | null {
  if (oldText === newText) return null;

  const max = Math.min(oldText.length, newText.length);

  let start = 0;
  while (start < max && oldText[start] === newText[start]) start++;

  // Bounded by what the common prefix left, so prefix and suffix cannot
  // overlap on a string that repeats (`**` -> `****`).
  let end = 0;
  while (
    end < max - start &&
    oldText[oldText.length - 1 - end] === newText[newText.length - 1 - end]
  ) {
    end++;
  }

  return {
    from: start,
    to: oldText.length - end,
    insert: newText.slice(start, newText.length - end),
  };
}

/**
 * Write `text` into `ta` and select `[from, to]`, preserving native undo when
 * the engine lets us.
 *
 * `execCommand` is deprecated and is still the only way to put an edit on a
 * textarea's own undo stack; both engines this app runs in implement it. The
 * assignment fallback is correct, just lossier, and is what runs under jsdom.
 */
export function applyTextareaEdit(
  ta: HTMLTextAreaElement,
  text: string,
  from: number,
  to: number
): void {
  const edit = minimalEdit(ta.value, text);
  if (edit) {
    let applied = false;
    const doc = ta.ownerDocument;
    if (typeof doc.execCommand === 'function') {
      ta.focus();
      ta.setSelectionRange(edit.from, edit.to);
      try {
        applied =
          edit.insert === ''
            ? doc.execCommand('delete')
            : doc.execCommand('insertText', false, edit.insert);
      } catch {
        applied = false;
      }
    }
    if (!applied || ta.value !== text) ta.value = text;
  }
  ta.setSelectionRange(from, to);
}
