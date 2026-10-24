import {
  closeCompletion,
  completionStatus,
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSection,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { documentPathField } from '../json-fence';
import { linkQueryAt, type LinkQuery } from './link-query';
import type { LinkControl } from './open-link';
import { escapeLabel, linkMarkdownFor, wrapDestination } from '../../links/link-destination';
import { displayDir, pickerItems, type PickerItem } from '../../links/link-filter';
import type { LinkCandidates } from '../../links/types';
import { t } from '../../i18n';

export { linkQueryAt, type LinkQuery } from './link-query';

interface Sections {
  link: CompletionSection;
  tab: CompletionSection;
  project: CompletionSection;
  projectTruncated: CompletionSection;
  recent: CompletionSection;
  stash: CompletionSection;
  other: CompletionSection;
}

let sections: Sections | null = null;

/** Built on first use, not at import: the catalog is installed after modules load. */
function sectionsNow(): Sections {
  if (!sections) {
    sections = {
      link: { name: t('editor.links.section_link'), rank: 0 },
      tab: { name: t('editor.links.section_tabs'), rank: 1 },
      project: { name: t('editor.links.section_project'), rank: 2 },
      projectTruncated: { name: t('editor.links.section_project_truncated'), rank: 2 },
      recent: { name: t('editor.links.section_recent'), rank: 3 },
      stash: { name: t('editor.links.section_stash'), rank: 4 },
      other: { name: t('editor.links.section_other'), rank: 5 },
    };
  }
  return sections;
}

function insertLink(view: EditorView, completion: Completion, from: number, to: number, text: string): void {
  view.dispatch({ ...insertCompletionText(view.state, text, from, to), annotations: pickedCompletion.of(completion) });
}

/** Q9: `[[query]]` stays while the dialog is open; replaced only if nothing changed meanwhile. */
function chooseAndInsert(view: EditorView, control: LinkControl, data: LinkCandidates, from: number, to: number): void {
  const doc = view.state.doc;
  closeCompletion(view);
  control
    .chooseFile()
    .then(async (picked) => {
      if (!picked) return;
      // The dialog spells `/tmp/…`; the candidates (and `data.docPath`) are in
      // Rust's `path_norm` spelling, `/private/tmp/…`. Compared as they are,
      // every pick would come out absolute. `link_project` normalizes it.
      const path = await control
        .project(picked)
        .then((p) => p.docPath ?? picked)
        .catch(() => picked);
      if (view.state.doc !== doc) return;
      const text = linkMarkdownFor({ path, title: null }, data.docPath, data.projectRoot);
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.complete',
        scrollIntoView: true,
      });
      view.focus();
    })
    .catch((err: unknown) => console.error('Choose file failed:', err));
}

function optionFor(control: LinkControl, data: LinkCandidates, item: PickerItem, home: string | null): Completion {
  const s = sectionsNow();
  switch (item.kind) {
    case 'url':
      return {
        label: t('editor.links.link_to', { url: item.url }),
        type: 'link-url',
        section: s.link,
        apply: (view, completion, from, to) =>
          insertLink(view, completion, from, to, `[${escapeLabel(item.url)}](${wrapDestination(item.url)})`),
      };
    case 'choose':
      return {
        label: t('editor.links.choose_file'),
        type: 'link-choose',
        section: s.other,
        apply: (view, _completion, from, to) => chooseAndInsert(view, control, data, from, to),
      };
    case 'candidate': {
      const cand = item.candidate;
      const section = cand.group === 'project' && data.truncated ? s.projectTruncated : s[cand.group];
      const dir = displayDir(cand.path, data.projectRoot, home);
      return {
        label: item.label,
        detail: cand.window !== null ? `#${cand.window} · ${dir}` : dir,
        type: 'link-file',
        section,
        apply: (view, completion, from, to) =>
          insertLink(view, completion, from, to, linkMarkdownFor(cand, data.docPath, data.projectRoot)),
      };
    }
  }
}

/**
 * `currentDoc` is the document's path now. It can differ from the one the
 * candidates were fetched for: an untitled tab becomes a stash note on its
 * first character — usually the `[` of `[[` — and the stash then lists the
 * new note. The document is never offered a link to itself.
 */
function resultFor(
  control: LinkControl,
  data: LinkCandidates,
  q: LinkQuery,
  currentDoc: string | null
): CompletionResult {
  const home = control.home();
  const shown = currentDoc ? { ...data, candidates: data.candidates.filter((c) => c.path !== currentDoc) } : data;
  return {
    from: q.from,
    to: q.to,
    filter: false,
    options: pickerItems(shown, q.query).map((item) => optionFor(control, data, item, home)),
  };
}

export interface FileLinkSource {
  /** Exposed for tests; the editor gets it only through `extension`. */
  source: CompletionSource;
  extension: Extension;
}

/**
 * The one picker behind `[[` and `/link` (file-links D5).
 *
 * Built ONCE per editor state by `createExtensions` — the source and the
 * `languageData` record are created here, outside the `.of()` arrow, because
 * CM6 calls that arrow on every lookup and compares the providers by
 * identity; a fresh closure per lookup leaves the popup `pending` forever
 * (CLAUDE.md, "A completion source must be a STABLE reference").
 *
 * Candidates are fetched when the popup opens and kept for the life of that
 * popup: the first query returns a Promise, every later keystroke filters the
 * snapshot synchronously. The snapshot is dropped when the completion closes
 * (pick, Esc, caret leaving `[[`), so the next popup sees fresh tabs.
 */
export function createFileLinkSource(control: LinkControl): FileLinkSource {
  let session = 0;
  let snapshot: LinkCandidates | null = null;
  let inflight: Promise<LinkCandidates> | null = null;

  function candidates(docPath: string | null): Promise<LinkCandidates> {
    if (inflight) return inflight;
    const mine = session;
    inflight = control
      .candidates(docPath)
      .catch((err: unknown): LinkCandidates => {
        console.error('link_candidates failed:', err);
        return { candidates: [], truncated: false, projectRoot: null, docPath };
      })
      .then((data) => {
        if (session === mine) {
          snapshot = data;
          inflight = null;
        }
        return data;
      });
    return inflight;
  }

  const source: CompletionSource = (context) => {
    const q = linkQueryAt(context.state, context.pos);
    if (!q) return null;
    const docPath = context.state.field(documentPathField, false) ?? null;
    if (snapshot) return resultFor(control, snapshot, q, docPath);
    return candidates(docPath).then((data) => resultFor(control, data, q, docPath));
  };

  const data = [{ autocomplete: source }];
  const extension: Extension = [
    EditorState.languageData.of(() => data),
    EditorView.updateListener.of((update) => {
      if (completionStatus(update.startState) !== null && completionStatus(update.state) === null) {
        session++;
        snapshot = null;
        inflight = null;
      }
    }),
  ];
  return { source, extension };
}
