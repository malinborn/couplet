import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';

/**
 * Swaps the whole document and resets undo/redo to empty — the loaded
 * document must start at `undoDepth === 0`, with no way to Cmd+Z back into
 * whatever this window was showing before (#see docs/investigations/2026-09-23-tabs-options.md §1).
 *
 * A plain full-document replace does NOT reliably clear history on its own:
 * CodeMirror maps every existing undo/redo entry's stored INVERT through the
 * replace, and drops an entry only if its mapped changes become empty. The
 * invert of a user insertion is a deletion, which does map to empty over a
 * full-doc replace — that shape self-clears. But the invert of a user
 * deletion is an insertion at a position, and that survives the mapping:
 * undo still has something to reapply, and it splices the old deleted text
 * into whatever now occupies that position in the new document. Relying on
 * the mapping is therefore an accident of edit shape, not a guarantee —
 * hence the explicit compartment reset below instead.
 *
 * `history()` returns the same module-level `historyField` CodeMirror keeps
 * internally, so reconfiguring a compartment straight from `history()` to
 * `history()` again (skipping the intermediate `[]`) would NOT reset it — the
 * field's accumulated value survives a same-identity reconfigure, because
 * CodeMirror only re-runs a field's `create()` when the field is genuinely
 * absent from the immediately preceding config. Removing the field first is
 * what makes the final reconfigure below build a fresh one, at undo depth 0.
 *
 * Three separate dispatches, in this order: turn history off, swap the
 * document, turn history back on. The middle dispatch needs no
 * `addToHistory` annotation — there is no history field mounted to record it.
 */
export function loadDocumentContent(
  view: EditorView,
  historyCompartment: Compartment,
  newContent: string
): void {
  view.dispatch({ effects: historyCompartment.reconfigure([]) });

  const docLen = view.state.doc.length;
  view.dispatch({
    changes: { from: 0, to: docLen, insert: newContent },
    selection: newContent.length > 0 ? { anchor: newContent.length } : undefined,
  });

  view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}
