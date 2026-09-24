<script lang="ts">
  /**
   * The notch (spec §6 «Хлястик»): the protruding tab of a paper folder at the
   * window's left edge, fixed to the drawer's right edge so it slides with it.
   * All its text reads bottom to top — `#N` in the theme's accent, the tab
   * count, a hairline, the drawer key. It shimmers with the AI gradient while
   * the window holds unviewed tabs; its accessible name says so in words.
   * Geometry and colours are the mockup's.
   */
  import { plural, t } from '../i18n';

  let {
    number,
    count,
    unviewed,
    bump,
    open,
    keyLabel,
    onenter,
    onleave,
    onclick,
  }: {
    number: number | null;
    count: number;
    /** How many tabs are unviewed. */
    unviewed: number;
    /** Goes up each time an unviewed tab arrives: the count gives a small jump. */
    bump: number;
    open: boolean;
    keyLabel: string;
    onenter: () => void;
    onleave: () => void;
    onclick: () => void;
  } = $props();

  const label = $derived(
    [
      t('tabs.notch.aria', { n: number ?? '' }),
      plural(count, 'tabs.drawer.count'),
      unviewed > 0 ? plural(unviewed, 'tabs.notch.unviewed') : '',
    ]
      .filter(Boolean)
      .join(', ')
  );

  let shapeEl: HTMLSpanElement | undefined = $state();
  let notchEl: HTMLButtonElement | undefined = $state();

  // Restart, not just set: a class that is already on replays nothing, and
  // off-then-on inside one frame never reaches the style engine. Drop it,
  // force a reflow, put it back (the mockup's `aiOpensBackground`).
  $effect(() => {
    const el = notchEl;
    if (!el || bump === 0) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  });

  // The AI button below the notch rests out by exactly the notch's visible
  // depth, so the two read as one column at the window edge (spec §6: «Под
  // язычком — существующая кнопка ИИ»). Measured, not hard-coded: the
  // trapezoid is a perspective projection — ≈25.8px of a 41px box — and the
  // mockup measures it the same way (`syncNotchDepth`). Only while the drawer
  // is in: with it out, the notch is not at the edge.
  $effect(() => {
    const el = shapeEl;
    if (!el) return;
    const measure = () => {
      if (el.closest('.open')) return;
      const depth = el.getBoundingClientRect().right;
      if (depth > 0) document.documentElement.style.setProperty('--notch-depth', `${depth.toFixed(2)}px`);
    };
    measure();
    void document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
</script>

<button
  type="button"
  class="notch"
  class:ai={unviewed > 0}
  bind:this={notchEl}
  aria-expanded={open}
  aria-controls="tab-drawer"
  aria-label={label}
  title={t('tabs.notch.title', { n: number ?? '', key: keyLabel })}
  onpointerenter={onenter}
  onpointerleave={onleave}
  {onclick}
  onmousedown={(e) => {
    // A press on the button blurs the editor (WebKit), and the drawer can only
    // give focus back on close if it saw where it was when it opened.
    e.preventDefault();
  }}
>
  <span class="shape" aria-hidden="true" bind:this={shapeEl}><span class="glow"></span></span>
  <span class="wid" aria-hidden="true">#{number ?? ''}</span>
  <span class="cnt" aria-hidden="true">{count}</span>
  <span class="nk" aria-hidden="true">{keyLabel}</span>
</button>

<style>
  .notch {
    position: absolute;
    top: 12px;
    left: calc(100% - 1px);
    width: 30px;
    height: 150px;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    outline: none;
    transition: height 0.25s var(--tabs-ease);
  }

  /* The trapezoid is a perspective-rotated box, so border, radius, shadow and
     the AI gradient all follow the shape. */
  .shape {
    position: absolute;
    left: 0;
    top: 0;
    width: 41px;
    height: 100%;
    overflow: hidden;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: none;
    border-radius: 0 9px 9px 0;
    transform-origin: left center;
    transform: perspective(63px) rotateY(30deg);
    box-shadow:
      0 3px 0 -1px var(--bg-surface),
      0 3px 0 0 var(--border),
      4px 5px 14px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.1));
    transition:
      transform 0.22s var(--tabs-ease),
      box-shadow 0.6s ease,
      border-color 0.6s ease,
      height 0.25s var(--tabs-ease);
  }

  .notch:hover .shape,
  .notch:focus-visible .shape {
    transform: perspective(63px) rotateY(24deg);
  }

  .notch:focus-visible .shape {
    border-color: var(--text-muted);
  }

  .glow {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.9s ease;
    background: var(--tabs-ai-grad-v);
    background-size: 100% 300%;
  }

  .notch.ai .glow {
    opacity: 0.45;
    animation: shimmerV 5s ease-in-out infinite alternate;
  }

  :global(:root[data-theme$='dark']) .notch.ai .glow {
    opacity: 0.3;
  }

  .notch.ai .shape {
    border-color: color-mix(in oklab, var(--tabs-ai-a) 55%, var(--border));
    box-shadow:
      0 3px 0 -1px var(--bg-surface),
      0 3px 0 0 var(--border),
      4px 5px 18px rgba(245, 144, 225, 0.38);
  }

  /* Vertical, reading bottom to top: rotated 180° from vertical-rl. */
  .wid,
  .cnt,
  .nk {
    position: relative;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    line-height: 1;
    margin-left: -3px;
  }

  /* The window number in the theme's accent (`--color-glow` is each theme's
     accent triple), with its heading gradient where the theme has one. */
  .wid {
    margin-bottom: 5px;
    font-family: var(--font-code);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.04em;
    color: rgb(var(--color-glow));
  }

  @supports ((-webkit-background-clip: text) or (background-clip: text)) {
    .wid {
      background-color: rgb(var(--color-glow));
      background-image: var(--heading-grad-2, none);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
  }

  .cnt {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .notch.ai .cnt {
    color: var(--text-primary);
    opacity: 0.75;
  }

  .notch:global(.bump) .cnt {
    animation: bump 0.5s var(--tabs-ease);
  }

  /* Rotated 180°, so its bottom border lands on top — a hairline under the count. */
  .nk {
    display: block;
    margin-top: 7px;
    padding-bottom: 7px;
    border-bottom: 1px solid color-mix(in oklab, var(--text-muted) 45%, transparent);
    font-family: var(--tabs-ui);
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  @keyframes shimmerV {
    0% {
      background-position: 50% 0%;
    }
    100% {
      background-position: 50% 100%;
    }
  }

  /* The rotation stays in the keyframe: without it the count flips upright mid-bump. */
  @keyframes bump {
    40% {
      transform: rotate(180deg) scale(1.5);
      color: var(--text-primary);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .notch.ai .glow {
      animation: none;
      background-position: 50% 50%;
    }
    .notch:global(.bump) .cnt {
      animation: none;
    }
  }
</style>
