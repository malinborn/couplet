import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { blockTemplates, resolveTemplateInsert } from './block-templates';
import { t } from '../i18n';

function slashCommandSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/(?:^|\n)\s*\/\w*/);
  if (!before) return null;

  const slashIndex = before.text.lastIndexOf('/');
  const from = before.from + slashIndex;

  return {
    from,
    options: blockTemplates.map((tpl): Completion => ({
      // `label` stays the untranslated id — the user types `/table`, and
      // that match key has to be stable across languages. Only `detail`,
      // the caption shown in the completion list, is translated.
      label: `/${tpl.id}`,
      detail: t(tpl.labelKey),
      apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
        const insertText = resolveTemplateInsert(tpl);
        view.dispatch({
          changes: { from: applyFrom, to: applyTo, insert: insertText },
          selection: tpl.cursorOffset
            ? { anchor: applyFrom + insertText.length + tpl.cursorOffset }
            : { anchor: applyFrom + insertText.length },
        });
      },
    })),
  };
}

export function slashCommands(): Extension {
  return EditorState.languageData.of(() => [{ autocomplete: slashCommandSource }]);
}
