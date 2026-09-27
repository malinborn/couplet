import type { SlashAction } from './slash-actions';
import { t } from '../i18n';

/**
 * What `/stash` needs from the app: the same put-away as ⌃T. Injected, like
 * `ThemeControl`, so the landing's demo editors never get it. Pass ONE object
 * per window: the slash-menu source is built once per editor state from it.
 */
export interface StashControl {
  putAway(): void;
}

/**
 * `/stash`: put the document away (stash spec «Клавиатура»). The generic
 * action apply in `slash-commands.ts` deletes the typed `/…` before `run`, so
 * the put-away's flush never saves the trigger text. Tags come in stage 04.
 */
export function stashAction(control: StashControl): SlashAction {
  return {
    id: 'stash',
    label: '/stash',
    detail: t('editor.slash_stash.action_detail'),
    run: () => control.putAway(),
  };
}
