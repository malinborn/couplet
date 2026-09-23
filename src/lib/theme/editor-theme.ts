import { EditorView } from '@codemirror/view';

export const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-base)',
    backgroundImage: 'var(--bg-image, none)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-text)',
  },
  '.cm-content': {
    caretColor: 'var(--color-cursor)',
    fontFamily: 'var(--font-text)',
    padding: '0',
  },
  '.cm-cursor, .cm-dropCursor': {
    // borderLeftColor is inert once borderImage is set — the caret color comes
    // from the border-image gradient (solid via fallback in themes without
    // dedicated caret tokens).
    borderLeftColor: 'var(--color-cursor)',
    borderLeftWidth: '2px',
    borderImage:
      'linear-gradient(180deg, var(--color-caret-top, var(--color-cursor)), var(--color-caret-bottom, var(--color-cursor))) 1',
  },
  // Selection is drawn by CM6's `drawSelection()` extension (see setup.ts) as
  // `.cm-selectionBackground` rectangles, NOT native `::selection` — do not
  // add `.cm-content ::selection` back here. `drawSelection()` ships its own
  // `Prec.highest` rule that forces native `::selection` transparent so only
  // its JS-drawn overlay shows; `Prec.highest` controls facet resolution
  // order, not `<style>` insertion order, so that rule's `<style>` tag ends
  // up mounted *before* this theme's — meaning an `!important` here on
  // `::selection` used to win the cascade tie and made the browser paint a
  // real native selection after all. That's what caused the ask widget's
  // native-selection wash across its block-widget region (WebKit still
  // fills the row for `user-select: none` content mid-drag) — switching to
  // the drawn overlay computes background rectangles from real document
  // ranges, which have no width where the widget's line holds no text.
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--color-selection) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(var(--color-glow, 196, 167, 231), 0.04)',
    backgroundImage: 'linear-gradient(90deg, rgba(var(--color-glow, 196, 167, 231), 0.06) 0%, transparent 60%)',
    boxShadow: '0 0 12px 4px rgba(var(--color-glow, 196, 167, 231), 0.04)',
    borderRadius: '2px',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--color-line-highlight)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-primary)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--color-border)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--color-selection) !important',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    border: '1px solid var(--color-border)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--highlight)',
    },
  },
  // `/theme` picker swatches (slash-theme.ts's `renderThemeSwatch`, via
  // `autocompletion({ addToOptions })`). Colours are set inline per-option as
  // `background-color` — see the comment on `SWATCH_COLORS` for why they are
  // hardcoded rather than read from this theme's own CSS variables.
  '.cm-md-theme-swatches': {
    display: 'inline-flex',
    gap: '3px',
    marginRight: '6px',
    verticalAlign: 'middle',
  },
  '.cm-md-theme-swatch': {
    display: 'inline-block',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: '1px solid var(--color-border)',
  },
});
