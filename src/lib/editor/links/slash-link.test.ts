// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
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
  it('is offered by the slash menu', () => {
    const state = EditorState.create({ doc: '/li', extensions: [slashCommands([linkAction()])] });
    const source = state.languageDataAt<CompletionSource>('autocomplete', 3)[0];
    const result = source(new CompletionContext(state, 3, true)) as CompletionResult;
    expect(result.options.find((o) => o.label === '/link')?.detail).toBe('Link to a file');
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
