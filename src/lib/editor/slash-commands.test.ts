// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { slashCommands } from './slash-commands';
import type { SlashAction } from './slash-actions';
import { blockTemplates } from './block-templates';

function sourceAndContext(doc: string, actions: SlashAction[] = []) {
  const state = EditorState.create({ doc, extensions: [slashCommands(actions)] });
  const source = state.languageDataAt<CompletionSource>('autocomplete', doc.length)[0];
  return { state, source, context: new CompletionContext(state, doc.length, true) };
}

// `slashCommandSource` is synchronous, but `CompletionSource`'s declared
// return type also allows a `Promise` (for async sources in general) — this
// narrows it back for these tests, which never hand it an async source.
function callSync(source: CompletionSource, context: CompletionContext): CompletionResult {
  return source(context) as CompletionResult;
}

describe('slashCommands', () => {
  // Regression for a real bug (caught in a real browser, not by any jsdom
  // test — CM6 queries `languageDataAt` far more than once per keystroke).
  // CM6 compares the providers `languageDataAt` returns by *reference* to
  // decide whether the active completion source set changed; a fresh
  // `{ autocomplete }` object or a fresh `slashCommandSource(actions)` closure
  // on every lookup reads as "the sources changed" forever, and the popup
  // never leaves `pending`. `slashCommands()` must build the record once and
  // hand back that same reference on every call.
  it('LanguageDataAt_ReturnsTheIdenticalSourceOnRepeatedLookups', () => {
    const state = EditorState.create({ doc: '/', extensions: [slashCommands()] });
    const first = state.languageDataAt<CompletionSource>('autocomplete', 1)[0];
    const second = state.languageDataAt<CompletionSource>('autocomplete', 1)[0];
    expect(second).toBe(first);
  });

  it('NoActions_OnlyReturnsBlockOptions', () => {
    // The default parameter — what every existing caller (Editor.svelte,
    // site/demos/editor-demo.ts) still gets without passing anything.
    const { source, context } = sourceAndContext('/');
    const result = callSync(source, context);

    expect(result.options).toHaveLength(blockTemplates.length);
  });

  it('WithActions_AddsThemInADistinctSectionFromBlocks', () => {
    const action: SlashAction = { id: 'theme', label: '/theme', detail: 'Switch the app theme', run: () => {} };
    const { source, context } = sourceAndContext('/', [action]);
    const result = callSync(source, context);

    expect(result.options).toHaveLength(blockTemplates.length + 1);
    const themeOption = result.options.find((o) => o.label === '/theme')!;
    const blockOption = result.options.find((o) => o.label === '/h1')!;
    expect(themeOption).toBeDefined();
    expect(themeOption.detail).toBe('Switch the app theme');
    expect(themeOption.section).not.toBe(blockOption.section);
  });

  it('ActionApply_DeletesTheTypedTextThenRuns', () => {
    let ranWith: EditorView | null = null;
    const action: SlashAction = {
      id: 'theme',
      label: '/theme',
      detail: 'Switch the app theme',
      run: (view) => {
        ranWith = view;
      },
    };
    // The slash-command regex only matches at the start of a line (optional
    // leading whitespace) — same constraint block templates already have.
    const doc = '/theme';
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [slashCommands([action])] }),
    });
    const source = view.state.languageDataAt<CompletionSource>('autocomplete', doc.length)[0];
    const result = callSync(source, new CompletionContext(view.state, doc.length, true));
    const themeOption = result.options.find((o) => o.label === '/theme')!;

    (themeOption.apply as (v: EditorView, c: typeof themeOption, from: number, to: number) => void)(
      view,
      themeOption,
      result.from,
      doc.length
    );

    expect(view.state.doc.toString()).toBe('');
    expect(ranWith).toBe(view);
  });
});
