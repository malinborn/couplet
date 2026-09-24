<script lang="ts">
  /**
   * The window carousel (plan 05; mockup drawer-carousel.html): the other
   * windows as thumbnails — «+ Новое окно» first — while a card is dragged
   * over the page or ⌘M asked for it. Presentational: `TabDrawer` feeds the
   * pointer, owns the keys and turns a pick into a move. Scrolling is written
   * straight to the DOM on each frame, never through reactive state.
   */
  import { tick } from 'svelte';
  import { plural, t } from '../i18n';
  import { previewLines, type InlineSeg } from './drawer-preview';
  import { tabName } from './tab-name';
  import {
    DOC_WIDTH_PX,
    clampOffset,
    edgeVelocity,
    glide,
    reducedStep,
    revealOffset,
    thumbScale,
    thumbWidth,
    type CarouselItem,
  } from './carousel';

  export interface CarouselHandle {
    /** Index of the item under a viewport point, `null` for none. */
    itemAt(x: number, y: number): number | null;
    /** Scroll item `index` into view — the keyboard's choice. */
    reveal(index: number): void;
    /** Give the listbox the keyboard (⌘M). */
    focus(): void;
  }

  let {
    items,
    mode,
    kb,
    hot,
    got,
    left,
    count,
    lead,
    pointer,
    onpick,
    onscroll,
    handle = $bindable(),
  }: {
    /** `null` while the windows are being fetched. */
    items: readonly CarouselItem[] | null;
    mode: 'drag' | 'keys';
    /** The keyboard's option (keys mode). */
    kb: number;
    /** The option under the dragged card. */
    hot: number | null;
    /** The option just picked: it pulses before the carousel goes. */
    got: number | null;
    /** The drawer's right edge, px: the carousel fills the page right of it. */
    left: number;
    /** How many tabs move. */
    count: number;
    /** The name of the (first) tab that moves. */
    lead: string;
    /** The dragged pointer, for the edge zones; `null` in keys mode. */
    pointer: { x: number; y: number } | null;
    onpick: (index: number) => void;
    /** The track moved under a still pointer: the drawer re-reads `itemAt`. */
    onscroll?: () => void;
    handle?: CarouselHandle;
  } = $props();

  let rootEl: HTMLDivElement | undefined = $state();
  let viewEl: HTMLDivElement | undefined = $state();
  let trackEl: HTMLDivElement | undefined = $state();
  let width = $state(0);
  let edges = $state({ top: false, bottom: false, v: 0 });
  // Per-frame state, written to the DOM directly.
  let offset = 0;
  let max = 0;
  let lastStepAt = 0;

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tw = $derived(thumbWidth(width));
  const windowCount = $derived(Math.max(0, (items?.length ?? 1) - 1));
  const what = $derived(count > 1 ? plural(count, 'tabs.carousel.tabs') : lead);
  // The tab's name is bold in the mockup; the sentence stays one translation.
  const head = $derived(t('tabs.carousel.head').split('{what}'));
  const optionId = (i: number) => `car-opt-${i}`;
  const selectedIndex = $derived(mode === 'keys' ? kb : hot);

  function apply(v = edges.v): void {
    if (!trackEl || !viewEl) return;
    trackEl.style.transform = `translateY(${-offset}px)`;
    const r = viewEl.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    for (const el of Array.from(trackEl.children) as HTMLElement[]) {
      const b = el.getBoundingClientRect();
      el.style.setProperty('--s', thumbScale((b.top + b.bottom) / 2, mid, r.height / 2).toFixed(3));
    }
    const next = { top: offset > 2, bottom: offset < max - 2, v };
    if (next.top !== edges.top || next.bottom !== edges.bottom || next.v !== edges.v) edges = next;
  }

  function measure(): void {
    const last = trackEl?.lastElementChild as HTMLElement | null | undefined;
    max = last && viewEl ? Math.max(0, last.offsetTop + last.offsetHeight + 28 - viewEl.clientHeight) : 0;
    offset = clampOffset(offset, max);
    apply();
  }

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      width = el.clientWidth;
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  // A new list or a new size changes the scroll range.
  $effect(() => {
    void items;
    void tw;
    void tick().then(measure);
  });

  // The edge zones (D9): a frame loop while a card is dragged; `pointer` is
  // read inside the frame, so a move does not restart the loop.
  $effect(() => {
    if (mode !== 'drag') return;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const p = pointer;
      const r = viewEl?.getBoundingClientRect();
      const v = p && r && p.x >= r.left && p.x <= r.right ? edgeVelocity(p.y, r.top, r.bottom) : 0;
      const before = offset;
      if (reduced) {
        const step = reducedStep(offset, v, max, r?.height ?? 0, lastStepAt, now);
        offset = step.offset;
        lastStepAt = step.lastStepAt;
      } else if (v !== 0) {
        offset = glide(offset, v, max);
      }
      if (offset !== before || v !== edges.v) {
        apply(v);
        if (offset !== before) onscroll?.();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  // Not `onwheel`: Svelte attaches wheel listeners passive, and the page
  // behind must not scroll.
  $effect(() => {
    const el = viewEl;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      offset = clampOffset(offset + e.deltaY, max);
      apply();
      onscroll?.();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  $effect(() => {
    handle = {
      itemAt: (x, y) => {
        const el = document.elementFromPoint?.(x, y);
        const item = el instanceof Element ? el.closest<HTMLElement>('[data-carousel-item]') : null;
        return item && rootEl?.contains(item) ? Number(item.dataset.carouselItem) : null;
      },
      reveal: (index) => {
        const el = trackEl?.children[index] as HTMLElement | undefined;
        if (!el || !viewEl) return;
        offset = revealOffset(offset, el.offsetTop, el.offsetTop + el.offsetHeight, viewEl.clientHeight, max);
        apply();
      },
      focus: () => trackEl?.focus({ preventScroll: true }),
    };
  });

  /** One listener for every option: the listbox is the focusable element, options are not (aria-activedescendant). */
  function onTrackClick(e: MouseEvent): void {
    const item = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-carousel-item]') : null;
    if (item) onpick(Number(item.dataset.carouselItem));
  }
</script>

{#snippet segments(list: InlineSeg[])}
  {#each list as s, i (i)}{#if s.code}<code>{s.text}</code>{:else if s.bold}<strong>{s.text}</strong>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
{/snippet}

<div
  class="carousel"
  bind:this={rootEl}
  style:left="{left}px"
  style:--tw="{tw}px"
  style:--ts={(tw / DOC_WIDTH_PX).toFixed(4)}
>
  <div class="car-head">
    {head[0]}<b>{what}</b>{head[1] ?? ''} · {plural(windowCount, 'tabs.carousel.windows')}
  </div>
  <div class="car-view" bind:this={viewEl}>
    <div class="car-edge top" class:on={edges.top} class:hot={edges.v < 0}>{t('tabs.carousel.more_up')}</div>
    <!-- The listbox takes the keys through the drawer's capture handler (D10). -->
    <div
      class="car-track"
      role="listbox"
      tabindex="0"
      aria-label={t('tabs.carousel.head', { what })}
      aria-activedescendant={mode === 'keys' && items ? optionId(kb) : undefined}
      bind:this={trackEl}
      onclick={onTrackClick}
      onkeydown={() => {}}
    >
      {#each items ?? [] as item, i (item.kind === 'new' ? '+new' : item.label)}
        {#if item.kind === 'new'}
          <div
            class="wthumb newwin"
            role="option"
            id={optionId(i)}
            aria-selected={i === selectedIndex}
            data-carousel-item={i}
            class:hot={i === selectedIndex}
            class:got={i === got}
          >
            {t('tabs.carousel.new_window')}
          </div>
        {:else}
          <div
            class="wthumb"
            role="option"
            id={optionId(i)}
            aria-selected={i === selectedIndex}
            data-carousel-item={i}
            class:hot={i === selectedIndex}
            class:got={i === got}
          >
            <div class="wt-bar" aria-hidden="true">
              <i></i><i></i><i></i><span class="t">{tabName(item.activePath)}<span class="wid">— #{item.number ?? '?'}</span></span>
            </div>
            <div class="wt-page" aria-hidden="true">
              <div class="doc">
                {#each previewLines(item.head, 10) as line, j (j)}
                  {#if line.kind === 'heading'}<div class="h">{@render segments(line.segs)}</div>
                  {:else if line.kind === 'quote'}<blockquote>{@render segments(line.segs)}</blockquote>
                  {:else if line.kind === 'code'}<pre>{@render segments(line.segs)}</pre>
                  {:else}<p>{line.kind === 'task' ? (line.done ? '☑ ' : '☐ ') : line.kind === 'bullet' ? '• ' : ''}{@render segments(line.segs)}</p>
                  {/if}
                {/each}
              </div>
            </div>
            <div class="wt-meta">
              <b>#{item.number ?? '?'}</b><span>{item.project ?? t('tabs.carousel.no_project')}</span>
              {#if item.branch}<span class="br">⎇ {item.branch}</span>{/if}
              <span class="n">{plural(item.tabCount, 'tabs.drawer.count')}</span>
            </div>
            <div class="wt-drop" aria-hidden="true">{t('tabs.carousel.drop_here', { n: item.number ?? '?' })}</div>
          </div>
        {/if}
      {/each}
    </div>
    <div class="car-edge bot" class:on={edges.bottom} class:hot={edges.v > 0}>{t('tabs.carousel.more_down')}</div>
  </div>
  <div class="car-foot">{mode === 'keys' ? t('tabs.carousel.foot_keys') : t('tabs.carousel.foot_drag')}</div>
</div>

<style>
  /* Mockup `.carousel` (drawer-carousel.html l.510–553); fixed, because the
     drawer's root is `display: contents` and the page has no positioned box. */
  .carousel {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 950;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
    font-family: var(--tabs-ui);
    color: var(--text-primary);
    animation: car-in 0.22s ease;
  }
  .car-head {
    flex: 0 0 auto;
    margin-top: 16px;
    font-size: 11.5px;
    color: var(--text-muted);
    letter-spacing: 0.01em;
    text-align: center;
  }
  .car-head b {
    color: var(--text-primary);
    font-weight: 600;
  }
  .car-view {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    overflow: hidden;
    margin: 10px 0 14px;
    pointer-events: auto;
    -webkit-mask: linear-gradient(transparent 0, #000 9%, #000 91%, transparent 100%);
    mask: linear-gradient(transparent 0, #000 9%, #000 91%, transparent 100%);
  }
  .car-track {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 28px 0;
    will-change: transform;
    outline: none;
  }
  .wthumb {
    --s: 1;
    width: var(--tw);
    flex: 0 0 auto;
    border-radius: 10px;
    overflow: hidden;
    position: relative;
    cursor: pointer;
    background: var(--bg-base);
    transform: scale(var(--s));
    opacity: calc(0.45 + 0.55 * var(--s));
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.25),
      0 14px 34px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.6));
    transition:
      box-shadow 0.15s ease,
      outline-color 0.15s ease;
    outline: 2px solid transparent;
    outline-offset: 2px;
  }
  :global(:root[data-theme$='dark']) .wthumb {
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.6),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.08),
      0 14px 34px rgba(0, 0, 0, 0.5);
  }
  .wthumb.hot {
    outline-color: var(--tabs-brand-a);
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.25),
      0 18px 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 2.2));
  }
  .wt-bar {
    height: 22px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    font-size: 10.5px;
    color: var(--text-subtle);
  }
  .wt-bar i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: block;
    background: color-mix(in oklab, var(--text-muted) 45%, transparent);
  }
  .wt-bar .t {
    flex: 1;
    text-align: center;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-right: 26px;
  }
  .wt-bar .wid {
    color: var(--text-muted);
    font-weight: 500;
    margin-left: 4px;
  }
  .wt-page {
    height: calc(var(--tw) * 0.5);
    overflow: hidden;
    position: relative;
  }
  .doc {
    position: absolute;
    top: 0;
    left: 0;
    width: 640px;
    padding: 26px 34px;
    transform: scale(var(--ts));
    transform-origin: 0 0;
    font-family: var(--font-text);
    font-size: 16px;
    line-height: 1.7;
    color: var(--text-primary);
    pointer-events: none;
  }
  .doc .h {
    font-size: 1.7em;
    font-weight: 700;
    line-height: 1.25;
    margin: 0 0 0.4em;
  }
  .doc p,
  .doc blockquote,
  .doc pre {
    margin: 0 0 0.35em;
  }
  .doc blockquote {
    padding-left: 0.8em;
    border-left: 3px solid var(--border);
    color: var(--text-muted);
  }
  .doc pre,
  .doc :global(code) {
    font-family: var(--font-code);
    font-size: 0.88em;
  }
  .wt-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px 8px;
    border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-surface);
  }
  .wt-meta b {
    font-family: var(--font-code);
    font-weight: 400;
    color: var(--text-primary);
  }
  .wt-meta .br {
    font-family: var(--font-code);
    font-size: 10.5px;
  }
  .wt-meta .n {
    margin-left: auto;
  }
  .wt-drop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--tabs-brand-a) 16%, transparent);
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .wthumb.hot .wt-drop {
    opacity: 1;
  }
  .wthumb.got {
    animation: got-it 0.5s var(--tabs-ease);
  }
  .wthumb.newwin {
    height: 64px;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1.5px dashed color-mix(in oklab, var(--text-muted) 60%, transparent);
    box-shadow: none;
    font-size: 12.5px;
    color: var(--text-subtle);
  }
  .wthumb.newwin.hot {
    border-color: var(--tabs-brand-a);
    color: var(--text-primary);
    background: color-mix(in oklab, var(--tabs-brand-a) 10%, transparent);
  }
  .car-edge {
    position: absolute;
    left: 0;
    right: 0;
    height: 22%;
    display: flex;
    justify-content: center;
    font-size: 11px;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
    z-index: 1;
  }
  .car-edge.top {
    top: 0;
    align-items: flex-start;
    padding-top: 4px;
  }
  .car-edge.bot {
    bottom: 0;
    align-items: flex-end;
    padding-bottom: 4px;
  }
  .car-edge.on {
    opacity: 1;
  }
  .car-edge.hot {
    color: var(--text-primary);
  }
  .car-foot {
    flex: 0 0 auto;
    margin-bottom: 14px;
    font-size: 11px;
    color: var(--text-muted);
  }
  @keyframes car-in {
    from {
      opacity: 0;
    }
  }
  @keyframes got-it {
    0% {
      outline-color: var(--tabs-brand-a);
    }
    40% {
      transform: scale(calc(var(--s) * 1.04));
    }
    100% {
      transform: scale(var(--s));
    }
  }
  /* D11: nothing moves by itself. */
  @media (prefers-reduced-motion: reduce) {
    .carousel,
    .wthumb.got {
      animation: none;
    }
    .wthumb,
    .wt-drop,
    .car-edge {
      transition: none;
    }
  }
</style>
