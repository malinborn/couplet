// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  autocompletion,
  completionStatus,
  currentCompletions,
  CompletionContext,
  selectedCompletion,
  setSelectedCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  themeAction,
  themePickerField,
  themePickerSource,
  themePickerExtensions,
  openThemePicker,
  type ThemeControl,
} from './slash-theme';
import type { ThemeFamily } from '../theme-resolve';

function fakeControl(overrides: Partial<ThemeControl> = {}) {
  const familyPreviews: (ThemeFamily | null)[] = [];
  const familyCommits: ThemeFamily[] = [];
  const toneCommits: Array<'light' | 'dark' | 'system'> = [];
  const control: ThemeControl = {
    current: 'light',
    followSystem: false,
    previewFamily(family) {
      familyPreviews.push(family);
    },
    commitFamily(family) {
      familyCommits.push(family);
    },
    commitTone(tone) {
      toneCommits.push(tone);
    },
    ...overrides,
  };
  return { control, familyPreviews, familyCommits, toneCommits };
}

// Goes through `themePickerExtensions()` itself (not a hand-rolled
// `languageData.of(...)`) so these tests exercise the exact production
// wiring — including the reference-stability fix below.
function makeView(control: ThemeControl, doc = ''): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [...themePickerExtensions(control), autocompletion()],
    }),
  });
}

/** Polls with real timers — CM6 resolves even a synchronous source through
 * its own internal `setTimeout`-based debounce, not just a microtask. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('themePickerExtensions', () => {
  // Regression for a real bug (caught in a real browser, not by jsdom — CM6
  // queries `languageDataAt` far more than once per keystroke). It compares
  // the providers `languageDataAt` returns by *reference* to decide whether
  // the active completion source set changed; a fresh `{ autocomplete }`
  // object or a fresh source closure on every lookup reads as "the sources
  // changed" forever, and the picker never leaves `pending`.
  // `themePickerExtensions()` must build the record once and hand back that
  // same reference on every call.
  it('LanguageDataAt_ReturnsTheIdenticalSourceOnRepeatedLookups', () => {
    const { control } = fakeControl();
    const state = EditorState.create({ doc: '', extensions: themePickerExtensions(control) });
    const first = state.languageDataAt<CompletionSource>('autocomplete', 0)[0];
    const second = state.languageDataAt<CompletionSource>('autocomplete', 0)[0];
    expect(second).toBe(first);
  });
});

describe('themeAction', () => {
  it('Run_OpensThePickerField_AnchoredAtTheCaret', () => {
    const { control } = fakeControl();
    const view = makeView(control, 'hello');
    view.dispatch({ selection: { anchor: 3 } });

    themeAction(control).run(view);

    expect(view.state.field(themePickerField)).toEqual({ anchor: 3, selectionPlaced: false });
  });
});

describe('themePickerSource', () => {
  it('FieldNotOpen_ReturnsNull', () => {
    const { control } = fakeControl();
    const view = makeView(control);
    const result = themePickerSource(control)(new CompletionContext(view.state, 0, true));
    expect(result).toBeNull();
  });

  it('FieldOpen_ReturnsExactlyTheSixFamilies', () => {
    const { control } = fakeControl();
    const view = makeView(control);
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });

    const result = themePickerSource(control)(new CompletionContext(view.state, 0, true));

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label).sort();
    expect(labels).toEqual(['Aurora', 'Blueprint', 'Classic', 'Phosphor', 'Paper', 'Ink'].sort());
  });

  it('MarksExactlyTheCurrentFamilyAsCurrent', () => {
    const { control } = fakeControl({ current: 'aurora-dark' });
    const view = makeView(control);
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });

    const options = themePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const current = options.filter((o) => o.detail === '● current');

    expect(current.map((o) => o.label)).toEqual(['Aurora']);
  });

  it('Apply_CommitsTheFamilyOnly_DeletesTypedFilterText_AndClosesTheField', () => {
    const { control, familyCommits } = fakeControl();
    const view = makeView(control, '');
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });
    // The user typed "aur" to filter the list down before picking.
    view.dispatch({ changes: { from: 0, to: 0, insert: 'aur' } });

    const options = themePickerSource(control)(new CompletionContext(view.state, 3, true))!.options;
    const option = options.find((o) => o.label === 'Aurora')!;
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      3
    );

    expect(familyCommits).toEqual(['aurora']);
    expect(view.state.doc.toString()).toBe('');
    expect(view.state.field(themePickerField)).toBeNull();
  });
});

describe('themePreviewListener', () => {
  it('AbortWithoutCommit_ClearsPreview_DeletesFilterText_AndClosesTheField', async () => {
    const { control, familyPreviews } = fakeControl();
    const view = makeView(control, '');
    // Opening the field is its own transaction; a second, later transaction
    // with the field already up and no active completion is what the
    // listener reads as an abort.
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'zz' }, selection: { anchor: 2 } });
    expect(completionStatus(view.state)).toBeNull();

    // The abort dispatch is deferred with queueMicrotask to avoid dispatching
    // from inside the update listener itself.
    await Promise.resolve();
    await Promise.resolve();

    expect(familyPreviews[familyPreviews.length - 1]).toBeNull();
    expect(view.state.doc.toString()).toBe('');
    expect(view.state.field(themePickerField)).toBeNull();
  });

  it('SelectingAFamily_PreviewsIt_InTheCurrentTone_AndCommittingLeavesThatFamilyInPlace', async () => {
    const { control, familyPreviews, familyCommits } = fakeControl({ current: 'dark' });
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);

    const active = currentCompletions(view.state);
    const index = active.findIndex((o) => o.label === 'Aurora');
    view.dispatch({ effects: setSelectedCompletion(index) });

    expect(familyPreviews[familyPreviews.length - 1]).toBe('aurora');

    const option = active[index];
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      0
    );

    expect(familyCommits).toEqual(['aurora']);
  });

  // Regression: Enter used to commit correctly (the assertion above already
  // covered that) but leave the list on screen showing the pre-commit
  // options — specifically when nothing was typed to filter the list first
  // (`from === to`, the ordinary case: open, arrow to a family, Enter). CM6
  // only invalidates a completion source's cached result when the
  // transaction's `docChanged` or explicit `selection` say so; a
  // `{changes: {from, to, insert: ''}}` with `from === to` trips neither, so
  // the popup kept showing stale data even though the field itself had
  // closed underneath it. See `commitSelection` in `slash-picker.ts`.
  it('Apply_ClosesThePopup_EvenWhenNoFilterTextWasTyped', async () => {
    const { control } = fakeControl();
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);

    const active = currentCompletions(view.state);
    const option = active.find((o) => o.label === 'Aurora')!;
    // from === to: nothing was typed, exactly the case that used to leave
    // the popup open.
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      0
    );

    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.field(themePickerField)).toBeNull();
  });
});

describe('themeOptions ordering (via themePickerSource, boost)', () => {
  it('CM6sSortedActiveList_MatchesFamilyOrder_NotAlphabetical', async () => {
    const { control } = fakeControl();
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');

    const labels = currentCompletions(view.state).map((o) => o.label);
    expect(labels).toEqual(['Classic', 'Aurora', 'Blueprint', 'Phosphor', 'Paper', 'Ink']);
  });
});

describe('initial selection on open', () => {
  // The bug this fixes: CM6 auto-selects its first sorted option the instant
  // the list goes active, with no regard for what is on screen. Without the
  // correction, opening `/theme` previewed (and thus flashed) that option —
  // Classic, given the ordering above — on every single open.
  it('SelectsTheCurrentFamily_NotWhateverCM6AutoSelected', async () => {
    const { control } = fakeControl({ current: 'aurora-dark' });
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);

    expect(selectedCompletion(view.state)?.label).toBe('Aurora');
  });

  it('NeverPreviewsAnyOtherFamilyBeforeOrAfterTheCorrection', async () => {
    const { control, familyPreviews } = fakeControl({ current: 'aurora-dark' });
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);
    // One more tick so a stray extra update (if any) is captured too.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(familyPreviews.length).toBeGreaterThan(0);
    expect(familyPreviews.every((family) => family === 'aurora')).toBe(true);
  });
});
