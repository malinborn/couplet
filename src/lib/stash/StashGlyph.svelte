<script lang="ts">
  /**
   * The stash glyph — the mockup's tray (`ICONS.tray` in
   * docs/investigations/2026-09-26-stash-mockup/stash-drawers.html). It draws
   * in `currentColor`: the caller sets `var(--color-stash)`, the theme token
   * that plays the mockup's `--stash`.
   * `label`: announced; otherwise decorative.
   */
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
  <path d="M2.5 9.5 4.2 3.5h7.6l1.7 6" />
  <path d="M2.5 9.5v3.2c0 .4.3.8.8.8h9.4c.5 0 .8-.4.8-.8V9.5h-3.3l-.9 1.6H6.7l-.9-1.6z" />
</svg>

<style>
  .stash-glyph {
    display: inline-block;
    flex: 0 0 auto;
  }
</style>
