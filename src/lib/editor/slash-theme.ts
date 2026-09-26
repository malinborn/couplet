import type { EditorView } from '@codemirror/view';
import type { Completion } from '@codemirror/autocomplete';
import { THEME_FAMILIES, concreteTheme, familyOf, halfOf, type ThemeFamily, type ConcreteTheme } from '../theme-resolve';
import type { SlashAction } from './slash-actions';
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
 * Everything the editor needs from the app's theme store, without importing
 * it directly. `createExtensions()` is called by both `Editor.svelte` and
 * `site/demos/editor-demo.ts` (the couplet.pro landing's demo cards) — a
 * direct import of the store would pull `localStorage`/`matchMedia` onto the
 * landing at module load time and let the demo editor repaint the whole page.
 *
 * `/theme` (this file) and `/tone` (`slash-tone.ts`) share this one control:
 * both are wired into the editor together (`setup.ts`), and `App.svelte`
 * builds a single object rather than two, mirroring the native Theme menu's
 * own split between family and half/"Follow System" — see `menu.rs`'s
 * `theme_family_*` / `theme_half_*` / `theme_system:*` events, which
 * `broadcastTheme` (`tauri/commands.ts`) already sends as separate payloads.
 */
export interface ThemeControl {
  /** The resolved concrete theme right now (family + on-screen tone). */
  readonly current: ConcreteTheme;
  /** Whether "Follow System" is on. */
  readonly followSystem: boolean;
  /**
   * `/theme`'s live preview: show `family` in whatever tone is currently on
   * screen — never previews a brightness change, only a palette one. `null`
   * clears the preview.
   */
  previewFamily(family: ThemeFamily | null): void;
  /**
   * `/theme`'s commit: family only. Must not touch the tone or turn off
   * "Follow System" — a family choice answers a different question than a
   * tone choice does.
   */
  commitFamily(family: ThemeFamily): void;
  /**
   * `/tone`'s commit (`slash-tone.ts`). No `previewTone` exists: `/tone` has
   * no live preview at all, by design (a family swap and a brightness swap
   * repainting the window together, mid-list-scroll, is the "epileptic vibe"
   * bug this split fixes).
   */
  commitTone(tone: 'light' | 'dark' | 'system'): void;
}

const THEME_FAMILY_PICKER_TYPE = 'md-theme-family';

// Deliberately NOT translated — `menu.rs`'s native Theme submenu makes the
// same call for the identical six values ("Названия семей ... имена
// собственные и не переводятся"): Classic/Aurora/Blueprint/Phosphor/Paper/Ink
// are the families' proper names, not descriptive words, and are the same literal
// strings `ThemeFamily` has used since this menu was "Default" rather than
// "Classic". A capitalized `family` also stays a safe, stable reverse-lookup
// key built once at module load — routing it through `t()` here would tie
// that lookup to catalog install order (see `resolveTemplateInsert`'s note
// in `block-templates.ts`: only functions called well after boot may call
// `t()` at all).
function familyLabel(family: ThemeFamily): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

// Reverse lookup for the preview listener: it only gets a `Completion` back
// from `selectedCompletion()` and has to recover which `ThemeFamily` it was
// built from. Labels are unique by construction (one per family).
const LABEL_TO_FAMILY: ReadonlyMap<string, ThemeFamily> = new Map(
  THEME_FAMILIES.map((family) => [familyLabel(family), family])
);

/**
 * Swatch colours per concrete theme, hardcoded rather than read from CSS
 * variables — a theme's `--bg-base` / `--color-heading` etc. are only
 * defined under that theme's own `[data-theme="..."]` selector
 * (`src/lib/theme/*.css`), so reading them while a *different* theme is
 * active would return the active theme's colours, not the one being
 * previewed. Two colours per theme, and not always the same CSS variable
 * across themes: e.g. blueprint-dark's own `--color-heading` is plain white,
 * so its accent dot instead uses the red-pencil colour that theme's own CSS
 * comments call out as its identity.
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
  // Paper's headings are plain ink, so both halves take the coral caret —
  // the one colour its CSS reserves for what is being changed.
  'paper-light': { bg: '#f3ede2', accent: '#e8563f' },
  'paper-dark': { bg: '#1d1a16', accent: '#e8563f' },
  'ink-light': { bg: '#efedf4', accent: '#c13e7b' },
  'ink-dark': { bg: '#1f1b2e', accent: '#ff8a6a' },
  'autumn-light': { bg: '#f4e5d1', accent: '#8a3f22' },
  'autumn-dark': { bg: '#2c1934', accent: '#ffa45c' },
  'odyssey-light': { bg: '#dde4e6', accent: '#7a5616' },
  'odyssey-dark': { bg: '#0e1418', accent: '#d4b06a' },
};

/**
 * A family option's own swatch colours, baked in at build time rather than
 * recomputed from the label in `renderThemeSwatch`. Safe to bake in once per
 * `themeOptions()` call: the on-screen tone cannot change while the family
 * picker is open — `previewFamily` only ever swaps the palette, never the
 * tone — so it is not "live" state within one picker session.
 */
interface ThemeFamilyCompletion extends Completion {
  swatchColors?: { bg: string; accent: string };
}

const picker: PickerCore = createPickerCore();

function isCurrentFamily(control: ThemeControl, family: ThemeFamily): boolean {
  return familyOf(control.current) === family;
}

/**
 * `boost` (not alphabetical, CM6's default) puts the list in `THEME_FAMILIES`
 * order, since that is the order the native Theme submenu already uses.
 * This only decides ties: with an empty filter every option matches
 * equally, so `boost` is the whole ordering.
 */
function themeOptions(control: ThemeControl): ThemeFamilyCompletion[] {
  const tone = halfOf(control.current);
  return THEME_FAMILIES.map((family, index) => ({
    label: familyLabel(family),
    detail: isCurrentFamily(control, family) ? `● ${t('editor.slash_picker.current')}` : undefined,
    type: THEME_FAMILY_PICKER_TYPE,
    boost: THEME_FAMILIES.length - index,
    swatchColors: SWATCH_COLORS[concreteTheme(family, tone)],
    apply(view: EditorView, _completion: Completion, from: number, to: number) {
      control.commitFamily(family);
      view.dispatch({
        changes: { from, to, insert: '' },
        // Forces CM6 to close the popup even when nothing was typed to
        // filter the list (`from === to`, the common case) — see
        // `commitSelection`'s doc comment. Enter used to leave the list
        // open in exactly that case: the family committed correctly, but
        // the (now stale) options stayed on screen since CM6 saw nothing
        // to invalidate.
        selection: commitSelection(from),
        effects: picker.close.of(null),
      });
    },
  }));
}

/** The `/theme` slash-menu entry. Only ever constructed when a `ThemeControl` exists. */
export function themeAction(control: ThemeControl): SlashAction {
  return {
    id: 'theme',
    label: '/theme',
    detail: t('editor.slash_theme.action_detail'),
    run(view: EditorView) {
      openPicker(picker, view);
    },
  };
}

export function themePickerSource(control: ThemeControl) {
  return pickerSource(picker, () => themeOptions(control));
}

// Exposed for tests only — production code never dispatches these directly,
// it goes through `themeAction`'s `run()` (`openPicker`) or an option's own
// `apply` (which closes the field itself).
export const themePickerField = picker.field;
export const openThemePicker = picker.open;
export const closeThemePicker = picker.close;

export function themePickerExtensions(control: ThemeControl) {
  return pickerExtensions<ThemeFamily>(
    picker,
    themePickerSource(control),
    THEME_FAMILY_PICKER_TYPE,
    (label) => LABEL_TO_FAMILY.get(label),
    (family) => control.previewFamily(family)
  );
}

/**
 * `autocompletion({ addToOptions })` renderer for the family picker's swatch
 * pair. Gated on `completion.type === THEME_FAMILY_PICKER_TYPE`:
 * `addToOptions` is global to the editor's one `autocompletion()` call, so an
 * ungated renderer would run for every completion in the app, including
 * `/tone`'s and language ones.
 */
export function renderThemeSwatch(completion: Completion): Node | null {
  if (completion.type !== THEME_FAMILY_PICKER_TYPE) return null;
  const colors = (completion as ThemeFamilyCompletion).swatchColors;
  if (!colors) return null;

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
