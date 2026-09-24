import { EditorState, type Extension } from '@codemirror/state';
import { createExtensions } from './setup';

/**
 * The one way the app makes an editor state: `createExtensions()` plus the
 * per-view `extras` (Editor.svelte's listeners), caret at `cursor` clamped
 * into the document, or at its end when `null`.
 *
 * Every document load — a new tab, a tab whose file changed on disk, a
 * restored untitled buffer — gets a state from here, which is why a load can
 * never leak undo history from the previous document.
 */
export function createDocumentState(
  doc: string,
  cursor: number | null,
  extras: readonly Extension[]
): EditorState {
  const anchor = cursor === null ? doc.length : Math.max(0, Math.min(cursor, doc.length));
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [...createExtensions(), ...extras],
  });
}
