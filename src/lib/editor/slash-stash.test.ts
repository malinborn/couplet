// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { createExtensions } from './setup';
import { stashAction, type StashControl } from './slash-stash';
import { tIn } from '../i18n';

function labelsAt(state: EditorState): string[] {
  const pos = state.doc.length;
  const sources = state.languageDataAt<CompletionSource>('autocomplete', pos);
  return sources.flatMap(
    (source) =>
      (source(new CompletionContext(state, pos, true)) as CompletionResult | null)?.options.map((o) => o.label) ?? []
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function applyOption(view: EditorView, option: Completion, from: number, to: number): void {
  (option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(
    view,
    option,
    from,
    to
  );
}

describe('/stash', () => {
  it('is an action that puts the document away', () => {
    const putAway = vi.fn();
    const action = stashAction({ putAway });
    expect(action.id).toBe('stash');
    expect(action.label).toBe('/stash');
    const view = new EditorView({ state: EditorState.create({ doc: '' }) });
    action.run(view);
    expect(putAway).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('has its caption in every locale, Russian from the spec', () => {
    expect(tIn('ru', 'editor.slash_stash.action_detail')).toBe('Отложить в тайник');
    for (const lang of ['en', 'es', 'de', 'fr', 'zh'] as const) {
      expect(tIn(lang, 'editor.slash_stash.action_detail')).not.toBe('editor.slash_stash.action_detail');
    }
  });

  it('is offered only when the app gives a StashControl — never on the landing', () => {
    const withStash = EditorState.create({ doc: '/st', extensions: createExtensions({ stashControl: { putAway: () => {} } }) });
    const without = EditorState.create({ doc: '/st', extensions: createExtensions() });
    expect(labelsAt(withStash)).toContain('/stash');
    expect(labelsAt(without)).not.toContain('/stash');
  });

  // CLAUDE.md: CM6 compares completion providers by identity on every
  // `languageDataAt` lookup; a fresh closure per lookup keeps the popup
  // `pending` forever. Adding `/stash` must not rebuild the source per query.
  it('keeps every completion source a stable reference across lookups', () => {
    const state = EditorState.create({ doc: '/', extensions: createExtensions({ stashControl: { putAway: () => {} } }) });
    const first = state.languageDataAt<CompletionSource>('autocomplete', 1);
    const second = state.languageDataAt<CompletionSource>('autocomplete', 1);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(first.length);
    second.forEach((source, i) => expect(source).toBe(first[i]));
  });

  it.each([
    ['the whole command typed', '/stash'],
    ['only the slash typed, then picked from the list', '/'],
  ])('picking it (%s) deletes the command, closes the popup, then puts away once', async (_case, doc) => {
    let docAtPutAway: string | null = null;
    let view: EditorView | null = null;
    const control: StashControl = {
      putAway: vi.fn(() => {
        docAtPutAway = view!.state.doc.toString();
      }),
    };
    view = new EditorView({
      state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: createExtensions({ stashControl: control }) }),
    });

    startCompletion(view);
    await waitUntil(() => completionStatus(view!.state) === 'active');
    expect(completionStatus(view.state)).toBe('active');
    const option = currentCompletions(view.state).find((o) => o.label === '/stash')!;
    expect(option).toBeDefined();

    applyOption(view, option, 0, doc.length);

    expect(view.state.doc.toString()).toBe('');
    expect(completionStatus(view.state)).toBeNull();
    expect(control.putAway).toHaveBeenCalledTimes(1);
    // The flush that ⌃T's put-away runs must not save the trigger text.
    expect(docAtPutAway).toBe('');
    view.destroy();
  });
});
