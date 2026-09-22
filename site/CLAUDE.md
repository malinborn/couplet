# site/ — the couplet.pro landing

The marketing page for couplet.pro (the product formerly known as md-mini — the app,
CLI, cask, tap and MCP server still go by `mdmini` until the renamed release; see the
rebrand plan in `docs/superpowers/plans/`). Its distinguishing idea: **the demos are the
real app**. Every editor on the page is an actual CodeMirror 6 instance running the
app's own live-preview decorations, themes, mermaid renderer, AI highlights and question
widgets — imported straight from `src/`. Nothing here is a screenshot or a mockup of the
editor.

Read this before changing anything under `site/`. Most of what follows was learned the
hard way and is invisible until it bites.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev:site` | Vite dev server for the landing on **1421**. What you use to look at changes. |
| `npm run build:site` | Builds `site/` → `docs/`. **Run `rm -rf docs/assets` first** (see below). |
| `node site/__tests__/landing.manual.ts` | Playwright checks against the **built** page. Needs `npx http-server docs -p 8901 -c-1` running. |

## How it ships

- Sources are in `site/`; `vite.config.site.ts` builds them into **`docs/`**, and the
  build output **is committed**. `.github/workflows/deploy-site.yml` rsyncs `docs/` to
  the server on every push to `main` touching `docs/**`. So a content change means:
  edit `site/`, rebuild, commit **both** `site/` and `docs/`.
- `docs/` also holds hand-maintained files the build must not eat — `screenshot.png`,
  `robots.txt`, `sitemap.xml`, `llms.txt`, the favicons, `sample.md`, and the internal
  `*.md` docs. Hence `emptyOutDir: false` in the config.
- The same `docs/index.html` is also what GitHub Pages serves as the archive. It carries
  `rel=canonical` → couplet.pro plus a JS redirect that only fires on a `.github.io`
  hostname, rewriting the GH Pages project path (`/mdmini/…`, since the repo itself is
  not renamed) onto the new domain's root. Don't remove either; Pages cannot 301 to an
  external domain, so that pair is the whole migration story.

## Practices

- **Copy lives in the markup, never injected by JS.** The page has to rank, so every
  sentence a visitor reads must be in `site/index.html` and present in the served HTML.
  `site/main.ts` only wires interaction and mounts demos. Exactly one `<h1>` (the hero);
  slide headings are `<h2>`.
- **Demo chrome may be built in JS** — terminals, Dock, mock windows, chat panels are
  decorative, so they're fine to construct in a module. Mark them `aria-hidden="true"`
  and keep them out of the tab order; the slide's real copy carries the meaning.
- **Each animated demo owns one module and one stylesheet** — `site/demos/<name>.ts` +
  `site/styles/demo-<name>.css`, imported from `main.ts`. This split exists so several
  slides can be worked on in parallel without fighting over one file. Keep it.
- **Every demo must degrade.** `main.ts` mounts lazily via `IntersectionObserver` inside
  try/catch: a broken demo leaves an empty card, never a blank page. The carousel also
  works with JS off (scroll-snap baseline, all five slides in the DOM).
- **Respect `prefers-reduced-motion` in every demo** — `prefersReducedMotion()` from
  `./demos/editor-demo`. Render one settled, composed frame; no loops, no typing.
- **Pause when off-screen or `document.hidden`.** Several demos loop forever; none of
  them may burn CPU in a background tab.
- Keep claims honest: **couplet ships no AI of its own.** Slides say "your agent"; the
  demo terminals label the agent's lines explicitly so a visitor doesn't think they have
  to type mdmini commands by hand. Any command shown must match `docs/ai-interface.md`.

## Gotchas

### Build & tooling

- **`rm -rf docs/assets` before every build.** `emptyOutDir: false` means Vite never
  cleans, so content-hashed chunks from every previous build pile up forever — including
  fully orphaned ones (a `hero-*.js` survived long after that demo was deleted).
- **Never run two Vite dev servers at once** (`npm run dev` on 1420 and `npm run dev:site`
  on 1421). They share `node_modules/.vite/deps`, and the second to start corrupts it so
  that `@lezer/markdown` silently stops parsing — the editor renders raw markdown with
  **zero console errors**, which looks exactly like a decoration bug. Run them
  sequentially, or `vite --force` after switching.
- **The verification script is `landing.manual.ts`, not `.spec.ts`.** Vitest's default
  include glob matches `*.spec.ts` by filename in any directory, so a `.spec.ts` here
  gets collected by a bare `vitest` run and fails for having no `describe`. It runs
  directly on node (native TS stripping) and drives installed Chrome via
  `channel: 'chrome'` — the repo's cached Playwright browser lags the CLI.
- **A raw NUL byte in a `.ts` file makes git treat it as binary.** A cache key was
  written as `` `${theme}\x00${source}` `` with a literal NUL; diffs and merges on that
  file silently stopped working. Write it as the `\u0000` escape — same value at runtime,
  file stays text.
- **Demo values must never look like real credentials.** The `.env` document in the
  ribbon originally used the actual Stripe/GitHub/OpenAI key formats; GitHub's push
  protection blocked the push, and fixing only `HEAD` doesn't help because the strings
  live in the committed history too. Masking keys off the **variable name**, so a value's
  shape was never load-bearing — use obvious placeholders.

### Mounting the real editor outside the app

- **Reading metrics live in `src/styles/editor-metrics.css`** (`padding: 2rem`,
  `font-size: 16px`, `line-height: 1.6` on `.cm-scroller`, via `.md-editor-host`). They
  used to sit in `Editor.svelte`'s *scoped* styles, so an editor mounted outside that
  component silently rendered with none of them — that single omission was why the demos
  "didn't look like mdmini". If you mount an editor anywhere new, put `md-editor-host` on
  the host element.
- **Park the selection away from content.** `cursorInRange()` in the preview layer
  reveals raw markdown wherever the selection sits, and the default anchor is offset 0 —
  so line 1 renders as `# Heading` unless you move it. `mountDemoEditor` appends a
  trailing blank line and anchors there.
- **`EditorView.scrollIntoView` can scroll the page.** It walks up to the nearest
  scrollable ancestor; finding none between the card and `<body>`, it calls
  `window.scrollBy` — which yanked a reader back to the carousel every 3.2s. Scroll the
  card's own `.cm-scroller` directly instead.
- **CM6 only extends its *drawn* viewport on scroll events, once per gesture.** A
  decoration whose position is outside that viewport has no `.cm-line` to attach to, so
  it silently doesn't render even though the state is correct — a second pulse target
  never appeared for this reason. Force a viewport recompute (a `scrollIntoView` with
  `y: 'nearest'`) and revert any page drift it causes.
- **`scrollTop` is integer-rounded.** The ribbon scrolls at ~14px/s, so each frame's
  delta is a fraction of a pixel; reading `scrollTop`, adding, and writing back discarded
  it every frame and the ribbon never moved. Keep a float accumulator and write to the
  DOM once per frame.
- **Hide the insert gutter.** `createExtensions()` includes `hoverBlockMenu()`, so a
  read-only demo still gets `.cm-hover-menu-btn` buttons. `display: none` on
  `.cm-hover-gutter` keeps them out of the tab order and the accessibility tree.
- **Mermaid renders lazily and only inside the CM6 viewport**, behind a 300ms debounce and
  a dynamic `import('mermaid')`. Left alone, a visitor reaches the slide long before the
  diagram exists — pre-warm it when the carousel section approaches. Note the per-demo
  `IntersectionObserver` never fires for off-screen carousel slides, because the track
  translates them thousands of pixels away; observe `#ai` instead.

### Layout

- **A card that grows on mount breaks the ribbon.** The carousel row is as tall as its
  tallest slide, so a card that gains height on mount shifts the controls under a
  stationary cursor; the browser then fires a synthetic `pointerenter` and the ribbon's
  hover-pause latches forever. Reserve the height inline in the markup (`--demo-h`) and
  give `.demo-body` `min-height` as well as `max-height`.
- **`mountDemoEditor`'s `height` option overrides the markup's `--demo-h`.** Two sources
  of truth for the same number; changing the HTML alone did nothing. Prefer the markup
  and leave the option out.
- **Keep all five slides the same height.** When the chrome panel moved out of the right
  column, slide 5 quietly became the tallest — its copy sits *above* its demo, so the two
  heights add instead of one capping the row.
- **`.slide--showcase` centres its own copy, and `text-align` inherits into
  `.cm-content`.** That silently centred every line of the ribbon, which the real app
  never does. `.demo` resets `text-align: left` for this reason.
- **Reduced-motion overrides must come *after* the rules they beat.** Same specificity
  means source order decides, so a `@media (prefers-reduced-motion)` block placed earlier
  in the file loses — reduced-motion visitors kept the hero's raw `#` and `**` markers on
  screen permanently.

### The hero field

- **A feathered rectangle is still a rectangle.** Masking the container's edges makes the
  falloff smooth but leaves the *silhouette* axis-aligned, and that reads as a soft-edged
  box. Proving "the edge is smooth" does not close a "there's still a rectangle" report —
  measure the shape instead: threshold luminance across many scanlines and check whether
  the lit region's start/end vary by row and over time.
- **The lights must define the shape, not the mask.** Every source stays comfortably
  smaller than its container so its own falloff reaches zero before any edge; the mask is
  only insurance on the outer few percent.
- **Overlap is what produces iridescence.** Fourteen small dots over a 2000px field cover
  ~22% of it and barely intersect, so only brightness moves. Large overlapping washes
  underneath (600–1000px at that width) with small bright cores on top is what makes
  colour actually shift. The wash palette spans only ~70° of hue, which caps how dramatic
  that shift can get.
- **Compositor-only, always — except the one deliberate exception.** The CSS blob field
  (`.hero-aurora-field`, dark theme and the light-theme no-WebGL fallback) still animates
  `transform`, `opacity` and `background-position` only, with static `filter: blur()`, per
  the rule above. Light theme's *realistic* aurora (`site/hero-aurora.ts`, owner-requested
  "aurora at noon" gag) is the intentional exception: a WebGL fragment shader on a canvas,
  driven by a capped-FPS `requestAnimationFrame` loop. It REPLACES the blob field for
  light theme (toggled via `.is-realistic`/`.is-fallback` on `.hero-aurora`), never layers
  on top of it, and is paused by `IntersectionObserver` + `visibilitychange` + a DPR cap —
  read the file header before touching either the shader or the rest of this section's
  rules, since they were written before this exception existed.
- **A full-bleed layer needs `overflow: hidden` on the hero**, or blurred children add to
  page `scrollWidth`. Check for horizontal overflow at 360, 390, 1280 **and** 2000 —
  wide viewports are where this shows.
- **`::selection` accepts only a flat colour.** No browser renders a gradient there. The
  page fakes it by sampling one stop of the brand gradient per section, so scrolling reads
  as the gradient even though any single selection is solid.

### Themes

- **`:root[data-theme]` is global**, so per-slide themes need the token blocks
  re-declared under a scoped selector. `site/styles/demo-themes.css` is a **hand-written
  mirror** of the four files in `src/lib/theme/` — if a theme's tokens change there, this
  file must be regenerated by hand. A scoped block also can't inherit `--bg-image` from
  `:root`, so aurora-light's gradient is repeated in it.
- **Each demo card carries both `data-demo-theme` and `data-theme`** with the same value:
  the first scopes the CSS, the second is what mermaid's theme resolver keys off
  (`view.dom.closest('[data-theme]')`).
- **Card chrome must follow the card's own theme**, not the page's — a light editor inside
  dark chrome reads as broken.

### Working with agents on this page

- **The Playwright MCP browser is shared.** Two agents driving it clobber each other's
  navigations mid-sequence, which looks exactly like a bug in your own code. When more
  than one agent is active, each should script its own browser via the `playwright`
  devDependency and use its own port.
- **Give each agent one demo module plus its stylesheet**, and let one agent own
  `index.html`/`landing.css` at a time. That's the split the per-slide CSS files exist for.
- **The design source** is a Claude Design project (`mdmini Landing v2.dc.html`). It's a
  template with `{{ }}` bindings, `style-hover`, `sc-for` and `<image-slot>` — a visual
  reference, not code to copy. Its changelog content was invented; the real release
  history is the source of truth.
