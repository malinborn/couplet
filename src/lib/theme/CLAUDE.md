# Themes

A theme is a set of CSS custom properties on `:root[data-theme='<id>']`. Components read only those tokens; no component carries a colour of its own for something a token names. `theme-tokens.test.ts` enforces the contract below.

## The rules

- **Every theme defines the full token set.** The reference is `light.css`: whatever it defines, every other block defines too. The test fails on the first theme that lacks one.
- **Components use only tokens from the set** (or a declared optional hook, below). Never invent a `--color-*` name on the spot. An undefined `var(--x)` is not an error anywhere: the browser drops the declaration without a word, and the element takes whatever it inherits or the default. That is how the Find panel, the table toggle, the .env block and the mermaid controls lost their colours (`--color-text`, `--color-accent` and `--color-bg` never existed).
- **Adding a token means adding it to every theme in the same commit**, `light.css` included. A value that only some themes want is an optional hook instead.
- **Accent is `--color-glow`, an RGB triple** (`124, 58, 237`). Write `rgb(var(--color-glow))`, or `rgba(var(--color-glow), 0.2)` for a tint. It is the comma syntax: the triple does not mix with `rgb(… / a)`.

## The token set (from `light.css`)

| Group | Tokens |
|---|---|
| Surfaces | `--bg-base` (page, fields), `--bg-surface` (panels), `--bg-overlay`, `--highlight` (hover), `--color-code-bg`, `--color-line-highlight`, `--color-table-even-bg`, `--color-selection` |
| Text | `--text-primary`, `--text-subtle` (secondary, placeholders), `--text-muted` (quietest), `--color-code-text`, `--color-cursor` |
| Borders and rules | `--border` (UI), `--color-border`, `--color-table-border`, `--color-hr`, `--color-blockquote-border` |
| Accent | `--color-glow` (RGB triple), `--color-link`, `--color-checkbox` |
| Markdown | `--color-heading`, `--heading-tone-1` … `--heading-tone-6`, `--color-bold`, `--color-italic`, `--color-strikethrough`, `--color-list-marker` |
| AI | `--ai-edit-bg`, `--ai-edit-shimmer`, `--ai-ask-bg`, `--ai-ask-border`, `--ai-ask-chip-bg`, `--ai-ask-chip-hover-bg`, `--ai-ask-accent`, `--ai-ask-accent-text` |
| Fonts | `--font-text`, `--font-code` |

**Optional hooks**, which a theme may define on top of the set. Every read of one carries a fallback: `--heading-grad-1` … `-6`, `--heading-grad-span`, `--heading-vgrad-1` … `-6` (a vertical gradient painted on the heading's text span `.cm-md-heading-text`, not the line — glyph-relative percent stops that hold on every wrapped line; see the comment in `editor.css`), `--color-caret-top`, `--color-caret-bottom`, `--color-task-done`, `--color-task-done-line`, `--task-done-grad`, `--strikethrough-grad` with `--strikethrough-fill` (a pair: the gradient only shows behind a `transparent` fill, and the fill falls back to `currentColor` so every other theme renders struck text as before), `--table-header-grad`, `--table-header-text`, `--bg-image`. A theme defining anything else fails the test. Declare a new hook in `OPTIONAL_HOOKS` first.

**`tabs-*` tokens** are not theme tokens. They live on plain `:root` in `src/styles/tabs.css` (`--tabs-ai-*`, `--tabs-brand-*`, `--tabs-ease`, `--tabs-ui`, `--tabs-shadow-rgb`, `--tabs-shadow-a`), with per-theme overrides beside them there (`aurora-light`, `$='dark'`).

## Allowlist in the guard

- **Set at runtime** (`RUNTIME_SET`): `--notch-depth` (`TabNotch.svelte`, `setProperty`), `--tw` and `--ts` (`WindowCarousel.svelte`, `style:`). The test also checks each one is really set from code, so a stale entry fails.
- **Optional hooks** (`OPTIONAL_HOOKS`): the list above. Uses of `var()` inside comments are ignored. CodeMirror defines no CSS variables of its own, so there is nothing to exclude for it.

## Light/dark pairs and registration

A **family** (`classic`, `aurora`, `blueprint`, `phosphor`) has two **halves**. The theme id is `<family>-<half>`, except classic, which is bare `light` / `dark`: those two values sit in every existing user's settings, and in the `:root[data-theme$='light']` selectors. The suffix is load-bearing. `halfOf` is `endsWith('dark')`, and `$='light'` / `$='dark'` selectors (the syntax palette in `editor.css`, the tab shadows in `tabs.css`) apply to every family's half. «Follow system» switches the half and keeps the family (`theme-resolve.ts`).

A new family `x` needs all of these:

1. `src/lib/theme/x.css` with the `:root[data-theme='x-light']` and `:root[data-theme='x-dark']` blocks, each with the full set. Import it in `App.svelte` next to the others.
2. `theme-resolve.ts`: `ThemeFamily`, `THEME_FAMILIES`, `ConcreteTheme`. The stores (`createThemeStore`) and settings persistence follow from these.
3. The menu. In `src-tauri/src/menu.rs`, the `theme_family_x` check item and its entry in `ThemeMenuItems.families` (family labels are not localized). In `lib/tauri/events.ts`, `MenuAction`. In `App.svelte`, the `case 'theme_family_x'` → `theme.setFamily('x')`.
4. **Both app icons**: `design/couplet-icon/variants/x-light.png` and `x-dark.png` (classic's are `classic-*`). The Dock icon follows the theme, so it switches between the two. How they are rendered from the theme tokens is in [`design/couplet-icon/README.md`](../../../design/couplet-icon/README.md), under «Как пересобрать». Then run `scripts/build-dock-icons.sh` (512×512 copies into `src-tauri/dock-icons/`) and add both to `VARIANTS` in `src-tauri/src/dock_icon.rs` — its tests fail on a copy without a row and on a shipped family without a variant. A theme is not done without both.
5. Anything shared per half that the family wants different: the `$='light'` syntax palette in `editor.css`, and the tab shadows in `tabs.css`.

**The Dock icon follows the theme.** `src-tauri/src/dock_icon.rs`, driven by `sync_dock_icon` from an effect on `theme.committed` in `App.svelte` — the committed theme, not the `/theme` preview (a window closed mid-preview would otherwise leave the Dock on a theme nobody shows). It updates at startup, on an explicit pick, on a family change and under «Follow system». So every family needs both icons, or the Dock falls back to the bundle icon for that half.
