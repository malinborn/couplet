import type { EditorView } from '@codemirror/view';
import { startCompletion, type Completion } from '@codemirror/autocomplete';
import { halfOf } from '../theme-resolve';
import type { SlashAction } from './slash-actions';
import type { ThemeControl } from './slash-theme';
import { t } from '../i18n';
import {
  createPickerCore,
  openPicker,
  pickerSource,
  pickerExtensions,
  commitSelection,
  type PickerCore,
} from './slash-picker';

/**
 * `/tone` — the counterpart to `/theme`'s family picker (`slash-theme.ts`).
 * Split out so listing themes never mixes light and dark options in one
 * scrollable list again: a user testing the original combined `/theme`
 * picker described paging through it, light→dark→light, as feeling like
 * "trying to kill an epileptic". `/theme` now only ever previews a palette
 * change in the tone already on screen; `/tone` is the only place brightness
 * changes, and it has **no live preview at all** — see `commit-only` note on
 * `pickerExtensions` below.
 *
 * Because there is no preview, Enter is the only way to see a tone applied
 * — so unlike `/theme`, Enter here does not close the list: it commits the
 * choice and leaves the picker open, re-selected on whatever was just
 * applied, so the user can keep paging and applying as many times as they
 * like before deciding they're done. Esc is what closes it, and since
 * nothing here was ever a preview, there is nothing to roll back — Esc
 * simply stops, leaving the last applied tone in place.
 */
export type ToneChoice = 'light' | 'dark' | 'system';

const TONE_PICKER_TYPE = 'md-theme-tone';

// Fixed order, not alphabetical — Light, Dark, Follow System, matching the
// order the spec calls out and the native Theme submenu's own grouping.
const TONE_CHOICES: readonly ToneChoice[] = ['light', 'dark', 'system'];

// Translated — unlike `slash-theme.ts`'s family names, these are ordinary
// descriptive words (matching `menu.theme.half_light`/`half_dark` and
// `menu.common.follow_system` in `locales/*/native.json`, which the native
// Theme submenu already uses for the same three concepts).
function toneLabel(choice: ToneChoice): string {
  if (choice === 'system') return t('editor.slash_tone.follow_system');
  return choice === 'dark' ? t('editor.slash_tone.dark') : t('editor.slash_tone.light');
}

// Reverse lookup, unused today (this picker never previews, so nothing ever
// needs to recover a `ToneChoice` from a `Completion` label) but kept for the
// same reason `slash-theme.ts` keeps its own: `pickerExtensions` always wants
// a `choiceForLabel`, and building it once alongside the labels keeps the two
// in sync by construction rather than by two authors remembering to agree.
//
// Built lazily, NOT as a module-level constant: `toneLabel` now calls `t()`,
// and this module is imported (hence evaluated) well before `main.ts` installs
// the language catalog — a top-level `new Map(...)` here would freeze every
// label in whatever `t()` returns before boot (see `familyLabel`'s comment in
// `slash-theme.ts`). Safe to cache after the first call: the active language
// never changes without a full app restart.
let labelToToneCache: ReadonlyMap<string, ToneChoice> | null = null;
function labelToTone(label: string): ToneChoice | undefined {
  if (!labelToToneCache) {
    labelToToneCache = new Map(TONE_CHOICES.map((choice) => [toneLabel(choice), choice]));
  }
  return labelToToneCache.get(label);
}

const picker: PickerCore = createPickerCore();

function isCurrentTone(control: ThemeControl, choice: ToneChoice): boolean {
  if (choice === 'system') return control.followSystem;
  return !control.followSystem && halfOf(control.current) === choice;
}

/**
 * `boost` fixes the list order (Light, Dark, Follow System) exactly as
 * `/theme`'s does — with an empty filter every option matches equally, so
 * `boost` is the whole ordering.
 */
function toneOptions(control: ThemeControl): Completion[] {
  return TONE_CHOICES.map((choice, index) => ({
    label: toneLabel(choice),
    detail: isCurrentTone(control, choice) ? `● ${t('editor.slash_picker.current')}` : undefined,
    type: TONE_PICKER_TYPE,
    boost: TONE_CHOICES.length - index,
    apply(view: EditorView, _completion: Completion, from: number, to: number) {
      // Applying the tone already on screen is a no-op for the store — most
      // often "confirm what I'm looking at" after paging back to it — so it
      // must not re-broadcast an unchanged value to every other window.
      if (!isCurrentTone(control, choice)) {
        control.commitTone(choice);
      }
      view.dispatch({
        // Clears any typed filter text, same as `/theme`. The picker itself
        // stays open: no `picker.close` here.
        changes: { from, to, insert: '' },
        // Forces CM6 to treat the (typically no-op, `from === to`) change
        // as invalidating — see `commitSelection`'s doc comment — so the
        // stale, pre-commit `● current` marker doesn't linger.
        selection: commitSelection(from),
        // Re-arms the field at its own anchor rather than closing it:
        // `pickerPreviewListener` reads this same `open` effect as "start
        // waiting for placement again", not as an abort (see its own doc
        // comment) — the correction that follows re-marks `● current` on
        // whatever was actually just applied and re-selects it, so a
        // repeated Enter (same tone or a different one) keeps working.
        effects: picker.open.of({ anchor: from }),
      });
      startCompletion(view);
    },
  }));
}

/** The `/tone` slash-menu entry. Only ever constructed when a `ThemeControl` exists. */
export function toneAction(control: ThemeControl): SlashAction {
  return {
    id: 'tone',
    label: '/tone',
    detail: t('editor.slash_tone.action_detail'),
    run(view: EditorView) {
      openPicker(picker, view);
    },
  };
}

export function tonePickerSource(control: ThemeControl) {
  return pickerSource(picker, () => toneOptions(control));
}

// Exposed for tests only — see the identical note in `slash-theme.ts`.
export const tonePickerField = picker.field;
export const openTonePicker = picker.open;
export const closeTonePicker = picker.close;

/**
 * Bundles the field, the second completion source, and the preview listener
 * — except there is no preview: the final argument to `pickerExtensions` is
 * `undefined`, so `preview()` is never invoked at all while `/tone` is open,
 * on any keystroke, hover, or arrow press. Only the initial-selection
 * correction (landing the highlight on the current tone) and the commit
 * itself still run — both independent of `preview`.
 */
export function tonePickerExtensions(control: ThemeControl) {
  return pickerExtensions<ToneChoice>(
    picker,
    tonePickerSource(control),
    TONE_PICKER_TYPE,
    (label) => labelToTone(label),
    undefined
  );
}
