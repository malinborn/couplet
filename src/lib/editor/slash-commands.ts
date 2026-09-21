import type { Completion, CompletionContext, CompletionResult, CompletionSection } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { blockTemplates } from './block-templates';
import type { SlashAction } from './slash-actions';

// Shared objects, as the docs for `Completion.section` recommend, rather than
// a fresh literal per option — CM6 groups options by reference identity.
const BLOCKS_SECTION: CompletionSection = { name: 'Blocks', rank: 0 };
const ACTIONS_SECTION: CompletionSection = { name: 'Actions', rank: 1 };

function slashCommandSource(actions: readonly SlashAction[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/(?:^|\n)\s*\/\w*/);
    if (!before) return null;

    const slashIndex = before.text.lastIndexOf('/');
    const from = before.from + slashIndex;

    const blockOptions: Completion[] = blockTemplates.map((tpl): Completion => ({
      label: `/${tpl.id}`,
      detail: tpl.label,
      section: BLOCKS_SECTION,
      apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
        view.dispatch({
          changes: { from: applyFrom, to: applyTo, insert: tpl.insert },
          selection: tpl.cursorOffset
            ? { anchor: applyFrom + tpl.insert.length + tpl.cursorOffset }
            : { anchor: applyFrom + tpl.insert.length },
        });
      },
    }));

    const actionOptions: Completion[] = actions.map((action): Completion => ({
      label: action.label,
      detail: action.detail,
      section: ACTIONS_SECTION,
      apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
        // The action's own text is gone before it runs — `run()` never has to
        // account for its own trigger text still being in the document.
        view.dispatch({ changes: { from: applyFrom, to: applyTo, insert: '' } });
        action.run(view);
      },
    }));

    return { from, options: [...blockOptions, ...actionOptions] };
  };
}

/**
 * `actions` defaults to empty so every existing caller (`Editor.svelte`,
 * `site/demos/editor-demo.ts`) keeps exactly today's block-only behaviour
 * without changes.
 *
 * The source and the languageData record are built ONCE, outside the arrow
 * passed to `.of()`. CM6 calls that arrow on every `languageDataAt` lookup —
 * not once at setup — and compares the returned providers by *reference* to
 * detect whether the active source set changed. Building `{ autocomplete }`
 * fresh inside the arrow (as this used to) handed back a new object and a new
 * closure every single lookup, which CM6 reads as "the sources changed" on
 * every query, forever — the popup consequently never left `pending`. See
 * the identical fix in `slash-theme.ts`'s `themePickerExtensions`.
 */
export function slashCommands(actions: readonly SlashAction[] = []): Extension {
  const data = [{ autocomplete: slashCommandSource(actions) }];
  return EditorState.languageData.of(() => data);
}
