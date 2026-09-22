// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  autocompletion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  CompletionContext,
  selectedCompletion,
  setSelectedCompletion,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  toneAction,
  tonePickerField,
  tonePickerSource,
  tonePickerExtensions,
  openTonePicker,
  type ToneChoice,
} from './slash-tone';
import type { ThemeControl } from './slash-theme';
import { concreteTheme, familyOf, type ConcreteTheme } from '../theme-resolve';

function fakeControl(overrides: Partial<ThemeControl> = {}) {
  const familyPreviews: unknown[] = [];
  const toneCommits: Array<'light' | 'dark' | 'system'> = [];
  const control: ThemeControl = {
    current: 'light',
    followSystem: false,
    previewFamily(family) {
      // `/tone` must never call this — kept only so a stray call is visible
      // in a test rather than throwing on a missing method.
      familyPreviews.push(family);
    },
    commitFamily() {
      throw new Error('/tone must never call commitFamily');
    },
    commitTone(tone) {
      toneCommits.push(tone);
    },
    ...overrides,
  };
  return { control, familyPreviews, toneCommits };
}

/**
 * Unlike `fakeControl` above, this one actually mutates on `commitTone` —
 * needed for the "stays open, `● current` moves to what was actually
 * applied" tests below, which re-query the list *after* a commit and must
 * see the new state, exactly like `App.svelte`'s real `themeControl` (whose
 * `current`/`followSystem` are live getters over `createThemeStore()`).
 */
function statefulControl(initial: { current: ConcreteTheme; followSystem: boolean }) {
  let current = initial.current;
  let followSystem = initial.followSystem;
  const toneCommits: ToneChoice[] = [];
  const control: ThemeControl = {
    get current() {
      return current;
    },
    get followSystem() {
      return followSystem;
    },
    previewFamily() {
      throw new Error('/tone must never call previewFamily');
    },
    commitFamily() {
      throw new Error('/tone must never call commitFamily');
    },
    commitTone(tone) {
      toneCommits.push(tone);
      if (tone === 'system') {
        followSystem = true;
      } else {
        current = concreteTheme(familyOf(current), tone);
        followSystem = false;
      }
    },
  };
  return { control, toneCommits };
}

type ApplyFn = (view: EditorView, completion: Completion, from: number, to: number) => void;

/** Finds an option by label in the currently active list and runs its own
 * `apply`, exactly as `acceptCompletion` (the library's Enter handler) would
 * — `from`/`to` both at the picker's anchor, matching "nothing was typed to
 * filter the list", the common case this whole fix is about. */
function pickByLabel(view: EditorView, label: string): void {
  const option = currentCompletions(view.state).find((o) => o.label === label)!;
  const anchor = view.state.field(tonePickerField)!.anchor;
  (option.apply as ApplyFn)(view, option, anchor, anchor);
}

// Goes through `tonePickerExtensions()` itself, not a hand-rolled
// `languageData.of(...)`, matching `slash-theme.test.ts`'s own rationale.
function makeView(control: ThemeControl, doc = ''): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [...tonePickerExtensions(control), autocompletion()],
    }),
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('tonePickerExtensions', () => {
  // Same identity-stability regression as `/theme`'s — a fresh source or
  // languageData object on every lookup would keep `completionStatus`
  // permanently `pending`.
  it('LanguageDataAt_ReturnsTheIdenticalSourceOnRepeatedLookups', () => {
    const { control } = fakeControl();
    const state = EditorState.create({ doc: '', extensions: tonePickerExtensions(control) });
    const first = state.languageDataAt<CompletionSource>('autocomplete', 0)[0];
    const second = state.languageDataAt<CompletionSource>('autocomplete', 0)[0];
    expect(second).toBe(first);
  });
});

describe('toneAction', () => {
  it('Run_OpensThePickerField_AnchoredAtTheCaret', () => {
    const { control } = fakeControl();
    const view = makeView(control, 'hello');
    view.dispatch({ selection: { anchor: 3 } });

    toneAction(control).run(view);

    expect(view.state.field(tonePickerField)).toEqual({ anchor: 3, selectionPlaced: false });
  });
});

describe('tonePickerSource', () => {
  it('FieldNotOpen_ReturnsNull', () => {
    const { control } = fakeControl();
    const view = makeView(control);
    const result = tonePickerSource(control)(new CompletionContext(view.state, 0, true));
    expect(result).toBeNull();
  });

  it('FieldOpen_ReturnsExactlyLightDarkFollowSystem', () => {
    const { control } = fakeControl();
    const view = makeView(control);
    view.dispatch({ effects: openTonePicker.of({ anchor: 0 }) });

    const result = tonePickerSource(control)(new CompletionContext(view.state, 0, true));

    expect(result).not.toBeNull();
    expect(result!.options.map((o) => o.label)).toEqual(['Light', 'Dark', 'Follow System']);
  });

  it('MarksExactlyTheCurrentToneAsCurrent', () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control);
    view.dispatch({ effects: openTonePicker.of({ anchor: 0 }) });

    const options = tonePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const current = options.filter((o) => o.detail === '● current');

    expect(current.map((o) => o.label)).toEqual(['Dark']);
  });

  it('FollowSystemOn_MarksFollowSystemAsCurrent_NotLightOrDark', () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: true });
    const view = makeView(control);
    view.dispatch({ effects: openTonePicker.of({ anchor: 0 }) });

    const options = tonePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const current = options.filter((o) => o.detail === '● current');

    expect(current.map((o) => o.label)).toEqual(['Follow System']);
  });

  it('Apply_CommitsTheTone_DeletesTypedFilterText_ButLeavesThePickerOpen', () => {
    // Unlike `/theme`, `/tone` never closes on Enter — see the file's own
    // doc comment for why (no preview means Enter is the only way to see a
    // choice applied at all, so the list has to stay around for more of
    // them).
    const { control, toneCommits } = fakeControl();
    const view = makeView(control, '');
    view.dispatch({ effects: openTonePicker.of({ anchor: 0 }) });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'dark' } });

    const options = tonePickerSource(control)(new CompletionContext(view.state, 4, true))!.options;
    const option = options.find((o) => o.label === 'Dark')!;
    (option.apply as ApplyFn)(view, option, 0, 4);

    expect(toneCommits).toEqual(['dark']);
    expect(view.state.doc.toString()).toBe('');
    // Re-armed at the post-delete position (0), not closed — `selectionPlaced`
    // resets to `false` so the marker-refresh correction fires again.
    expect(view.state.field(tonePickerField)).toEqual({ anchor: 0, selectionPlaced: false });
  });

  it('FollowSystemOption_CommitsSystem', () => {
    const { control, toneCommits } = fakeControl();
    const view = makeView(control, '');
    view.dispatch({ effects: openTonePicker.of({ anchor: 0 }) });

    const options = tonePickerSource(control)(new CompletionContext(view.state, 0, true))!.options;
    const option = options.find((o) => o.label === 'Follow System')!;
    (option.apply as (view: EditorView, completion: typeof option, from: number, to: number) => void)(
      view,
      option,
      0,
      0
    );

    expect(toneCommits).toEqual(['system']);
  });
});

describe('tone ordering (via tonePickerSource, boost)', () => {
  it('CM6sSortedActiveList_IsLightDarkFollowSystem_NotAlphabetical', async () => {
    const { control } = fakeControl();
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');

    const labels = currentCompletions(view.state).map((o) => o.label);
    expect(labels).toEqual(['Light', 'Dark', 'Follow System']);
  });
});

describe('initial selection on open', () => {
  it('SelectsTheCurrentTone_NotWhateverCM6AutoSelected', async () => {
    const { control } = fakeControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    expect(selectedCompletion(view.state)?.label).toBe('Dark');
  });
});

describe('no live preview at all', () => {
  // The whole point of splitting `/tone` out of `/theme`: paging through
  // tones must never repaint the window before Enter. `previewFamily` is
  // the only preview hook `ThemeControl` exposes, and `/tone` must never
  // call it, in any of: opening, initial-selection correction, arrow-key
  // navigation, or an abort.
  it('OpeningAndNavigating_NeverCallsPreviewFamily', async () => {
    const { control, familyPreviews } = fakeControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    const active = currentCompletions(view.state);
    const index = active.findIndex((o) => o.label === 'Light');
    view.dispatch({ effects: setSelectedCompletion(index) });
    view.dispatch({ effects: setSelectedCompletion((index + 1) % active.length) });

    expect(familyPreviews).toEqual([]);
  });

  it('AbortWithoutCommit_NeverCallsPreviewFamily_ButStillClearsAndCloses', async () => {
    const { control, familyPreviews } = fakeControl();
    const view = makeView(control, '');
    view.dispatch({ effects: openTonePicker.of({ anchor: 0 }) });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'zz' }, selection: { anchor: 2 } });
    expect(completionStatus(view.state)).toBeNull();

    await Promise.resolve();
    await Promise.resolve();

    expect(familyPreviews).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
    expect(view.state.field(tonePickerField)).toBeNull();
  });
});

describe('confirm-as-you-go: Enter applies and stays open', () => {
  it('Apply_KeepsThePopupOpen_AndMovesTheCurrentMarkerToWhatWasActuallyApplied', async () => {
    // Starts on Dark.
    const { control } = statefulControl({ current: 'aurora-dark', followSystem: false });
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);
    expect(currentCompletions(view.state).filter((o) => o.detail === '● current').map((o) => o.label)).toEqual([
      'Dark',
    ]);

    pickByLabel(view, 'Light');

    // Stays open and re-arms rather than closing.
    expect(view.state.field(tonePickerField)).not.toBeNull();
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    // The list no longer lies: the marker followed the commit, not the
    // stale pre-commit snapshot.
    const refreshed = currentCompletions(view.state);
    expect(refreshed.filter((o) => o.detail === '● current').map((o) => o.label)).toEqual(['Light']);
    // The highlight lands back on what was just applied too, so the next
    // arrow key continues from there instead of an unrelated index.
    expect(selectedCompletion(view.state)?.label).toBe('Light');
  });

  it('RepeatedEnterOnDifferentTones_AppliesEachOneInOrder_AnyNumberOfTimes', async () => {
    const { control, toneCommits } = statefulControl({ current: 'light', followSystem: false });
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    for (const label of ['Dark', 'Follow System', 'Light', 'Dark']) {
      pickByLabel(view, label);
      await waitUntil(() => completionStatus(view.state) === 'active');
      await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);
    }

    expect(toneCommits).toEqual(['dark', 'system', 'light', 'dark']);
    // Still open after four separate applies.
    expect(completionStatus(view.state)).toBe('active');
    expect(view.state.field(tonePickerField)).not.toBeNull();
  });

  it('RepeatedEnterOnTheAlreadyCurrentTone_DoesNotRecommit_NoRedundantBroadcast', async () => {
    const { control, toneCommits } = statefulControl({ current: 'dark', followSystem: false });
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    // "Dark" is already current — pressing Enter on it twice must not fire
    // `commitTone` (and thus not `broadcast_theme`) twice for an unchanged
    // value.
    pickByLabel(view, 'Dark');
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);
    pickByLabel(view, 'Dark');
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    expect(toneCommits).toEqual([]);
    // The picker itself is unaffected — still open, still usable.
    expect(view.state.field(tonePickerField)).not.toBeNull();
  });

  it('CaretPositionIsStable_AcrossSeveralApplies', async () => {
    // The command text is already gone by the time the picker opens
    // (`slash-commands.ts` deletes it before calling `run()`), so every
    // apply after that should keep resolving to the same document position
    // rather than drifting.
    const { control } = statefulControl({ current: 'light', followSystem: false });
    const view = makeView(control, 'above\n\nbelow');
    view.dispatch({ selection: { anchor: 6 } }); // the empty line between above/below

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    pickByLabel(view, 'Dark');
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);
    pickByLabel(view, 'Light');
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    expect(view.state.doc.toString()).toBe('above\n\nbelow');
    expect(view.state.selection.main.head).toBe(6);
    expect(view.state.field(tonePickerField)!.anchor).toBe(6);
  });
});

describe('Esc: closes without rolling back (there is nothing to roll back)', () => {
  it('EscWithoutEverApplying_ClosesWithoutChangingAnything', async () => {
    const { control, toneCommits } = fakeControl();
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    closeCompletion(view);
    await Promise.resolve();
    await Promise.resolve();

    expect(toneCommits).toEqual([]);
    expect(view.state.field(tonePickerField)).toBeNull();
  });

  it('EscAfterApplying_ClosesButLeavesTheLastAppliedToneInPlace_DoesNotRollBack', async () => {
    const { control, toneCommits } = statefulControl({ current: 'light', followSystem: false });
    const view = makeView(control, '');

    toneAction(control).run(view);
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    pickByLabel(view, 'Dark');
    await waitUntil(() => completionStatus(view.state) === 'active');
    await waitUntil(() => view.state.field(tonePickerField)?.selectionPlaced === true);

    // Esc: unlike `/theme`, there is no preview to roll back — the commit
    // already happened for real, so Esc is purely "stop browsing".
    closeCompletion(view);
    await Promise.resolve();
    await Promise.resolve();

    expect(toneCommits).toEqual(['dark']);
    expect(control.current).toBe('dark');
    expect(view.state.field(tonePickerField)).toBeNull();
  });
});
