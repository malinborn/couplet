<script lang="ts">
  /**
   * The notch (spec §6 «Хлястик»): the protruding tab of a paper folder at the
   * window's left edge, fixed to the drawer's right edge so it slides with it.
   * All its text reads bottom to top — `#N` in the theme's accent, the tab
   * count, a hairline, the drawer key. It shimmers with the AI gradient while
   * the window holds unviewed tabs; its accessible name says so in words.
   * Geometry and colours are the mockup's.
   *
   * With the drawer open, a double-click on `#N` turns it into a number input
   * (spec §3): Enter asks `onrenumber`, Esc or blur cancels, a refusal shakes
   * it. A single click on `#N` then waits out the double-click before it does
   * what a click on the notch does; everywhere else it acts at once.
   */
  import { tick } from 'svelte';
  import { plural, t } from '../i18n';
  import { DOUBLE_CLICK_MS, parseWindowNumber, type RenumberResult } from './window-number';

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
    editable = false,
    onrenumber,
    oneditstart,
    oneditend,
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
    /** The drawer is open: `#N` can be edited. */
    editable?: boolean;
    onrenumber?: (n: number) => Promise<RenumberResult>;
    /** Editing commits to the drawer, as typing a query does: a hover-opened one is pinned. */
    oneditstart?: () => void;
    /** The input went away; focus is wherever it fell. */
    oneditend?: () => void;
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
  let widEl: HTMLSpanElement | undefined = $state();
  let inputEl: HTMLInputElement | undefined = $state();

  let editing = $state(false);
  let draft = $state('');
  let committing = false;
  /** The input's centre, in the notch's containing block. */
  let at = $state({ x: 0, y: 0 });
  let clickTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    // The drawer closing takes the edit with it.
    if (!editable && editing) stopEdit();
  });

  $effect(() => () => clearTimeout(clickTimer));

  function onNotchClick(e: MouseEvent): void {
    const onNumber = editable && number !== null && e.target instanceof Node && !!widEl?.contains(e.target);
    if (!onNumber) {
      onclick();
      return;
    }
    clearTimeout(clickTimer);
    if (e.detail >= 2) {
      clickTimer = undefined;
      startEdit();
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = undefined;
      onclick();
    }, DOUBLE_CLICK_MS);
  }

  function startEdit(): void {
    if (editing || !notchEl || !widEl) return;
    at = {
      x: notchEl.offsetLeft + widEl.offsetLeft + widEl.offsetWidth / 2,
      y: notchEl.offsetTop + widEl.offsetTop + widEl.offsetHeight / 2,
    };
    draft = String(number ?? '');
    editing = true;
    oneditstart?.();
    void tick().then(() => {
      inputEl?.focus({ preventScroll: true });
      inputEl?.select();
    });
  }

  function stopEdit(): void {
    if (!editing) return;
    editing = false;
    oneditend?.();
  }

  function shake(): void {
    const el = inputEl;
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    el.select();
  }

  async function commit(): Promise<void> {
    if (committing) return;
    const n = parseWindowNumber(draft);
    if (n === null) {
      shake();
      return;
    }
    if (n === number || !onrenumber) {
      stopEdit();
      return;
    }
    committing = true;
    try {
      const result = await onrenumber(n);
      if (result === 'set') stopEdit();
      else shake();
    } finally {
      committing = false;
    }
  }

  function onInputKey(e: KeyboardEvent): void {
    // The input's keys are its own: not the editor's, not the app's.
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopEdit();
    } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
    }
  }

  function onInput(): void {
    const clean = (inputEl?.value ?? '').replace(/\D/g, '').slice(0, 2);
    if (!inputEl) return;
    if (inputEl.value !== clean) inputEl.value = clean;
    inputEl.classList.remove('shake');
    draft = clean;
  }

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
  onclick={onNotchClick}
  onmousedown={(e) => {
    // A press on the button blurs the editor (WebKit), and the drawer can only
    // give focus back on close if it saw where it was when it opened.
    e.preventDefault();
  }}
>
  <span class="shape" aria-hidden="true" bind:this={shapeEl}><span class="glow"></span></span>
  <span class="wid" aria-hidden="true" bind:this={widEl}>#{number ?? ''}</span>
  <span class="cnt" aria-hidden="true">{count}</span>
  <span class="nk" aria-hidden="true">{keyLabel}</span>
</button>

{#if editing}
  <input
    class="notch-edit"
    type="text"
    inputmode="numeric"
    maxlength="2"
    autocomplete="off"
    spellcheck="false"
    aria-label={t('tabs.notch.edit_aria')}
    style:left="{at.x}px"
    style:top="{at.y}px"
    bind:this={inputEl}
    value={draft}
    oninput={onInput}
    onkeydown={onInputKey}
    onblur={() => {
      if (!committing) stopEdit();
    }}
    onanimationend={(e) => e.currentTarget.classList.remove('shake')}
  />
{/if}

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

  /* Horizontal over the vertical `#N`: two digits read better upright. */
  .notch-edit {
    position: absolute;
    z-index: 1;
    width: 3.2ch;
    box-sizing: content-box;
    margin: 0;
    padding: 3px 4px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--text-muted);
    border-radius: 5px;
    background: var(--bg-surface);
    color: rgb(var(--color-glow));
    font-family: var(--font-code);
    font-size: 12.5px;
    font-weight: 600;
    text-align: center;
    outline: none;
    box-shadow: 0 2px 8px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
  }

  .notch-edit:global(.shake) {
    animation: shake 0.32s ease-in-out;
  }

  /* `translate(-50%, -50%)` stays in every step: the input is centred by it. */
  @keyframes shake {
    20% {
      transform: translate(calc(-50% - 4px), -50%);
    }
    40% {
      transform: translate(calc(-50% + 4px), -50%);
    }
    60% {
      transform: translate(calc(-50% - 3px), -50%);
    }
    80% {
      transform: translate(calc(-50% + 2px), -50%);
    }
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
    /* No movement: the refusal shows as a border until the next keystroke. */
    .notch-edit:global(.shake) {
      animation: none;
      border-color: var(--text-primary);
    }
  }
</style>
