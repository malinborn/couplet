import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { documentPathField } from '../json-fence';
import { isRenderedLink } from '../preview/link-refs';
import { linkControlOf, resolveInState } from './open-link';
import { PATH_KINDS_MAX } from '../../links/types';

/**
 * Does each linked file exist (file-links D4)? Resolved path → `true`/`false`.
 * A path not in the map is unknown and renders as an ordinary link — a link
 * never flickers to "missing" before an answer.
 */
const EMPTY: ReadonlyMap<string, boolean> = new Map();

/** Answers to merge into the cache. */
export const setLinkExistence = StateEffect.define<ReadonlyMap<string, boolean>>();
/** A fresh cache that replaces the old one whole (the focus re-check). */
export const replaceLinkExistence = StateEffect.define<ReadonlyMap<string, boolean>>();

function docPathOf(state: EditorState): string | null {
  return state.field(documentPathField, false) ?? null;
}

export const linkExistenceField = StateField.define<ReadonlyMap<string, boolean>>({
  create: () => EMPTY,
  update(value, tr) {
    let next = docPathOf(tr.startState) === docPathOf(tr.state) ? value : EMPTY;
    for (const effect of tr.effects) {
      if (effect.is(replaceLinkExistence)) {
        next = effect.value;
      } else if (effect.is(setLinkExistence)) {
        const merged = new Map(next);
        for (const [path, exists] of effect.value) merged.set(path, exists);
        next = merged;
      }
    }
    return next;
  },
});

/** Resolved file targets of the rendered links between `from` and `to`, each once, in document order. */
export function fileLinkPaths(state: EditorState, from: number, to: number): string[] {
  const out = new Set<string>();
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'Link') return;
      // A bracket pair that is not a link (`see [1]`, #51): descend, a real
      // link may sit inside it.
      if (!isRenderedLink(state.doc, node.node)) return;
      const url = node.node.getChild('URL');
      if (url) {
        const target = resolveInState(state, state.doc.sliceString(url.from, url.to));
        if (target.kind === 'file') out.add(target.path);
      }
      return false;
    },
  });
  return [...out];
}

/** Trailing quiet period before asking: typing a path does not ask per keystroke. */
export const LINK_CHECK_DELAY_MS = 150;

class LinkExistenceChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<string>();
  private destroyed = false;
  /** The next timer re-checks everything known instead of only the unknown. */
  private recheckDue = false;
  private readonly onFocus = (): void => {
    void this.recheckAll();
  };

  constructor(private readonly view: EditorView) {
    // A plugin is built for every state the view is given, so a state that
    // already knows answers is one shown again — a tab switched back to. Its
    // answers may be stale (the «Create» of a missing link saved that file in
    // another tab), so they are re-checked and replaced in one effect, like
    // on window focus: no flicker to "unknown" meanwhile.
    const known = view.state.field(linkExistenceField, false);
    this.recheckDue = known !== undefined && known.size > 0;
    this.schedule();
    window.addEventListener('focus', this.onFocus);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || docPathOf(update.startState) !== docPathOf(update.state)) {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.recheckDue) {
        this.recheckDue = false;
        void this.recheckAll();
      } else {
        void this.check();
      }
    }, LINK_CHECK_DELAY_MS);
  }

  private visiblePaths(): string[] {
    const { from, to } = this.view.viewport;
    return fileLinkPaths(this.view.state, from, to);
  }

  private async check(): Promise<void> {
    const control = linkControlOf(this.view.state);
    if (!control) return;
    const known = this.view.state.field(linkExistenceField, false) ?? EMPTY;
    const unknown = this.visiblePaths().filter((p) => !known.has(p) && !this.pending.has(p));
    if (unknown.length === 0) return;
    const batch = unknown.slice(0, PATH_KINDS_MAX);
    for (const p of batch) this.pending.add(p);
    try {
      const kinds = await control.pathKinds(batch);
      if (this.destroyed) return;
      const answers = new Map<string, boolean>();
      batch.forEach((p, i) => {
        const kind = kinds[i];
        if (kind !== undefined) answers.set(p, kind !== 'missing');
      });
      this.view.dispatch({ effects: setLinkExistence.of(answers) });
    } catch (err) {
      // Unknown stays unknown (an ordinary link); the next change asks again.
      console.warn('link existence check failed:', err);
    } finally {
      for (const p of batch) this.pending.delete(p);
    }
    if (unknown.length > batch.length) this.schedule();
  }

  /** A file may have been created or deleted while the window was away. */
  private async recheckAll(): Promise<void> {
    const control = linkControlOf(this.view.state);
    if (!control) return;
    const known = this.view.state.field(linkExistenceField, false) ?? EMPTY;
    const paths = [...new Set([...known.keys(), ...this.visiblePaths()])].slice(0, PATH_KINDS_MAX);
    if (paths.length === 0) return;
    try {
      const kinds = await control.pathKinds(paths);
      if (this.destroyed) return;
      const fresh = new Map<string, boolean>();
      paths.forEach((p, i) => {
        const kind = kinds[i];
        if (kind !== undefined) fresh.set(p, kind !== 'missing');
      });
      this.view.dispatch({ effects: replaceLinkExistence.of(fresh) });
    } catch (err) {
      console.warn('link existence re-check failed:', err);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    window.removeEventListener('focus', this.onFocus);
  }
}

export const linkExistenceChecker = ViewPlugin.fromClass(LinkExistenceChecker);

/** Installed by `createExtensions` only together with a `LinkControl`. */
export const linkExistence: Extension = [linkExistenceField, linkExistenceChecker];
