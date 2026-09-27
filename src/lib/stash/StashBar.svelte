<script lang="ts">
  /**
   * The bottom area of the tabs drawer (stash stage 04; spec «Нижняя область»,
   * mockup `.stash-bar`): at rest the «Тайник» button and «· N · отложено
   * сегодня M»; while tab cards are dragged, the drop zone «Отложить в тайник ·
   * N вкладок». The drawer hit-tests it (`el`) and decides the drop; this only
   * draws. The count jumps when it changes (mockup `bump`).
   */
  import { untrack } from 'svelte';
  import { plural, t } from '../i18n';
  import StashIcon from './StashIcon.svelte';
  import type { StashCounts } from './ipc';

  let {
    counts,
    open,
    dropCount,
    hot,
    got,
    onclick,
    el = $bindable(),
  }: {
    counts: StashCounts;
    /** The stash drawer is open: the button is pressed. */
    open: boolean;
    /** Tab cards being dragged (the zone shows), or `null`. */
    dropCount: number | null;
    /** The dragged cards are over the zone. */
    hot: boolean;
    /** A put-away just landed: a short pulse (mockup `stGot`). */
    got: boolean;
    onclick: () => void;
    el?: HTMLElement;
  } = $props();

  let bump = $state(false);
  let last: number | null = null;
  let bumpFrame = 0;
  let bumpTimer: ReturnType<typeof setTimeout> | undefined;

  // The class is dropped and re-added a frame later so a change that lands
  // while the previous jump is still running restarts it (mockup `restart`).
  $effect(() => {
    const n = counts.total;
    untrack(() => {
      if (last !== null && n !== last) {
        bump = false;
        cancelAnimationFrame(bumpFrame);
        bumpFrame = requestAnimationFrame(() => {
          bump = true;
          clearTimeout(bumpTimer);
          bumpTimer = setTimeout(() => {
            bump = false;
          }, 520);
        });
      }
      last = n;
    });
  });

  $effect(() => () => {
    cancelAnimationFrame(bumpFrame);
    clearTimeout(bumpTimer);
  });
</script>

<div class="stash-bar" class:dropmode={dropCount !== null} class:hot class:got bind:this={el}>
  <div class="idle">
    <button class="stash-btn" type="button" aria-pressed={open} title={t('stash.bar.button_title')} {onclick}
      ><StashIcon name="tray" />{t('stash.bar.button')}</button
    >
    <span class="stash-sum"
      >· <span class="num" class:bump>{counts.total}</span> · {t('stash.bar.today', { n: counts.stashedToday })}</span
    >
    <kbd title={t('stash.bar.key_title')}>→</kbd>
  </div>
  <div class="drop" aria-hidden="true">
    <StashIcon name="tray" />{t('stash.bar.drop')}{#if dropCount !== null && dropCount > 1}<span class="dn"
        >{' · '}{plural(dropCount, 'tabs.drawer.count')}</span
      >{/if}<span class="dk">⌃T</span>
  </div>
</div>

<style>
  .stash-bar {
    flex: 0 0 auto;
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 12px 10px;
    padding: 0 8px 0 6px;
    height: 38px;
    border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
    border-radius: 10px;
    background: var(--bg-base);
    font-size: 11.5px;
    color: var(--text-muted);
    transition:
      height 0.22s var(--tabs-ease),
      border-color 0.18s,
      background-color 0.18s,
      margin 0.22s var(--tabs-ease);
  }

  .idle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    transition: opacity 0.15s;
  }

  .stash-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--stash-line);
    background: var(--stash-tint);
    color: var(--text-primary);
    border-radius: 7px;
    padding: 3px 9px 3px 7px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s;
  }

  .stash-btn :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--color-stash);
  }

  .stash-btn:hover {
    border-color: color-mix(in oklab, var(--color-stash) 60%, transparent);
  }

  .stash-btn[aria-pressed='true'] {
    background: color-mix(in oklab, var(--color-stash) 18%, var(--bg-base));
    border-color: var(--color-stash);
  }

  .stash-sum {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .num {
    display: inline-block;
    color: var(--text-subtle);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .num.bump {
    animation: bump 0.5s var(--tabs-ease);
  }

  kbd {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .drop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    opacity: 0;
    pointer-events: none;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-primary);
    transition: opacity 0.15s;
  }

  .drop :global(svg) {
    width: 16px;
    height: 16px;
    color: var(--color-stash);
  }

  .drop .dn {
    font-weight: 400;
    color: var(--text-muted);
  }

  .drop .dk {
    font-weight: 400;
    font-size: 10.5px;
    color: var(--text-muted);
    margin-left: 4px;
  }

  .stash-bar.dropmode {
    height: 58px;
    border: 1.5px dashed color-mix(in oklab, var(--color-stash) 60%, transparent);
    background: color-mix(in oklab, var(--color-stash) 6%, var(--bg-base));
  }

  .dropmode .idle {
    opacity: 0;
    pointer-events: none;
  }

  .dropmode .drop {
    opacity: 1;
  }

  .stash-bar.hot {
    border-style: solid;
    border-color: var(--color-stash);
    background: color-mix(in oklab, var(--color-stash) 16%, var(--bg-base));
    box-shadow: 0 0 0 3px var(--stash-soft);
  }

  .stash-bar.got {
    animation: stGot 0.7s var(--tabs-ease);
  }

  @keyframes bump {
    40% {
      transform: scale(1.5);
      color: var(--text-primary);
    }
  }

  @keyframes stGot {
    30% {
      border-color: var(--color-stash);
      box-shadow: 0 0 0 4px var(--stash-soft);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .num.bump,
    .stash-bar.got {
      animation: none;
    }
    .stash-bar {
      transition-duration: 0.01s;
    }
  }
</style>
