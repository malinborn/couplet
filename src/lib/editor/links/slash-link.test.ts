// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  autocompletion,
  completionStatus,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
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
