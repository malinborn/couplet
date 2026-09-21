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
  themePreviewListener,
  openThemePicker,
  type ThemeControl,
  type ThemeChoice,
} from './slash-theme';

function fakeControl(overrides: Partial<ThemeControl> = {}) {
  const previews: (ThemeChoice | null)[] = [];
  const commits: ThemeChoice[] = [];
  const control: ThemeControl = {
    current: 'light',
    followSystem: false,
    preview(choice) {
      previews.push(choice);
    },
    commit(choice) {
      commits.push(choice);
    },
    ...overrides,
  };
  return { control, previews, commits };
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
  // object or a fresh `themePickerSource(control)` closure on every lookup
  // reads as "the sources changed" forever, and the picker never leaves
  // `pending`. `themePickerExtensions()` must build the record once and hand
  // back that same reference on every call.
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

  it('FieldOpen_ReturnsAllEightConcreteThemesPlusSystem', () => {
    const { control } = fakeControl();
    const view = makeView(control);
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });

    const result = themePickerSource(control)(new CompletionContext(view.state, 0, true));

    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label).sort();
    expect(labels).toEqual(
      [
        'Light',
        'Dark',
        'Aurora Light',
        'Aurora Dark',
        'Blueprint Light',
        'Blueprint Dark',
        'Phosphor Light',
        'Phosphor Dark',
        'System',
      ].sort()
    );
  });

  it('MarksExactlyTheCurrentConcreteThemeAsCurrent', () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control);
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });

    const options = themePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const current = options.filter((o) => o.detail === '● current');

    expect(current.map((o) => o.label)).toEqual(['Aurora Dark']);
  });

  it('FollowSystemOn_MarksSystemAsCurrent_NotAnyConcreteTheme', () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: true });
    const view = makeView(control);
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });

    const options = themePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const current = options.filter((o) => o.detail === '● current');

    expect(current.map((o) => o.label)).toEqual(['System']);
  });

  it('Apply_CommitsTheChoice_DeletesTypedFilterText_AndClosesTheField', () => {
    const { control, commits } = fakeControl();
    const view = makeView(control, '');
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });
    // The user typed "dark" to filter the list down before picking.
    view.dispatch({ changes: { from: 0, to: 0, insert: 'dark' } });

    const options = themePickerSource(control)(new CompletionContext(view.state, 4, true))!.options;
    const option = options.find((o) => o.label === 'Dark')!;
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      4
    );

    expect(commits).toEqual(['dark']);
    expect(view.state.doc.toString()).toBe('');
    expect(view.state.field(themePickerField)).toBeNull();
  });

  it('SystemOption_CommitsTheStringSystem', () => {
    const { control, commits } = fakeControl();
    const view = makeView(control, '');
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });

    const options = themePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const option = options.find((o) => o.label === 'System')!;
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      0
    );

    expect(commits).toEqual(['system']);
  });
});

describe('themePreviewListener', () => {
  it('AbortWithoutCommit_ClearsPreview_DeletesFilterText_AndClosesTheField', async () => {
    const { control, previews } = fakeControl();
    const view = makeView(control, '');
    // Opening the field is its own transaction; a second, later transaction
    // with the field already up and no active completion is what the listener
    // reads as an abort (see the `wasOpenBefore` guard in slash-theme.ts).
    view.dispatch({ effects: openThemePicker.of({ anchor: 0 }) });
    // Selection explicit, matching what real typing leaves behind — a bare
    // insert with no selection option maps the old (0,0) selection back to 0
    // rather than after the inserted text.
    view.dispatch({ changes: { from: 0, to: 0, insert: 'zz' }, selection: { anchor: 2 } });
    expect(completionStatus(view.state)).toBeNull();

    // The abort dispatch is deferred with queueMicrotask to avoid dispatching
    // from inside the update listener itself (see preview/table-selection.ts).
    await Promise.resolve();
    await Promise.resolve();

    expect(previews[previews.length - 1]).toBeNull();
    expect(view.state.doc.toString()).toBe('');
    expect(view.state.field(themePickerField)).toBeNull();
  });

  // Previously removed as "flaky" — it wasn't timing, it was the reference-
  // identity bug `themePickerExtensions` regression-tests above:
  // `languageData.of(() => [{ autocomplete: themePickerSource(control) }])`
  // built a new source closure on every lookup, so CM6 never stopped seeing
  // "the sources changed" and the query never left `pending`. Now that the
  // record is built once, this reaches `active` reliably.
  it('SelectingAThemeOption_PreviewsIt_AndCommittingLeavesThatChoiceInPlace', async () => {
    const { control, previews, commits } = fakeControl();
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    expect(completionStatus(view.state)).toBe('active');
    // Let the one-time initial-selection correction land first (its own
    // dispatch, queued via a microtask off the update that reached 'active')
    // before this test drives its own selection — see the next describe
    // block for what that correction does on its own.
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);

    // Index into CM6's own (sorted) active list, not a freshly-built one from
    // `themePickerSource` directly — `setSelectedCompletion` operates on the
    // former, and the two orderings need not match.
    const active = currentCompletions(view.state);
    const index = active.findIndex((o) => o.label === 'Aurora Dark');
    view.dispatch({ effects: setSelectedCompletion(index) });

    expect(previews[previews.length - 1]).toBe('aurora-dark');

    const option = active[index];
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      0
    );

    expect(commits).toEqual(['aurora-dark']);
  });
});

describe('themeOptions ordering (via themePickerSource, boost)', () => {
  // The team lead measured this in a real browser: without `boost`, CM6's
  // default alphabetical sort scatters the two halves of every family and
  // buries Light/Dark — the two most-used entries — mid-list. `boost` must
  // reproduce `THEME_CHOICES` order in the engine's own sorted output, not
  // just in the array `themePickerSource` builds before CM6 touches it.
  it('CM6sSortedActiveList_MatchesFamilyOrder_NotAlphabetical', async () => {
    const { control } = fakeControl();
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');

    const labels = currentCompletions(view.state).map((o) => o.label);
    expect(labels).toEqual([
      'Light',
      'Dark',
      'Aurora Light',
      'Aurora Dark',
      'Blueprint Light',
      'Blueprint Dark',
      'Phosphor Light',
      'Phosphor Dark',
      'System',
    ]);
  });
});

describe('initial selection on open', () => {
  // The bug this fixes: CM6 auto-selects its first sorted option the instant
  // the list goes active, with no regard for what is on screen. Without the
  // correction, opening `/theme` previewed (and thus flashed) that option —
  // Light, given the ordering above — on every single open.
  it('SelectsTheCurrentTheme_NotWhateverCM6AutoSelected', async () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);

    expect(selectedCompletion(view.state)?.label).toBe('Aurora Dark');
  });

  it('FollowSystemOn_SelectsSystem', async () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: true });
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);

    expect(selectedCompletion(view.state)?.label).toBe('System');
  });

  it('NeverPreviewsAnyOtherChoiceBeforeOrAfterTheCorrection', async () => {
    const { control, previews } = fakeControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control, '');

    themeAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(themePickerField)?.selectionPlaced === true);
    // One more tick so a stray extra update (if any) is captured too.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(previews.length).toBeGreaterThan(0);
    expect(previews.every((choice) => choice === 'aurora-dark')).toBe(true);
  });
});
