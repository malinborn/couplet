<script lang="ts">
  /**
   * "Connect this file to an AI agent" (#29).
   *
   * Rests at the top-left with only a sliver showing and slides out when the
   * pointer is actually on it. Click copies a ready-to-paste prompt; the
   * confirmation is the ordinary toast stack, not anything new.
   *
   * Why a peeking button and not a menu item: there already is a menu item, and
   * the feedback behind #29 is from someone who spent fifteen minutes never
   * finding out that connecting a document was possible at all. Something has to
   * be visible in the window without being read about first.
   *
   * It used to do more, and the two things it no longer does are the point of
   * this comment, because both look correct on paper:
   *
   * - **Proximity reveal.** The button watched `pointermove` and slid out as the
   *   cursor got within ~180px. The reasoning was that a button resting mostly
   *   off-screen cannot be hovered by someone who does not know it is there. In
   *   the window it reads as the UI lunging: every trip across the top-left of
   *   the document — which is most trips, the text starts there — makes a
   *   control jump out of the edge. The sliver is a big enough target to hover
   *   on purpose, and this app's premise is that nothing moves unless asked.
   * - **Cursor magnetism.** A ≤7px lean toward the pointer, to shave the aim.
   *   Once the button is out it is ~170px wide; there is no aim left to shave,
   *   and the lean is just the button twitching under the cursor.
   *
   * What is left is `:hover` and `:focus-visible` in CSS, with no JavaScript at
   * all. That is deliberate beyond mere brevity: `:hover` tracks the *rendered*
   * box, including the transform mid-slide, so the button cannot retract from
   * under its own cursor the way a hand-rolled hit test does when the geometry
   * it measured is one frame stale.
   */

  let { onclick }: { onclick: () => void } = $props();
</script>

<button
  class="ai-bind-button"
  type="button"
  title="Copy a prompt that connects this file to your AI agent"
  aria-label="Copy a prompt that connects this file to your AI agent"
  {onclick}
>
  <!--
    Glyph last, not first. The button slides out leftwards, so the part left on
    screen at rest is its trailing edge — with the glyph leading, the resting
    sliver showed the tail of the word "agent" and nothing else.
  -->
  <span class="ai-bind-label">Connect to AI agent</span>
  <span class="ai-bind-glyph" aria-hidden="true">✦</span>
</button>

<style>
  .ai-bind-button {
    position: fixed;
    top: 12px;
    left: 0;
    z-index: 880;

    /*
     * The resting slide is expressed as a percentage of the button's own width,
     * so nothing here depends on JavaScript having measured it. An earlier
     * version bound `clientWidth` and computed the offset in JS; on first paint
     * that width is still 0, and the button rendered fully open in the corner
     * — visible in the browser, invisible to every unit test.
     *
     * --shown is 0 (tucked away, PEEK px showing) to 1 (fully out).
     */
    --shown: 0;
    /*
     * Wide enough for the whole glyph, not a hairline. A 13px sliver at half
     * opacity was measurably present and visually absent — it did not register
     * in a screenshot of the dark theme at all, which for a button whose only
     * job is to be noticed is the same as not shipping it.
     */
    --peek: 26px;
    transform: translateX(calc((var(--shown) - 1) * (100% - var(--peek))));
    opacity: calc(0.72 + 0.28 * var(--shown));

    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;

    /* Flat on the left: it reads as something tucked against the window edge
       rather than a floating pill that happens to be clipped. */
    border: 1px solid var(--color-table-border);
    border-left: none;
    border-radius: 0 999px 999px 0;

    /*
     * Soft gradient rather than a flat fill.
     *
     * The tint is `--color-glow`, the one token every theme already defines as
     * "this theme's accent, as an RGB triple" — violet in light, rose-quartz in
     * dark, indigo and periwinkle in the two auroras. Painting it as a
     * translucent layer over the solid surface colour, rather than mixing fixed
     * colours, is what makes one declaration correct in all four: the surface
     * carries the theme's lightness, the tint only leans on it. The alphas top
     * out at 0.16 and fade to nothing by the right edge, so at rest the sliver
     * is barely tinted and the colour arrives with the reveal.
     *
     * `rgba(var(--token), a)` and not `rgb(... / a)`: the triples are
     * comma-separated, which is the legacy syntax and will not mix with the
     * slash form. Same call shape as the active-line glow in editor.css.
     */
    background-color: var(--bg-surface);
    background-image: linear-gradient(
      104deg,
      rgba(var(--color-glow), 0.16) 0%,
      rgba(var(--color-glow), 0.07) 48%,
      rgba(var(--color-glow), 0) 100%
    );
    box-shadow: 1px 1px 6px rgb(0 0 0 / 0.13);
    color: var(--text-primary);
    font-family: var(--font-code);
    font-size: 12px;
    line-height: 1;
    padding: 7px 11px 7px 13px;
    cursor: pointer;

    transition:
      transform 0.18s cubic-bezier(0.22, 0.8, 0.3, 1),
      opacity 0.18s ease,
      background-image 0.15s ease;
  }

  /*
   * Hover on the button itself, nothing else. `:focus-visible` is in the same
   * rule because a button reachable by Tab but still three-quarters off screen
   * is worse than one that is not reachable at all.
   */
  .ai-bind-button:hover,
  .ai-bind-button:focus-visible {
    --shown: 1;
    background-image: linear-gradient(
      104deg,
      rgba(var(--color-glow), 0.26) 0%,
      rgba(var(--color-glow), 0.12) 48%,
      rgba(var(--color-glow), 0.02) 100%
    );
  }

  /* Under prefers-reduced-motion the button still reveals — it has to, or it
     is unusable — but it arrives instead of travelling. */
  @media (prefers-reduced-motion: reduce) {
    .ai-bind-button {
      transition: none;
    }
  }

  .ai-bind-button:focus-visible {
    outline: 2px solid var(--text-primary);
    outline-offset: 2px;
  }

  .ai-bind-glyph {
    font-size: 11px;
    opacity: 0.85;
  }

  .ai-bind-label {
    letter-spacing: 0.01em;
  }
</style>
