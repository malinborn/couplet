<script lang="ts">
  /**
   * The stash glyph — the mockup's tray (`STASH_ICONS.tray`, `icons.ts`, the
   * one copy of the path). It draws in `currentColor`: the caller sets
   * `var(--color-stash)`, the theme token that plays the mockup's `--stash`.
   * `label`: announced; otherwise decorative.
   */
  import { STASH_ICONS } from './icons';

  let { size = 13, label = null }: { size?: number; label?: string | null } = $props();
</script>

<svg
  class="stash-glyph"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label ?? undefined}
  aria-hidden={label ? undefined : 'true'}
>
  {#each STASH_ICONS.tray as d (d)}<path {d} />{/each}
</svg>

<style>
  .stash-glyph {
    display: inline-block;
    flex: 0 0 auto;
  }
</style>
