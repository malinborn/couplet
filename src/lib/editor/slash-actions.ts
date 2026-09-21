import type { EditorView } from '@codemirror/view';

/**
 * Second kind of slash-menu entry, alongside `BlockTemplate` (block-templates.ts).
 * Every block template only ever inserts text — its `apply()` is one
 * `view.dispatch({changes})`. An action instead changes state that lives
 * *outside* the document (e.g. the app's theme), so it gets to run arbitrary
 * code against the view rather than a fixed insert string.
 */
export interface SlashAction {
  /**
   * Identifier for the action. Not necessarily what the popup shows — see
   * `label` — but used to tell actions apart (tests, future dispatch).
   */
  id: string;
  /**
   * The completion's own label — what the popup shows and what the typed
   * text is matched against. For `/theme` this is the literal string
   * `'/theme'`, exactly like a block template's `/${id}` label: the query
   * CM6 matches always includes the leading `/` the user typed, so the
   * label has to carry it too or fuzzy matching never succeeds.
   */
  label: string;
  /** Right-hand column of the popup. */
  detail: string;
  /** What to do instead of inserting text. The typed command text is already deleted. */
  run(view: EditorView): void;
}
