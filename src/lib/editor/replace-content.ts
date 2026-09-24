import { Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';

/**
 * The transaction `EditorHandle.replaceContent` dispatches: swap the whole
 * document, caret at the end, outside the undo history.
 *
 * Pure so it can be tested against a bare `EditorState`, and so the one fact
 * that matters here is written down in one place: the caret is placed from the
 * length of the document CM6 will actually build, never from the input
 * string. CM6 splits on `\r\n` and lone `\r` as well as `\n`, so for a CRLF
 * file the document is shorter than the string by one character per line —
 * and an anchor at `newContent.length` threw `RangeError: Selection points
 * outside of document`, which is what turned opening any Windows file into an
 * empty Untitled window. Callers are expected to pass LF text already
 * (`readDocument` normalizes at the disk boundary); this keeps a stray `\r`
 * from ever being fatal again.
 */
export function replaceContentSpec(state: EditorState, newContent: string): TransactionSpec {
  const text = state.toText(newContent);
  return {
    changes: { from: 0, to: state.doc.length, insert: text },
    selection: text.length > 0 ? { anchor: text.length } : undefined,
    annotations: Transaction.addToHistory.of(false),
  };
}
