import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';

/**
 * Per-state read-only switch. Its own compartment, like `lineGlowCompartment`,
 * rather than part of the preview configuration: the preview compartment is
 * rebuilt by `setCodeMode`, by the engine (Raw empties it) and by every kind,
 * and a read-only flag riding along would have to be re-added on each path.
 * Each tab has its own `EditorState`, so the value never leaks into another
 * tab; `applyDocumentConfig` (App.svelte) sets it on every swap, so a tab
 * coming back gets exactly its own answer.
 */
export const readOnlyCompartment = new Compartment();

/**
 * A document the human can read, select and copy but not change — today a
 * CSV too large for the table view (`csvOpensReadOnly`).
 *
 * `EditorState.readOnly` stops what honours it: typing, paste, drop, undo and
 * redo, and CM6's own commands. App commands that dispatch changes without
 * asking (⌘B and the other formatting keys, the gutter "+") are stopped by the
 * filter. A buffer replaced from disk (`updateContent`, `addToHistory: false`)
 * passes: the file is the truth, and its new kind is decided after.
 */
export const readOnlyDocument: Extension = [
  EditorState.readOnly.of(true),
  EditorState.transactionFilter.of((tr) =>
    tr.docChanged && tr.annotation(Transaction.addToHistory) !== false ? [] : tr
  ),
];
