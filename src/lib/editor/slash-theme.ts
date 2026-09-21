import { EditorView } from '@codemirror/view';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
  currentCompletions,
  selectedCompletion,
  setSelectedCompletion,
  startCompletion,
} from '@codemirror/autocomplete';
import { THEME_FAMILIES, concreteTheme, familyOf, halfOf, type ConcreteTheme, type ThemeFamily } from '../theme-resolve';
import type { SlashAction } from './slash-actions';

/**
 * What `/theme` can hand the app: one of the eight concrete themes, or
 * `'system'`. `'system'` is not a ninth look of its own — it turns on
 * "Follow System" over whichever family is already active, exactly like the
 * native Theme menu's "Follow System" checkbox (a toggle over family+half,
 * not a fifth/ninth theme choice) — see `theme-resolve.ts`.
 */
export type ThemeChoice = ConcreteTheme | 'system';

/**
 * Everything the editor needs from the app's theme store, without importing
 * it directly. `createExtensions()` is called by both `Editor.svelte` and
 * `site/demos/editor-demo.ts` (the md-mini.com landing's demo cards) — a
 * direct import of the store would pull `localStorage`/`matchMedia` onto the
 * landing at module load time and let the demo editor repaint the whole page.
 */
export interface ThemeControl {
  /** The resolved concrete theme right now — marks a concrete option "current". */
  readonly current: ConcreteTheme;
  /** Whether "Follow System" is on — marks the System option "current" instead. */
  readonly followSystem: boolean;
  /** Show a choice without saving anything. `null` clears the preview. */
  preview(choice: ThemeChoice | null): void;
  /** Save the choice, correct the native menu, and broadcast to every window. */
  commit(choice: ThemeChoice): void;
}

const THEME_PICKER_TYPE = 'md-theme';

function familyLabel(family: ThemeFamily): string {
  // Classic has no prefix in the popup either — see concreteTheme's own
  // comment in theme-resolve.ts for why the identifier itself has none.
  return family === 'classic' ? '' : family.charAt(0).toUpperCase() + family.slice(1);
}

function themeLabel(choice: ThemeChoice): string {
  if (choice === 'system') return 'System';
  const prefix = familyLabel(familyOf(choice));
  const half = halfOf(choice) === 'dark' ? 'Dark' : 'Light';
  return prefix ? `${prefix} ${half}` : half;
}

const THEME_CHOICES: readonly ThemeChoice[] = [
  ...THEME_FAMILIES.flatMap((family): ThemeChoice[] => [
    concreteTheme(family, 'light'),
    concreteTheme(family, 'dark'),
  ]),
  'system',
];

// Reverse lookup for the preview listener: it only gets a `Completion` back
// from `selectedCompletion()` and has to recover which `ThemeChoice` it was
// built from. Labels are unique by construction (checked by
// slash-theme.test.ts), so this is safe.
const LABEL_TO_CHOICE: ReadonlyMap<string, ThemeChoice> = new Map(
  THEME_CHOICES.map((choice) => [themeLabel(choice), choice])
);

/**
 * Swatch colours per theme, hardcoded rather than read from CSS variables.
 *
 * A theme's `--bg-base` / `--color-heading` etc. are only defined under that
 * theme's own `[data-theme="..."]` selector (`src/lib/theme/*.css`) — reading
 * them while a *different* theme is active would return the active theme's
 * colours, not the one the swatch is previewing. Two colours per theme, and
 * not always the same CSS variable across themes: e.g. blueprint-dark's own
 * `--color-heading` is plain white, so its accent dot instead uses the
 * red-pencil colour that theme's own CSS comments call out as its identity.
 */
const SWATCH_COLORS: Record<ConcreteTheme, { bg: string; accent: string }> = {
  light: { bg: '#fafaf9', accent: '#2563eb' },
  dark: { bg: '#191724', accent: '#c4a7e7' },
  'aurora-light': { bg: '#efeeec', accent: '#5566ec' },
  'aurora-dark': { bg: '#171629', accent: '#8f9ff5' },
  'blueprint-light': { bg: '#f4f2e9', accent: '#123a7a' },
  'blueprint-dark': { bg: '#0c2b52', accent: '#ff7a59' },
  'phosphor-light': { bg: '#e9f0e4', accent: '#9a5b00' },
  'phosphor-dark': { bg: '#061008', accent: '#ffcf6b' },
};

/** Opens the picker; payload is the document position `/theme` used to occupy. */
export const openThemePicker = StateEffect.define<{ anchor: number }>();
/** Closes the picker, whether by commit or by abort. */
export const closeThemePicker = StateEffect.define<null>();
/**
 * Marks that the one-time initial selection (the current theme, not
 * whatever CM6 auto-selected) has landed — see `themePreviewListener`.
 */
export const themeSelectionPlaced = StateEffect.define<null>();

export interface ThemePickerState {
  readonly anchor: number;
  /**
   * `false` from the moment the picker opens until `themePreviewListener` has
   * corrected the selection to the current theme. While `false`, the listener
   * must not call `control.preview()` at all — CM6 auto-selects its first
   * sorted option (Light, given `themeOptions`'s `boost`) the instant the
   * list becomes active, regardless of what theme is on screen, and
   * previewing that would flash it before the correction lands.
   */
  readonly selectionPlaced: boolean;
}

/**
 * Whether the second completion step is active, and where it started.
 * Raised by `themeAction`'s `run()`; lowered either by a commit (an option's
 * own `apply`, in the same transaction as its edit) or by an abort
 * (`themePreviewListener`, on Esc / blur / click-away).
 */
export const themePickerField = StateField.define<ThemePickerState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openThemePicker)) return { anchor: effect.value.anchor, selectionPlaced: false };
      if (effect.is(closeThemePicker)) return null;
      if (effect.is(themeSelectionPlaced) && value) return { ...value, selectionPlaced: true };
    }
    if (value && tr.docChanged) {
      return { ...value, anchor: tr.changes.mapPos(value.anchor) };
    }
    return value;
  },
});

function isCurrent(control: ThemeControl, choice: ThemeChoice): boolean {
  if (choice === 'system') return control.followSystem;
  return !control.followSystem && control.current === choice;
}

/**
 * `boost` (not alphabetical, CM6's default) puts the list in `THEME_CHOICES`
 * order — by family, light before dark within a family, System last — since
 * that reads as a coherent menu and alphabetical order does not (it scatters
 * the two halves of every family and buries Light/Dark, the two most-used
 * entries, mid-list behind every "Aurora"/"Blueprint"/"Phosphor"). This only
 * decides ties: with an empty filter every option matches equally, so `boost`
 * is the whole ordering; typing a filter still ranks a better text match
 * first, `boost` only breaks ties among equally-good matches.
 */
function themeOptions(control: ThemeControl): Completion[] {
  return THEME_CHOICES.map((choice, index) => ({
    label: themeLabel(choice),
    detail: isCurrent(control, choice) ? '● current' : undefined,
    type: THEME_PICKER_TYPE,
    boost: THEME_CHOICES.length - index,
    apply(view: EditorView, _completion: Completion, from: number, to: number) {
      control.commit(choice);
      view.dispatch({
        changes: { from, to, insert: '' },
        effects: closeThemePicker.of(null),
      });
    },
  }));
}

/**
 * Step 2 of `/theme`. A separate completion source rather than an extension
 * of the block/action source's regex (`slash-commands.ts`): that regex
 * requires a leading `/` and stops at the first non-word character, so it
 * could never match `/theme aurora-light` in the first place. This source
 * instead keys off `themePickerField` and matches from its anchor to the
 * cursor, whatever the user has typed there to filter the list.
 */
export function themePickerSource(control: ThemeControl) {
  return (context: CompletionContext): CompletionResult | null => {
    const picker = context.state.field(themePickerField, false);
    if (!picker) return null;
    return { from: picker.anchor, options: themeOptions(control) };
  };
}

/** The `/theme` slash-menu entry. Only ever constructed when a `ThemeControl` exists. */
export function themeAction(control: ThemeControl): SlashAction {
  return {
    id: 'theme',
    label: '/theme',
    detail: 'Switch the app theme',
    run(view: EditorView) {
      const anchor = view.state.selection.main.head;
      view.dispatch({ effects: openThemePicker.of({ anchor }) });
      startCompletion(view);
    },
  };
}

/**
 * Live preview + abort handling while the picker is open.
 *
 * Initial selection: CM6 auto-selects its first sorted option (the highest
 * `boost`, i.e. Light) the instant the list becomes `active`, regardless of
 * what theme is actually on screen. Left alone, `preview()` would follow that
 * auto-selection and flash Light — or whichever theme sorts first — for one
 * frame on every single open, unrelated to the current theme. So while
 * `picker.selectionPlaced` is `false`, this never calls `control.preview()`
 * at all; instead, the moment `completionStatus` first reports `'active'`, it
 * dispatches `setSelectedCompletion` at the option marked `'● current'`
 * (`themePickerSource`'s own marking, not recomputed here) plus
 * `themeSelectionPlaced`, in one transaction — so the *next* update sees
 * `selectionPlaced: true` and a `selectedCompletion()` that already matches
 * what's on screen, and normal preview-following starts from there. The
 * `placing` flag guards against queuing that dispatch more than once per
 * opening (CM6 can report `'active'` on more than one update in a row before
 * our own dispatch lands).
 *
 * Preview (once placed): follows `selectedCompletion()` on every update, so
 * arrow keys and mouse hover repaint the window immediately. A committed
 * choice closes the field itself (via `closeThemePicker`) in the very same
 * transaction as its edit, so the `if (!picker) return` guard below already
 * excludes it — nothing left to preview once it is saved.
 *
 * Abort: the picker is still open but the popup just closed on its own
 * (Esc, blur, click elsewhere) — a commit would have closed `themePickerField`
 * itself in the same transaction, so this only fires for the cases nothing
 * else already handled. One extra guard is required: `themeAction.run()`
 * dispatches `openThemePicker` and calls `startCompletion()` as two separate
 * transactions, so for one tick `themePickerField` is set but
 * `completionStatus` is still `null` — without excluding "the transaction
 * that just opened the field", that tick reads as an instant abort before the
 * popup ever appears. The delete-and-close dispatch is deferred with
 * `queueMicrotask`, matching `preview/table-selection.ts`'s snap-out, to
 * avoid dispatching from inside an update listener.
 */
export function themePreviewListener(control: ThemeControl): Extension {
  let placing = false;

  return EditorView.updateListener.of((update) => {
    const picker = update.state.field(themePickerField, false);
    if (!picker) {
      placing = false;
      return;
    }

    if (!picker.selectionPlaced) {
      if (!placing && completionStatus(update.state) === 'active') {
        placing = true;
        const index = currentCompletions(update.state).findIndex((o) => o.detail === '● current');
        queueMicrotask(() => {
          update.view.dispatch({
            effects:
              index >= 0
                ? [setSelectedCompletion(index), themeSelectionPlaced.of(null)]
                : [themeSelectionPlaced.of(null)],
          });
        });
      }
      // No preview() until the correction above lands — see doc comment.
    } else {
      const selected = selectedCompletion(update.state);
      control.preview(
        selected && selected.type === THEME_PICKER_TYPE
          ? (LABEL_TO_CHOICE.get(selected.label) ?? null)
          : null
      );
    }

    const wasOpenBefore = update.startState.field(themePickerField, false) !== null;
    if (wasOpenBefore && completionStatus(update.state) === null) {
      placing = false;
      const head = update.state.selection.main.head;
      queueMicrotask(() => {
        control.preview(null);
        update.view.dispatch({
          changes: { from: picker.anchor, to: head, insert: '' },
          effects: closeThemePicker.of(null),
        });
      });
    }
  });
}

/**
 * Bundles the field, the second completion source, and the preview listener.
 *
 * The languageData record is built ONCE, outside the arrow passed to
 * `.of()`, and captured by reference — not reconstructed inside it. CM6 calls
 * that arrow on every `languageDataAt` lookup (not once at setup) and detects
 * whether the active source set changed by comparing the returned providers'
 * *identity*. A fresh `{ autocomplete }` object (and a fresh
 * `themePickerSource(control)` closure) on every lookup reads as "the sources
 * changed" on every single query, forever, so `completionStatus` never left
 * `pending` and the picker never opened — measured in a real browser, not a
 * jsdom artefact. See the identical fix in `slash-commands.ts`.
 */
export function themePickerExtensions(control: ThemeControl): Extension[] {
  const data = [{ autocomplete: themePickerSource(control) }];
  return [themePickerField, EditorState.languageData.of(() => data), themePreviewListener(control)];
}

/**
 * `autocompletion({ addToOptions })` renderer for the theme picker's swatch
 * pair. Gated on `completion.type === THEME_PICKER_TYPE`: `addToOptions` is
 * global to the editor's one `autocompletion()` call, so an ungated renderer
 * would run for every completion in the app, including language ones.
 * Returns `null` for "System": it has no fixed colours of its own to preview.
 */
export function renderThemeSwatch(completion: Completion): Node | null {
  if (completion.type !== THEME_PICKER_TYPE) return null;
  const choice = LABEL_TO_CHOICE.get(completion.label);
  if (!choice || choice === 'system') return null;

  const colors = SWATCH_COLORS[choice];
  const wrap = document.createElement('span');
  wrap.className = 'cm-md-theme-swatches';
  for (const color of [colors.bg, colors.accent]) {
    const dot = document.createElement('span');
    dot.className = 'cm-md-theme-swatch';
    dot.style.backgroundColor = color;
    wrap.appendChild(dot);
  }
  return wrap;
}
