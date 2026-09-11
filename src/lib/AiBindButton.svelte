<script lang="ts">
  /**
   * "Connect this file to an AI agent" (#29).
   *
   * Rests at the top-left with only a sliver showing, slides out as the pointer
   * approaches, and leans very slightly toward it. Click copies a ready-to-paste
   * prompt; the confirmation is the ordinary toast stack, not anything new.
   *
   * Why a peeking button and not a menu item: there already is a menu item, and
   * the feedback behind #29 is from someone who spent fifteen minutes never
   * finding out that connecting a document was possible at all. Something has to
   * be visible in the window without being read about first.
   *
   * All the arithmetic lives in `ai-bind.ts` and is unit-tested. What stays here
   * is only measurement and assignment.
   */
  import { magnetOffset, revealProgress, REVEAL_NEAR, type Point } from './ai-bind';

  let { onclick }: { onclick: () => void } = $props();

  let button: HTMLButtonElement | undefined = $state(undefined);

  let reveal = $state(0);
  let magnet = $state<Point>({ x: 0, y: 0 });
  let focused = $state(false);
  let reduced = $state(false);

  /**
   * Distance from a point to the nearest edge of a rect — zero when inside.
   *
   * Deliberately not distance-to-centre. As the button slides out its rect
   * grows toward the pointer, so this keeps it out while the pointer is on it;
   * centre distance would make it retract from under its own cursor.
   */
  function distanceToRect(p: Point, r: DOMRect): number {
    const dx = Math.max(r.left - p.x, 0, p.x - r.right);
    const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
    return Math.hypot(dx, dy);
  }

  let frame = 0;
  let pointer: Point = { x: -1e4, y: -1e4 };

  function onPointerMove(event: PointerEvent): void {
    pointer = { x: event.clientX, y: event.clientY };
    if (frame) return;
    // One measurement per frame. A getBoundingClientRect per pointermove is
    // a layout read on every mouse sample.
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  }

  function measure(): void {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const distance = distanceToRect(pointer, rect);

    // Under reduced motion the reveal is a step rather than a slide, but it
    // still uses the full approach distance: requiring the pointer to land on
    // the 13px sliver would make the button unusable, which is not what
    // "reduce motion" asks for.
    reveal = reduced ? (distance <= REVEAL_NEAR ? 1 : 0) : revealProgress(distance);

    // Anchor is where the button would sit with no magnetism applied, so the
    // offset is computed against a fixed point rather than against itself —
    // otherwise each frame feeds its own output back in and the thing drifts.
    const anchor = {
      x: rect.left + rect.width / 2 - magnet.x,
      y: rect.top + rect.height / 2 - magnet.y,
    };
    magnet = reduced ? { x: 0, y: 0 } : magnetOffset({ pointer, anchor });
  }

  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = mq.matches;
    const onChange = () => {
      reduced = mq.matches;
      measure();
    };
    mq.addEventListener('change', onChange);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      mq.removeEventListener('change', onChange);
      window.removeEventListener('pointermove', onPointerMove);
      if (frame) cancelAnimationFrame(frame);
    };
  });

  // Keyboard focus reveals it fully: a button reachable by Tab but still
  // three-quarters off screen is worse than one that is not reachable at all.
  const shown = $derived(focused ? 1 : reveal);
  const offsetX = $derived(focused ? 0 : magnet.x);
  const offsetY = $derived(focused ? 0 : magnet.y);
</script>

<button
  bind:this={button}
  class="ai-bind-button"
  class:ai-bind-instant={reduced}
  type="button"
  title="Copy a prompt that connects this file to your AI agent"
  aria-label="Copy a prompt that connects this file to your AI agent"
  style="--shown: {shown}; --mx: {offsetX}; --my: {offsetY}; opacity: {0.72 + 0.28 * shown};"
  onfocus={() => { focused = true; }}
  onblur={() => { focused = false; }}
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
     * --shown is 0 (tucked away, PEEK px showing) to 1 (fully out); --mx/--my
     * are the magnet offset in px.
     */
    --shown: 0;
    --mx: 0;
    --my: 0;
    /*
     * Wide enough for the whole glyph, not a hairline. A 13px sliver at half
     * opacity was measurably present and visually absent — it did not register
     * in a screenshot of the dark theme at all, which for a button whose only
     * job is to be noticed is the same as not shipping it.
     */
    --peek: 26px;
    transform: translate(
      calc((var(--shown) - 1) * (100% - var(--peek)) + var(--mx) * 1px),
      calc(var(--my) * 1px)
    );

    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;

    /* Flat on the left: it reads as something tucked against the window edge
       rather than a floating pill that happens to be clipped. */
    border: 1px solid var(--color-table-border);
    border-left: none;
    border-radius: 0 999px 999px 0;
    background: var(--color-code-bg);
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
      background 0.15s ease;
  }

  /* Under prefers-reduced-motion the button still reveals — it has to, or it
     is unusable — but it arrives instead of travelling, and magnetism is off
     entirely (maxPull 0 in the caller). */
  .ai-bind-button.ai-bind-instant {
    transition: none;
  }

  .ai-bind-button:hover {
    background: var(--color-table-border);
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
