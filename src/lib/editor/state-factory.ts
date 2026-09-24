import { EditorState, type Extension } from '@codemirror/state';
import { createExtensions, type EditorDeps } from './setup';
import { normalizeLineEndings } from '../line-endings';

/**
 * The one way the app makes an editor state: `createExtensions(deps)` plus the
 * per-view `extras` (Editor.svelte's listeners), caret at `cursor` clamped
 * into the document, or at its end when `null`.
 *
 * Every document load — a new tab, a tab whose file changed on disk, a
 * restored untitled buffer — gets a state from here, which is why a load can
 * never leak undo history from the previous document.
 *
 * The caret is clamped against the LF text CM6 will actually hold, not the
 * input string: CM6 splits on `\r\n` and lone `\r` too, so a CRLF string is
 * longer than its document by one character per line, and an anchor at its
 * length throws `RangeError: Selection points outside of document`. Callers
 * pass text from `readDocument`, already normalized — this is the backstop
 * (see `line-endings.ts`).
 */
export function createDocumentState(
  doc: string,
  cursor: number | null,
  extras: readonly Extension[],
  deps: EditorDeps = {}
): EditorState {
  const text = normalizeLineEndings(doc);
  const anchor = cursor === null ? text.length : Math.max(0, Math.min(cursor, text.length));
  return EditorState.create({
    doc: text,
    selection: { anchor },
    extensions: [...createExtensions(deps), ...extras],
  });
}
