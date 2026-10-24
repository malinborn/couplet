// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  selectedCompletion,
  setSelectedCompletion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { LinkCandidates } from '../../links/types';
import { markdownExtension } from '../markdown-language';
import { slashCommands } from '../slash-commands';
import { createDocumentState } from '../state-factory';
import { fakeLinkControl } from './fake-link-control';
import { createFileLinkSource } from './file-link-source';
import { linkAction } from './slash-link';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe('/link', () => {
  /** The slash menu's labels for `doc`, the caret at its end (or at `pos`). */
  const slashLabels = (doc: string, pos = doc.length) => {
    const state = EditorState.create({ doc, extensions: [markdownExtension(), slashCommands([linkAction()])] });
    ensureSyntaxTree(state, doc.length, 5000);
    const sources = state.languageDataAt<CompletionSource>('autocomplete', pos);
    const result = sources
      .map((source) => source(new CompletionContext(state, pos, true)) as CompletionResult | null)
      .find((r) => r !== null);
    return result ? result.options : [];
  };

  it('is offered by the slash menu', () => {
    expect(slashLabels('/li').find((o) => o.label === '/link')?.detail).toBe('Link to a file');
  });

  it('is not offered where [[ would not open the picker (code, HTML)', () => {
    const fence = '`'.repeat(3);
    const offered = (doc: string, pos?: number) => slashLabels(doc, pos).some((o) => o.label === '/link');
    expect(offered(`${fence}\n/li\n${fence}`, 7)).toBe(false);
    expect(offered('para\n\n    /li')).toBe(false);
    expect(offered('<div>\n/li\n</div>', 9)).toBe(false);
    // The block templates are still offered there — only /link is withheld.
    expect(slashLabels(`${fence}\n/li\n${fence}`, 7).length).toBeGreaterThan(0);
    expect(offered('- /li')).toBe(false); // not at line start: no slash menu at all
    expect(offered('text\n\n/li')).toBe(true);
  });

  it('inserts [[]] with the caret inside and opens the picker', () => {
    vi.useFakeTimers();
    // The picker's own source is installed, so starting a completion has a
    // source to be pending on.
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [markdownExtension(), autocompletion(), createFileLinkSource(fakeLinkControl()).extension],
      }),
    });
    linkAction().run(view);
    expect(view.state.doc.toString()).toBe('[[]]');
    expect(view.state.selection.main.head).toBe(2);
    expect(completionStatus(view.state)).not.toBeNull();
  });

  it('is installed, with the [[ picker, only together with a LinkControl', () => {
    const withControl = createDocumentState('[[', 2, [], { linkControl: fakeLinkControl() });
    const without = createDocumentState('[[', 2, []);
    expect(withControl.languageDataAt('autocomplete', 2).length).toBeGreaterThan(
      without.languageDataAt('autocomplete', 2).length
    );
  });
});

/** Polls until `ok` holds — CM6 queries sources on its own timers (50–100 ms). */
async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const DATA: LinkCandidates = {
  candidates: [{ path: '/r/docs/plan.md', group: 'tab', title: null, window: null }],
  truncated: false,
  projectRoot: '/r',
  docPath: null,
};

function typeInto(v: EditorView, text: string): void {
  for (const ch of text) {
    const head = v.state.selection.main.head;
    v.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
  }
}

describe('/link end to end', () => {
  it('picking /link from the slash menu opens the [[ picker with its options', async () => {
    const control = fakeLinkControl({ candidates: async () => DATA });
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [markdownExtension(), slashCommands([linkAction()]), autocompletion(), createFileLinkSource(control).extension],
      }),
    });
    const v = view;
    typeInto(v, '/link');
    await until(() => completionStatus(v.state) === 'active' && currentCompletions(v.state).some((o) => o.label === '/link'));
    const index = currentCompletions(v.state).findIndex((o) => o.label === '/link');
    v.dispatch({ effects: setSelectedCompletion(index) });
    expect(selectedCompletion(v.state)?.label).toBe('/link');
    // `acceptCompletion` ignores a popup younger than `interactionDelay` (75 ms).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(acceptCompletion(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('[[]]');
    expect(v.state.selection.main.head).toBe(2);
    await until(() => completionStatus(v.state) === 'active' && currentCompletions(v.state).length > 0);
    expect(currentCompletions(v.state).map((o) => o.label)).toEqual(['plan', 'Choose file…']);
  });
});

describe('a stale candidates answer', () => {
  it('lands after the popup closed: no error, nothing inserted, the next popup fetches afresh', async () => {
    let answer: (data: LinkCandidates) => void = () => {};
    const candidates = vi
      .fn<(docPath: string | null) => Promise<LinkCandidates>>()
      .mockImplementationOnce(() => new Promise<LinkCandidates>((resolve) => (answer = resolve)))
      .mockImplementation(async () => DATA);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [markdownExtension(), autocompletion(), createFileLinkSource(fakeLinkControl({ candidates })).extension],
      }),
    });
    const v = view;
    v.dispatch({ changes: { from: 0, insert: '[[]]' }, selection: { anchor: 2 }, userEvent: 'input.type' });
    await until(() => candidates.mock.calls.length === 1);
    closeCompletion(v);
    expect(completionStatus(v.state)).toBeNull();
    answer(DATA);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(completionStatus(v.state)).toBeNull();
    expect(v.state.doc.toString()).toBe('[[]]');
    expect(errors).not.toHaveBeenCalled();
    // The stale answer was not kept as the next popup's snapshot.
    typeInto(v, 'p');
    await until(() => completionStatus(v.state) === 'active');
    expect(candidates).toHaveBeenCalledTimes(2);
    expect(currentCompletions(v.state).map((o) => o.label)).toEqual(['plan', 'Choose file…']);
    errors.mockRestore();
  });
});
