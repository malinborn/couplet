<script lang="ts">
  /**
   * The bottom area of the stash drawer (stash stage 06; mockup `#trashBar`,
   * `renderTrashBar`): the tabs drawer's stash bar, mirrored. In the stash
   * view «Удалённые · N · хранятся 30 дней» switches to the trash; in the
   * trash view «← в тайник · N в тайнике» switches back. The number jumps when
   * it changes (mockup `bump`) — not when the view switches — and the bar
   * pulses when a note lands in the trash (mockup `got`).
   *
   * The chrome repeats `StashBar.svelte`'s (scoped styles cannot be shared):
   * keep the two in step. Not `StashBar` itself — that one is the tabs
   * drawer's, with the drop zone and the `→` key.
   */
  import { untrack } from 'svelte';
  import { t } from '../i18n';
  import StashIcon from './StashIcon.svelte';
  import { TRASH_DAYS } from './trash-view';
  import type { StashMode } from './types';

  let {
    mode,
    trashTotal,
    stashTotal,
    ontoggle,
  }: {
    mode: StashMode;
    /** Every trashed note (`counts.deleted`). */
    trashTotal: number;
    /** What the stash holds — shown in the trash view. */
    stashTotal: number;
    ontoggle: () => void;
  } = $props();

  const inTrash = $derived(mode === 'trash');

  let bump = $state(false);
  let got = $state(false);
  let last: { mode: StashMode; n: number; trash: number } | null = null;
  const frames = { bump: 0, got: 0 };
  const timers: { bump?: ReturnType<typeof setTimeout>; got?: ReturnType<typeof setTimeout> } = {};

  // Dropped and re-added a frame later, so a change that lands while the
  // previous one runs restarts it (mockup `restart`), as `StashBar` does.
  function restart(which: 'bump' | 'got', set: (on: boolean) => void, ms: number): void {
    set(false);
    cancelAnimationFrame(frames[which]);
    frames[which] = requestAnimationFrame(() => {
      set(true);
      clearTimeout(timers[which]);
      timers[which] = setTimeout(() => set(false), ms);
    });
  }

  $effect(() => {
    const now = { mode, n: inTrash ? stashTotal : trashTotal, trash: trashTotal };
    untrack(() => {
      if (last !== null && now.mode === last.mode && now.n !== last.n) restart('bump', (on) => (bump = on), 520);
      if (last !== null && now.trash > last.trash) restart('got', (on) => (got = on), 720);
      last = now;
    });
  });

  $effect(() => () => {
    cancelAnimationFrame(frames.bump);
    cancelAnimationFrame(frames.got);
    clearTimeout(timers.bump);
    clearTimeout(timers.got);
  });
</script>

<div class="stash-bar trash-bar" class:got>
  <div class="idle">
    <button
      class="stash-btn"
      type="button"
      aria-pressed={inTrash}
      title={inTrash ? t('stash.trash.back_title') : t('stash.trash.button_title', { days: TRASH_DAYS })}
      onclick={(e) => {
        e.currentTarget.blur();
        ontoggle();
      }}
      ><StashIcon name={inTrash ? 'tray' : 'bin'} />{inTrash ? t('stash.trash.back') : t('stash.trash.button')}</button
    >
    {#if inTrash}
      <span class="stash-sum">· <span class="num" class:bump>{stashTotal}</span> {t('stash.trash.in_stash')}</span>
    {:else}
      <span class="stash-sum"
        >· <span class="num" class:bump>{trashTotal}</span> · {t('stash.trash.kept_days', { days: TRASH_DAYS })}</span
      >
    {/if}
  </div>
</div>

<style>
  /* `StashBar.svelte`'s idle row, with the mockup's `.trash-bar { margin-top: 0 }`. */
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
      border-color 0.18s,
      background-color 0.18s;
  }

  .trash-bar {
    margin-top: 0;
  }

  .idle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
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
    white-space: nowrap;
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
