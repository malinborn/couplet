// Landing page wiring only — copy lives in site/index.html so the page stays
// crawlable. This file: themes the chrome + embedded editors together, wires
// the install-command copy button, drives the AI-showcase carousel, and
// lazily mounts the four live editor demos in the carousel slides. The hero
// carries no demo — it is exactly what the design draws.

import './styles/fonts.css';
import '@app/lib/theme/aurora-dark.css';
import '@app/lib/theme/aurora-light.css';
import '@app/styles/editor.css';
import '@app/styles/editor-metrics.css';
// Landing tokens load last so its --bg family (and everything derived from it)
// wins over the app stylesheets, which assume they own the whole page.
import './styles/landing.css';
// Per-slide demo themes (see the file header for why these can't just be
// :root[data-theme] blocks). Order doesn't matter against landing.css: they
// scope to [data-demo-theme] / .demo[data-demo-theme], never to :root.
import './styles/demo-themes.css';

// One stylesheet per animated demo. Each is owned by its demo module so the
// slides can be worked on independently.
import './styles/demo-point.css';
import './styles/demo-edit.css';
import './styles/demo-ask.css';
import './styles/demo-comment.css';
import './styles/demo-anyway.css';
import './styles/demo-showcase.css';

const THEME_KEY = 'mdmini-site:theme';
const INSTALL_CMD = 'brew tap malinborn/mdmini && brew trust malinborn/mdmini && brew install --cask mdmini';

type ThemeMode = 'auto' | 'dark' | 'light';

function getStoredMode(): ThemeMode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* private browsing / storage disabled */
  }
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}

function systemPrefersDark(): boolean {
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

function nextMode(mode: ThemeMode): ThemeMode {
  if (mode === 'auto') return 'dark';
  if (mode === 'dark') return 'light';
  return 'auto';
}

function reinitializeEmbeddedMermaidTheme(): void {
  import('@app/lib/editor/preview/mermaid')
    .then((m) => m.reinitializeTheme())
    .catch(() => {
      /* no mermaid demo mounted yet — nothing to re-theme */
    });
}

function setupThemeToggle(): void {
  const button = document.getElementById('theme-toggle');
  const label = button?.querySelector<HTMLElement>('.theme-toggle-label');
  if (!button || !label) return;

  function render(mode: ThemeMode): void {
    const dark = mode === 'auto' ? systemPrefersDark() : mode === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'aurora-dark' : 'aurora-light');
    const text = mode === 'auto' ? 'Auto' : mode === 'dark' ? 'Dark' : 'Light';
    label!.textContent = text;
    button!.setAttribute('aria-label', `Theme: ${text.toLowerCase()} (click to change)`);
    reinitializeEmbeddedMermaidTheme();
  }

  button.addEventListener('click', () => {
    const mode = nextMode(getStoredMode());
    try {
      if (mode === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* private browsing / storage disabled — theme still applies for this load */
    }
    render(mode);
  });

  // Live system-preference changes only matter while the user hasn't picked
  // an explicit theme.
  const mql = window.matchMedia('(prefers-color-scheme: light)');
  mql.addEventListener('change', () => {
    if (getStoredMode() === 'auto') render('auto');
  });

  render(getStoredMode());
}

function setupCopyButton(): void {
  const button = document.getElementById('copy-install');
  const label = button?.querySelector<HTMLElement>('.copy-btn-label');
  if (!button || !label) return;

  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  button.addEventListener('click', () => {
    navigator.clipboard
      .writeText(INSTALL_CMD)
      .then(() => {
        label!.textContent = 'Copied';
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          label!.textContent = 'Copy';
        }, 1600);
      })
      .catch(() => {
        /* clipboard permission denied — leave the label alone */
      });
  });
}

function setupCarousel(): void {
  const carousel = document.getElementById('ai-carousel');
  const track = document.getElementById('carousel-track');
  const inner = document.getElementById('track-inner');
  const prevBtn = document.getElementById('carousel-prev');
  const nextBtn = document.getElementById('carousel-next');
  const dotsWrap = document.getElementById('carousel-dots');
  if (!carousel || !track || !inner || !prevBtn || !nextBtn || !dotsWrap) return;

  const slides = Array.from(inner.querySelectorAll<HTMLElement>('.slide'));
  const dots = Array.from(dotsWrap.querySelectorAll<HTMLButtonElement>('.carousel-dot'));
  const count = slides.length;
  if (count === 0) return;

  let index = 0;

  function render(): void {
    inner!.style.transform = `translateX(-${index * 100}%)`;
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
    // Slides stay in the DOM for crawlers; off-screen ones are just inert so
    // they don't steal keyboard/AT focus while translated out of view.
    slides.forEach((slide, i) => {
      if (i === index) slide.removeAttribute('inert');
      else slide.setAttribute('inert', '');
    });
  }

  function go(target: number): void {
    index = ((target % count) + count) % count;
    render();
  }

  prevBtn.addEventListener('click', () => go(index - 1));
  nextBtn.addEventListener('click', () => go(index + 1));
  dots.forEach((dot, i) => dot.addEventListener('click', () => go(i)));

  carousel.tabIndex = 0;
  carousel.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'ArrowRight') go(index + 1);
    else return;
    e.preventDefault();
  });

  // Upgrade from the no-JS scroll-snap strip to the transform-based carousel.
  track.classList.add('js-enabled');
  track.scrollLeft = 0;
  render();
}

interface DemoModule {
  mount: (container: HTMLElement) => void;
}

type DemoName = 'point' | 'edit' | 'ask' | 'comment' | 'anyway' | 'showcase';

async function loadDemo(name: DemoName): Promise<DemoModule> {
  switch (name) {
    case 'point':
      return import('./demos/point');
    case 'edit':
      return import('./demos/edit');
    case 'ask':
      return import('./demos/ask');
    case 'comment':
      return import('./demos/comment');
    case 'anyway':
      return import('./demos/anyway');
    case 'showcase':
      return import('./demos/showcase');
  }
}

function isDemoName(value: string | undefined): value is DemoName {
  return (
    value === 'point' ||
    value === 'edit' ||
    value === 'ask' ||
    value === 'comment' ||
    value === 'anyway' ||
    value === 'showcase'
  );
}

function setupDemoMounting(): void {
  const mounted = new WeakSet<HTMLElement>();

  function mountDemo(el: HTMLElement): void {
    if (mounted.has(el)) return;
    mounted.add(el);

    const height = el.dataset.demoHeight;
    if (height) el.style.setProperty('--demo-h', `${height}px`);

    const name = el.dataset.demo;
    // Most demos live inside an editor-window card and mount into its body. The
    // launch-ways slide has no window frame — it animates a terminal, a Dock and
    // mock windows — so its container IS the mount target. Its no-JS fallback
    // sits in a <noscript>, which the clear below leaves untouched.
    const body = el.querySelector<HTMLElement>('.demo-body') ?? el;
    if (!isDemoName(name)) return;

    loadDemo(name)
      .then((mod) => {
        body.querySelectorAll(':scope > :not(noscript)').forEach((n) => n.remove());
        mod.mount(body);
      })
      .catch((err: unknown) => {
        // A missing/broken demo degrades to an empty card, never a blank page.
        console.error(`[md-mini] demo "${name}" failed to mount`, err);
      });
  }

  const demoEls = Array.from(document.querySelectorAll<HTMLElement>('[data-demo]'));
  if (demoEls.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        mountDemo(el);
        observer.unobserve(el);
      }
    },
    { rootMargin: '200px' },
  );

  for (const el of demoEls) observer.observe(el);

  // The showcase (slide 5) demo needs a head start: its mermaid diagram
  // takes real wall-clock time to load and render (a dynamic `import`, then
  // `mermaid.render()` — see the pre-warm call inside showcase.ts's mount()),
  // so the sooner that starts, the more likely it's already done by the time
  // a visitor actually reaches slide 5. But the observer above watches each
  // `.demo` element's own geometry, and the carousel's `translateX` on
  // `#track-inner` moves every off-screen slide thousands of pixels to the
  // side — so slide 5's card never satisfies `rootMargin: '200px'` until a
  // visitor has already clicked or arrowed all the way to it. `#ai` itself,
  // unlike the slides inside it, sits in normal page flow — it isn't
  // translated — so this fires as soon as the carousel section is merely
  // scrolled near, independent of which slide is currently active.
  const aiSection = document.getElementById('ai');
  const showcaseEl = demoEls.find((el) => el.dataset.demo === 'showcase');
  if (aiSection && showcaseEl) {
    const prewarm = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          mountDemo(showcaseEl);
          prewarm.disconnect();
        }
      },
      { rootMargin: '600px' },
    );
    prewarm.observe(aiSection);
  }
}

setupThemeToggle();
setupCopyButton();
setupCarousel();
setupDemoMounting();
