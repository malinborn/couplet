import { startCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { SlashAction } from '../slash-actions';
import { t } from '../../i18n';
import { pickerAllowedAt } from './link-query';

/**
 * Insert `[[]]` at the caret, caret inside, and open the `[[` picker — the
 * same completion source, no second picker machinery (file-links D5).
 */
export function openLinkPicker(view: EditorView): void {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: '[[]]' }, selection: { anchor: pos + 2 }, userEvent: 'input' });
  startCompletion(view);
}

/**
 * `/link` in the slash menu (line start, like every slash command). The
 * generic action apply in `slash-commands.ts` deletes the typed `/link`
 * before `run`.
 */
export function linkAction(): SlashAction {
  return {
    id: 'link',
    label: '/link',
    detail: t('editor.slash_link.action_detail'),
    run: (view) => openLinkPicker(view),
    // Not in code or HTML: the `[[` would stay text and no popup would open.
    available: (state, pos) => pickerAllowedAt(state, pos),
  };
}
