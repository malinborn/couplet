// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { fakeLinkControl } from './fake-link-control';
import { createFileLinkSource, linkQueryAt } from './file-link-source';
import type { LinkCandidates } from '../../links/types';
import type { LinkControl } from './open-link';

const DATA: LinkCandidates = {
  candidates: [
    { path: '/r/docs/plan.md', group: 'tab', title: null, window: null },
    { path: '/r/notes/ideas.md', group: 'project', title: null, window: null },
    { path: '/n/2026-10-24-ab12.md', group: 'stash', title: 'Ideas board', window: null },
  ],
  truncated: false,
  projectRoot: '/r',
  docPath: '/r/docs/a.md',
};

function setup(doc: string, pos: number, overrides: Partial<LinkControl> = {}, data: LinkCandidates = DATA) {
  const candidates = vi.fn(async () => data);
  const control = fakeLinkControl({ candidates, ...overrides });
  const { source, extension } = createFileLinkSource(control);
  let state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdownExtension(), documentPathField, extension],
  });
  state = state.update({ effects: setDocumentPath.of('/r/docs/a.md') }).state;
  return { control, candidates, source, state, extension };
}

const sectionName = (o: Completion) => (typeof o.section === 'object' ? o.section.name : o.section);
const apply = (view: EditorView, option: Completion, from: number, to: number) =>
  (option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, option, from, to);

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe('linkQueryAt', () => {
  const query = (doc: string, pos = doc.length) => {
    const { state } = setup(doc, pos);
    return linkQueryAt(state, pos);
  };

  it('matches [[query before the caret and swallows an auto-closed ]]', () => {
    expect(query('see [[pl]]', 8)).toEqual({ from: 4, to: 10, query: 'pl' });
  });

  it('without ]] ends at the caret', () => {
    expect(query('see [[pl')).toEqual({ from: 4, to: 8, query: 'pl' });
  });

  it('an empty query right after [[', () => {
    expect(query('[[]]', 2)).toEqual({ from: 0, to: 4, query: '' });
  });

  it('not inside inline code, a fenced block or a link URL', () => {
    expect(query('`[[x`', 4)).toBeNull();
    const fence = '`'.repeat(3);
    expect(query(`${fence}\n[[q\n${fence}`, 7)).toBeNull();
    expect(query('[a](x[[q)', 8)).toBeNull();
  });

  it('nothing without [[', () => {
    expect(query('[pl')).toBeNull();
  });
});

describe('the source', () => {
  it('fetches once per popup: a Promise first, then synchronous answers from the snapshot', async () => {
    const { source, state, candidates } = setup('see [[pl]]', 8);
    const first = source(new CompletionContext(state, 8, false));
    expect(first).toBeInstanceOf(Promise);
    const result = (await first) as CompletionResult;
    expect(result.from).toBe(4);
    expect(result.to).toBe(10);
    expect(result.filter).toBe(false);
    expect(result.options.map((o) => o.label)).toEqual(['plan', 'Choose file…']);
    const second = source(new CompletionContext(state, 8, false));
    expect(second).not.toBeInstanceOf(Promise);
    expect(candidates).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveBeenCalledWith('/r/docs/a.md');
  });

  it('an empty query lists the groups in sections; a cut-short walk says so in its header', async () => {
    const { source, state } = setup('[[', 2, {}, { ...DATA, truncated: true });
    const r = (await source(new CompletionContext(state, 2, false))) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(['plan', 'ideas', 'Ideas board', 'Choose file…']);
    expect(r.options.map(sectionName)).toEqual(['Open tabs', 'Project — not all files listed', 'Stash', 'Elsewhere']);
    expect(r.options.map((o) => o.detail)).toEqual(['r/docs', 'r/notes', '/n', undefined]);
  });

  it('a cut-short walk is still reported when no project file matches', async () => {
    // CM6 has no header-only section: the note rides on «Choose file…»,
    // the row that can still reach the unlisted file.
    const truncated = { ...DATA, truncated: true };
    const none = setup('[[zzz', 5, {}, truncated);
    const r1 = (await none.source(new CompletionContext(none.state, 5, false))) as CompletionResult;
    expect(r1.options.map((o) => o.label)).toEqual(['Choose file…']);
    expect(r1.options[0].detail).toBe('Project — not all files listed');
    // A project row shown carries it in its header; Choose file stays bare.
    const some = setup('[[idea', 6, {}, truncated);
    const r2 = (await some.source(new CompletionContext(some.state, 6, false))) as CompletionResult;
    expect(r2.options.map(sectionName)).toContain('Project — not all files listed');
    expect(r2.options[r2.options.length - 1].detail).toBeUndefined();
    // Not truncated: nothing to report.
    const plain = setup('[[zzz', 5);
    const r3 = (await plain.source(new CompletionContext(plain.state, 5, false))) as CompletionResult;
    expect(r3.options[0].detail).toBeUndefined();
  });

  it('another window’s tab names the window', async () => {
    const data: LinkCandidates = { ...DATA, candidates: [{ path: '/r/docs/b.md', group: 'tab', title: null, window: 3 }] };
    const { source, state } = setup('[[', 2, {}, data);
    const r = (await source(new CompletionContext(state, 2, false))) as CompletionResult;
    expect(r.options[0].detail).toBe('#3 · r/docs');
  });

  it('never offers the document itself, even when it got its path after the fetch', async () => {
    // An untitled tab becomes a stash note on its first character — the
    // candidates were asked for with no path, and list the new note.
    const data: LinkCandidates = {
      ...DATA,
      docPath: null,
      candidates: [...DATA.candidates, { path: '/r/docs/a.md', group: 'stash', title: '[[', window: null }],
    };
    const { source, state } = setup('[[', 2, {}, data);
    const r = (await source(new CompletionContext(state, 2, false))) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(['plan', 'ideas', 'Ideas board', 'Choose file…']);
  });

  it('a failed fetch still offers Choose file', async () => {
    const { source, state } = setup('[[x', 3, { candidates: () => Promise.reject(new Error('down')) });
    const r = (await source(new CompletionContext(state, 3, false))) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(['Choose file…']);
  });

  it('is the same function on every languageData lookup (CLAUDE.md: stable completion source)', () => {
    const { source, state } = setup('[[', 2);
    const a = state.languageDataAt<CompletionSource>('autocomplete', 2);
    const b = state.languageDataAt<CompletionSource>('autocomplete', 2);
    expect(a).toContain(source);
    expect(b.length).toBe(a.length);
    a.forEach((fn, i) => expect(b[i]).toBe(fn));
  });

  it('forgets the snapshot when the popup closes', async () => {
    vi.useFakeTimers();
    const candidates = vi.fn(async () => DATA);
    const { source, extension } = createFileLinkSource(fakeLinkControl({ candidates }));
    view = new EditorView({
      state: EditorState.create({
        doc: '[[',
        selection: { anchor: 2 },
        extensions: [markdownExtension(), documentPathField, autocompletion(), extension],
      }),
    });
    await source(new CompletionContext(view.state, 2, false));
    startCompletion(view);
    expect(completionStatus(view.state)).not.toBeNull();
    closeCompletion(view);
    expect(completionStatus(view.state)).toBeNull();
    const again = source(new CompletionContext(view.state, 2, false));
    expect(again).toBeInstanceOf(Promise);
    await again;
    expect(candidates).toHaveBeenCalledTimes(2);
  });
});

describe('applying a pick', () => {
  it('replaces [[q]] with a markdown link relative to the document', async () => {
    const { source, state } = setup('see [[pl]] end', 8);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 8, false))) as CompletionResult;
    apply(view, r.options[0], r.from, r.to ?? 8);
    expect(view.state.doc.toString()).toBe('see [plan](plan.md) end');
    expect(view.state.selection.main.head).toBe(19);
  });

  it('a stash note is labelled by its title', async () => {
    const { source, state } = setup('[[ideas b]]', 9);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 9, false))) as CompletionResult;
    const note = r.options.find((o) => o.label === 'Ideas board')!;
    apply(view, note, r.from, r.to ?? 9);
    expect(view.state.doc.toString()).toBe('[Ideas board](/n/2026-10-24-ab12.md)');
  });

  it('a URL query offers Link to URL first', async () => {
    const { source, state } = setup('[[https://x.test/a]]', 18);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 18, false))) as CompletionResult;
    expect(r.options[0].label).toBe('Link to https://x.test/a');
    apply(view, r.options[0], r.from, r.to ?? 18);
    expect(view.state.doc.toString()).toBe('[https://x.test/a](https://x.test/a)');
  });

  it('Choose file keeps [[q]] until the dialog answers, then replaces it', async () => {
    let answer: (path: string | null) => void = () => {};
    const chooseFile = () => new Promise<string | null>((resolve) => (answer = resolve));
    const { source, state } = setup('[[x]]', 3, { chooseFile });
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 3, false))) as CompletionResult;
    const choose = r.options[r.options.length - 1];
    apply(view, choose, r.from, r.to ?? 3);
    expect(view.state.doc.toString()).toBe('[[x]]');
    answer('/r/notes/new idea.md');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe('[new idea](<../notes/new idea.md>)');
  });

  it('Choose file spells the picked path the way Rust does before making it relative', async () => {
    // The dialog answers `/tmp/…`; the document and root are `/private/tmp/…`.
    const data: LinkCandidates = { ...DATA, projectRoot: '/private/tmp/fl', docPath: '/private/tmp/fl/a.md' };
    const project = vi.fn(async (p: string | null) => ({ projectRoot: null, docPath: p && p.replace(/^\/tmp\//, '/private/tmp/') }));
    const { source, state } = setup('[[x]]', 3, { chooseFile: async () => '/tmp/fl/notes/b.md', project }, data);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 3, false))) as CompletionResult;
    apply(view, r.options[r.options.length - 1], r.from, r.to ?? 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(project).toHaveBeenCalledWith('/tmp/fl/notes/b.md');
    expect(view.state.doc.toString()).toBe('[b](notes/b.md)');
  });

  it('Choose file falls back to the dialog\'s spelling when link_project fails', async () => {
    const { source, state } = setup('[[x]]', 3, {
      chooseFile: async () => '/r/notes/c.md',
      project: () => Promise.reject(new Error('down')),
    });
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 3, false))) as CompletionResult;
    apply(view, r.options[r.options.length - 1], r.from, r.to ?? 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe('[c](../notes/c.md)');
  });

  it('a cancelled dialog leaves [[q]] as typed', async () => {
    const { source, state } = setup('[[x]]', 3, { chooseFile: async () => null });
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 3, false))) as CompletionResult;
    apply(view, r.options[r.options.length - 1], r.from, r.to ?? 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe('[[x]]');
  });
});
