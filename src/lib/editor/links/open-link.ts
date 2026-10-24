import { Facet, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { documentPathField } from '../json-fence';
import { navigateToHeading } from '../heading-slugs';
import { resolveLinkTarget, type ResolvedLink, type UnresolvableReason } from '../../links/link-target';
import { opensAsDocument } from '../../links/link-kind';
import type { PathKind } from '../../links/types';
import { t } from '../../i18n';

/**
 * What a link needs from the app (file-links D3). Injected through
 * `linkControlFacet` like `stashControl`: `createExtensions()` is shared with
 * the couplet.pro landing's demo cards, which get no control and keep the old
 * external-only behaviour. Pass ONE object per window.
 *
 * Plan 02 adds `candidates`, `project` and `chooseFile` for the picker.
 */
export interface LinkControl {
  /** The home folder for `~/` links; `null` while unknown (or outside Tauri). */
  home(): string | null;
  /** What each path is on disk, in order. Rejects when the IPC fails. */
  pathKinds(paths: readonly string[]): Promise<PathKind[]>;
  /** Open `path` as a document — the tab/window that holds it, or a new tab — then jump to `fragment`. */
  openFile(path: string, fragment: string | null): Promise<void>;
  /** Select `path` in Finder. Never opens it. */
  reveal(path: string): Promise<void>;
  /** The link's target does not exist: the `link-missing` toast with «Create». */
  missing(path: string): void;
  /**
   * A link that resolves to no path: `untitled` — relative, in a document
   * with no path yet; `no-home` — `~/` before the home folder is known. An
   * empty destination never gets here: a click on it does nothing.
   */
  unresolvable(url: string, reason: Exclude<UnresolvableReason, 'empty'>): void;
}

export const linkControlFacet = Facet.define<LinkControl, LinkControl | null>({
  combine: (values) => values[0] ?? null,
});

export function linkControlOf(state: EditorState): LinkControl | null {
  return state.facet(linkControlFacet);
}

/** `resolveLinkTarget` against this state's document path and the control's home. */
export function resolveInState(state: EditorState, url: string): ResolvedLink {
  const control = linkControlOf(state);
  return resolveLinkTarget(url, state.field(documentPathField, false) ?? null, control?.home() ?? null);
}

/** What a click on the link will do, judged by name — no disk access. */
export type LinkAction = 'heading' | 'external' | 'open-file' | 'reveal' | 'unresolvable';

export function linkActionFor(target: ResolvedLink, hasControl: boolean): LinkAction {
  if (target.kind === 'anchor') return 'heading';
  if (target.kind === 'external' || !hasControl) return 'external';
  if (target.kind === 'unresolvable') return 'unresolvable';
  return opensAsDocument(target.path) ? 'open-file' : 'reveal';
}

/** The inspector's Open button for `action` (D3): visible text and aria-label. */
export function openButtonLabel(action: LinkAction): { text: string; aria: string } {
  switch (action) {
    case 'heading':
      return { text: t('editor.inspector.jump'), aria: t('editor.inspector.jump_to_heading') };
    case 'open-file':
    case 'unresolvable':
      return { text: t('editor.inspector.open_file'), aria: t('editor.inspector.open_file') };
    case 'reveal':
      return { text: t('editor.inspector.show_in_finder'), aria: t('editor.inspector.show_in_finder') };
    case 'external':
      return { text: t('editor.inspector.open'), aria: t('editor.inspector.open_in_browser') };
  }
}

/**
 * Opens a URL outside the app. Uses the Tauri shell plugin in the app; falls
 * back to a browser tab when that plugin has no backend (the landing page
 * embeds this same editor). The plugin call must be returned so its rejection
 * reaches the catch — otherwise the fallback never runs.
 */
export function openExternalUrl(url: string): Promise<void> {
  return import('@tauri-apps/plugin-shell')
    .then(({ open }) => open(url))
    .catch(() => {
      window.open(url, '_blank');
    });
}

/**
 * The one router behind every link gesture (D3): ⌘-click in either engine,
 * the inspector's Open, a click on a link in a table cell.
 *
 * - `#slug` → the heading in this document.
 * - a URL with a scheme → the OS (`openExternalUrl`), as before.
 * - a file → asked on disk first: missing → `control.missing`; a regular file
 *   couplet renders → `control.openFile` (with the fragment); anything else
 *   — a folder, an image, `run.command` — → `control.reveal`. Never executed.
 *
 * Without a control (the landing) a non-anchor goes to `openExternalUrl`
 * unchanged.
 */
export async function openLink(view: EditorView, url: string): Promise<void> {
  const control = linkControlOf(view.state);
  const target = resolveInState(view.state, url);
  if (target.kind === 'anchor') {
    navigateToHeading(view, target.slug);
    return;
  }
  if (target.kind === 'external') {
    await openExternalUrl(target.url);
    return;
  }
  if (!control) {
    await openExternalUrl(url);
    return;
  }
  if (target.kind === 'unresolvable') {
    if (target.reason !== 'empty') control.unresolvable(url, target.reason);
    return;
  }
  let kind: PathKind;
  try {
    const kinds = await control.pathKinds([target.path]);
    kind = kinds[0] ?? 'file';
  } catch (err) {
    console.warn('path_kinds failed, opening by name:', err);
    kind = 'file';
  }
  if (kind === 'missing') {
    control.missing(target.path);
    return;
  }
  if (kind === 'file' && opensAsDocument(target.path)) {
    await control.openFile(target.path, target.fragment);
    return;
  }
  await control.reveal(target.path);
}
