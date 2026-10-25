import type { EditorState } from '@codemirror/state';
import { isMacPlatform } from '../hotkey-label';
import { linkActionFor, linkControlOf, resolveInState } from './open-link';
import { linkExistenceField } from './link-existence';
import { basename, stripAngle } from '../../links/link-target';
import { t } from '../../i18n';

export interface LinkPresentation {
  /** The hover title — the only place the app says how to open a link (#32). */
  title: string;
  /** The target is known not to exist: `cm-md-link-missing`. */
  missing: boolean;
}

/** How a link with destination `url` looks in this state (file-links D4). */
export function linkPresentation(state: EditorState, url: string): LinkPresentation {
  const click = t(isMacPlatform() ? 'editor.links.click_mac' : 'editor.links.click_other');
  const plain = (key: string, params: Record<string, unknown> = {}): LinkPresentation => ({
    title: t(key, { click, ...params }),
    missing: false,
  });
  // A reference link (`[foo]` with `[foo]: …` elsewhere) has no URL child.
  if (stripAngle(url) === '') return plain('editor.links.hint_open_link');

  const control = linkControlOf(state);
  const target = resolveInState(state, url);
  const action = linkActionFor(target, control !== null);
  if (target.kind === 'file' && control && state.field(linkExistenceField, false)?.get(target.path) === false) {
    return {
      title: action === 'open-file' ? t('editor.links.hint_missing', { click }) : t('editor.links.hint_missing_plain'),
      missing: true,
    };
  }
  switch (action) {
    case 'heading':
      return plain('editor.links.hint_heading');
    case 'open-file':
      return plain('editor.links.hint_open_file', { name: basename(target.kind === 'file' ? target.path : url) });
    case 'reveal':
      return plain('editor.links.hint_reveal');
    case 'unresolvable':
      return plain('editor.links.hint_open_file', { name: basename(stripAngle(url)) });
    case 'external':
      return plain('editor.links.hint_open_link');
  }
}
