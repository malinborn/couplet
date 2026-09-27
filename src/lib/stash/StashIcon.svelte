<script lang="ts">
  /** A stash glyph by name (`icons.ts`), 1em square, in `currentColor`; decorative. */
  import { STASH_ICONS, type StashIconName } from './icons';

  let { name, stroke = 1.5 }: { name: StashIconName; stroke?: number } = $props();
</script>

<svg
  class="ico"
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each STASH_ICONS[name] as d (d)}<path {d} />{/each}
</svg>

<style>
  .ico {
    width: 1em;
    height: 1em;
    display: inline-block;
    flex: 0 0 auto;
  }
</style>
