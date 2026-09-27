<script lang="ts" module>
  export interface StashDrawerHandle {
    /** A key the tabs drawer routed here while the stash has the keys. `true`: used. */
    key(e: KeyboardEvent): boolean;
    /** DOM focus into the list, unless something in the drawer has it already. */
    focus(): void;
    /** The point is over the open stash drawer — a drop target. */
    contains(x: number, y: number): boolean;
    /** Its left edge, px; `null` while closed. */
    left(): number | null;
  }
</script>

<script lang="ts">
  /**
   * The stash drawer (stash stage 04; spec «Дровер тайника», mockup
   * `stash-drawers.html`): the tabs drawer's mirror on the right edge, in the
   * stash colour. Rendered inside `TabDrawer`'s `display: contents` root, so
   * the tabs drawer's focus trap, capture-phase key handler and drag machine
   * cover it: this component never listens on `window`. It answers the keys
   * the tabs drawer routes to it (`handle.key`) and reports presses on cards
   * (`onpress`) — the tabs drawer decides click vs drag.
   */
  import { tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import { t } from '../i18n';
  import { acceleratorAriaKeyShortcuts, acceleratorLabel, isMacPlatform } from '../editor/hotkey-label';
  import { EXPAND_MS } from '../tabs/drawer-state';
  import StashCard from './StashCard.svelte';
  import StashIcon from './StashIcon.svelte';
  import type { StashStore } from './stash-store.svelte';
  import {
    STASH_SORT_KEYS,
    backspaceStash,
    escapeStash,
    focusDrawer,
    moveStashKb,
    setRepoChip,
    setStashQuery,
    setStashSort,
    stashKbTarget,
    stashKeyAction,
  } from './stash-state';
  import { drawerTerms, termsText } from './stash-query';
  import { STASH_RENDER_CAP, entryTitle, stashView, type StashSort } from './stash-view';
  import type { StashEntry, TagChange } from './types';

  let {
    stash,
    openHere,
    width,
    narrow,
    compact,
    windowNumber,
    dropReady,
    dropHot,
    draggingId,
    onpress,
    onopen,
    onremove,
    onsettag,
    onfocusrequest,
    handle = $bindable(),
  }: {
    stash: StashStore;
    /** Paths open as tabs in this window: not shown here (D10). */
    openHere: ReadonlySet<string>;
    width: number;
    narrow: boolean;
    compact: boolean;
    windowNumber: number | null;
    /** Tab cards are being dragged: the drawer shows it can take them. */
    dropReady: boolean;
    /** …and they are over it now. */
    dropHot: boolean;
    /** The stash card being dragged (the tabs drawer runs the drag). */
    draggingId: string | null;
    onpress: (entry: StashEntry, card: HTMLElement, e: PointerEvent) => void;
    /** Enter: open here and close both drawers. */
    onopen: (entry: StashEntry) => void;
    onremove: (entry: StashEntry) => void;
    onsettag: (entry: StashEntry, change: TagChange) => void;
    /** A press inside: the stash takes the keys. */
    onfocusrequest: () => void;
    handle?: StashDrawerHandle;
  } = $props();

  const mac = isMacPlatform();
  const untitled = t('stash.untitled');

  let wrapEl: HTMLDivElement | undefined = $state();
  let asideEl: HTMLElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();
  let expandedId = $state<string | null>(null);
  let flashing = $state<StashSort | null>(null);
  let now = $state(Date.now());
  let expandTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** The cards are in the DOM: while open, and through the slide-out (`.stash-wrap`'s .34 s). */
  let listOn = $state(false);

  const open = $derived(stash.state.open);
  const focused = $derived(open && stash.state.focus === 'stash');
  /** The query's text: what `stash_search` matches and the cards mark. Tags stay stage 04's client rule. */
  const terms = $derived(drawerTerms(stash.state.query));
  const searchQuery = $derived(termsText(terms));
  const view = $derived(
    stashView({
      entries: stash.entries,
      indexes: stash.indexes,
      openHere,
      repoChip: stash.state.repoChip,
      query: stash.state.query,
      sort: stash.state.sort,
      untitled,
      hits: stash.hits,
    })
  );
  /** The rows rendered as cards (I2); the keyboard ring moves over these only. */
  const rows = $derived(view.rows.slice(0, STASH_RENDER_CAP));
  /**
   * Matches past the one page Rust answered. With a `#tag` in the query the
   * drawer drops hits Rust counted, so this is then an upper bound.
   */
  const unfetched = $derived(stash.hits ? Math.max(0, stash.searchTotal - stash.hits.length) : 0);
  const more = $derived(view.rows.length - rows.length + unfetched);
  const visible = $derived(rows.map((r) => r.entry.id));
  const kbId = $derived(focused ? stashKbTarget(stash.state, visible) : null);
  const searchNote = $derived(
    stash.state.query
      ? [
          view.rows.length > 0
            ? t('tabs.drawer.search_count', { shown: view.rows.length + unfetched, total: view.total })
            : '',
          t('tabs.drawer.search_reset'),
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  );
  const filterNote = $derived.by(() => {
    const counts = { shown: view.rows.length, total: view.total };
    const base =
      stash.state.repoChip !== null ? t('stash.filter.note_repo', counts) : t('stash.filter.note_all', counts);
    return view.openHere > 0 ? `${base} ${t('stash.filter.in_tabs', { n: view.openHere })}` : base;
  });
  const emptyText = $derived.by(() => {
    if (!stash.loaded || view.rows.length > 0) return null;
    if (stash.state.query) return t('tabs.drawer.empty');
    // The chip is a repo filter (the mockup's copy still spoke of a tag): `openHere` counts within it.
    const repo = stash.state.repoChip;
    if (repo !== null) {
      return view.openHere > 0
        ? t('stash.drawer.empty_open_here_repo', { repo })
        : t('stash.drawer.empty_repo', { repo });
    }
    if (view.openHere > 0) return t('stash.drawer.empty_open_here');
    return t('stash.drawer.empty_all');
  });

  $effect(() => {
    handle = { key, focus: focusList, contains, left };
  });

  // Closed, the query is empty (`closeStash`), so this also drops the hits.
  // The store searches again after every list load, so no listener here.
  $effect(() => {
    stash.search({ query: searchQuery, repo: stash.state.repoChip, tag: null, deleted: false });
  });

  // What is on screen: only a card the human can see pulses after a reload.
  // Closed, nothing is rendered and nothing reloads; the first load after a
  // reopen marks nothing (M8), and from then on this is current again.
  $effect(() => {
    if (open) stash.setShown(visible);
  });

  // A closed stash keeps no cards in the DOM (I2) — after the slide-out, so
  // they leave with the drawer instead of vanishing from it.
  $effect(() => {
    if (open) {
      listOn = true;
      return;
    }
    const timer = setTimeout(() => {
      listOn = false;
    }, motion(360));
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (draggingId !== null) {
      clearTimeout(expandTimer);
      expandedId = null;
    }
  });

  // «отложено только что» must not stay «только что» for an hour.
  $effect(() => {
    if (!open) {
      clearTimeout(expandTimer);
      expandedId = null;
      return;
    }
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  $effect(() => () => {
    clearTimeout(expandTimer);
    clearTimeout(flashTimer);
  });

  function reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function motion(ms: number): number {
    return reducedMotion() ? 0 : ms;
  }

  // The tabs drawer's `arrive` / `collapse`, mirrored: cards come in from and leave to the right.
  function arriveR(_node: Element): TransitionConfig {
    return {
      duration: motion(500),
      easing: cubicOut,
      css: (k) => `opacity: ${k}; transform: translateX(${(1 - k) * 18}px);`,
    };
  }

  function collapseR(node: Element): TransitionConfig {
    const el = node as HTMLElement;
    const height = el.offsetHeight;
    const padding = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    return {
      duration: motion(230),
      easing: cubicOut,
      css: (k) =>
        `overflow: hidden; opacity: ${k}; height: ${k * height}px; padding-bottom: ${k * padding}px;` +
        ` transform: translateX(${(1 - k) * 30}px) scale(${0.97 + 0.03 * k});`,
    };
  }

  function cardEl(id: string): HTMLElement | null {
    return listEl?.querySelector<HTMLElement>(`[data-stash-id="${CSS.escape(id)}"]`) ?? null;
  }

  function focusList(): void {
    void tick().then(() => {
      if (stash.state.open && !asideEl?.contains(document.activeElement)) listEl?.focus({ preventScroll: true });
    });
  }

  function contains(x: number, y: number): boolean {
    if (!open || !wrapEl) return false;
    const r = wrapEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function left(): number | null {
    return open && asideEl ? asideEl.getBoundingClientRect().left : null;
  }

  function setQuery(query: string): void {
    stash.update((s) => setStashQuery(s, query));
    if (listEl) listEl.scrollTop = 0;
  }

  function sortBy(sort: StashSort): void {
    stash.update((s) => setStashSort(s, sort));
    flashing = null;
    clearTimeout(flashTimer);
    requestAnimationFrame(() => {
      flashing = sort;
      flashTimer = setTimeout(() => {
        flashing = null;
      }, 600);
    });
    listEl?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  /**
   * A tag edit from a card. An addition pops at once: App upserts the entry
   * before the `tagged` reload arrives, so the reload's diff sees nothing new
   * and would never mark it.
   */
  function setTag(entry: StashEntry, change: TagChange): void {
    if (change.add && change.add.length > 0) stash.markNewTags(entry.id, change.add);
    onsettag(entry, change);
  }

  /** A click on a tag chip: filter by it, with the keys in the stash (mockup). */
  function filterByTag(tag: string): void {
    stash.update((s) => focusDrawer(setStashQuery(s, `#${tag}`), 'stash'));
    if (listEl) listEl.scrollTop = 0;
  }

  function key(e: KeyboardEvent): boolean {
    const action = stashKeyAction(e, stash.state.query, mac);
    switch (action.kind) {
      case 'none':
        return false;
      case 'enter': {
        // Enter on a button in the drawer presses it.
        if (e.target instanceof HTMLButtonElement && asideEl?.contains(e.target)) return false;
        const id = stashKbTarget(stash.state, visible);
        const row = id === null ? undefined : view.rows.find((r) => r.entry.id === id);
        if (!row) return false;
        onopen(row.entry);
        return true;
      }
      case 'escape':
        stash.update(escapeStash);
        return true;
      case 'sort':
        sortBy(action.sort);
        return true;
      case 'type':
        setQuery(stash.state.query + action.char);
        return true;
      case 'backspace':
        stash.update(backspaceStash);
        return true;
      case 'move': {
        stash.update((s) => moveStashKb(s, action.delta, visible));
        const id = stashKbTarget(stash.state, visible);
        void tick().then(() => {
          const el = id ? cardEl(id) : null;
          el?.focus({ preventScroll: true });
          el?.scrollIntoView({ block: 'nearest' });
        });
        return true;
      }
    }
  }

  function cardEnter(id: string): void {
    clearTimeout(expandTimer);
    if (draggingId !== null) return;
    expandTimer = setTimeout(() => {
      if (draggingId === null && stash.state.open) expandedId = id;
    }, EXPAND_MS);
  }

  function cardLeave(id: string): void {
    clearTimeout(expandTimer);
    if (expandedId === id) expandedId = null;
  }

  function onListPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest('.card-rm, .tag, .tag-add, .tag-edit')) return;
    const card = e.target.closest<HTMLElement>('[data-stash-id]');
    const id = card?.dataset.stashId;
    const row = id === undefined ? undefined : view.rows.find((r) => r.entry.id === id);
    if (!card || !row) return;
    e.preventDefault();
    clearTimeout(expandTimer);
    expandedId = null;
    onpress(row.entry, card, e);
  }
</script>

{#snippet magnifier()}
  <svg class="mag" viewBox="0 0 16 16" aria-hidden="true"
    ><circle cx="6.8" cy="6.8" r="4.8" fill="none" stroke="currentColor" stroke-width="1.7" /><path
      d="M10.4 10.4 14.2 14.2"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
    /></svg
  >
{/snippet}

<div
  class="stash-wrap"
  class:open
  class:narrow
  class:compact
  style:width="{width}px"
  role="presentation"
  bind:this={wrapEl}
  onpointerdowncapture={() => onfocusrequest()}
>
  <aside
    class="drawer stash-drawer"
    class:focused
    class:drop-ready={open && dropReady && !dropHot}
    class:drop-hot={open && dropHot}
    aria-label={t('stash.drawer.title')}
    inert={!open}
    bind:this={asideEl}
  >
    <div class="drawer-head">
      <div class="drawer-title">
        <b
          ><span class="st-g"><StashIcon name="tray" /></span>{t('stash.drawer.title')}
          <span class="cnt">· {view.total}</span></b
        >
        <small class="type-hint" class:off={!!stash.state.query}>{@render magnifier()}{t('stash.drawer.type_hint')}</small>
        <small class="focus-hint">{t('stash.drawer.focus_stash')} <kbd>→</kbd></small>
      </div>
      <div class="st-filter">
        {#if stash.state.repoChip !== null}
          <span class="fchip" title={t('stash.filter.chip_title', { n: windowNumber ?? '', repo: stash.state.repoChip })}
            ><StashIcon name="repo" stroke={1.4} />{stash.state.repoChip}<button
              class="fchip-x"
              type="button"
              aria-label={t('stash.filter.remove')}
              title={t('stash.filter.remove_title')}
              onclick={() => stash.update((s) => setRepoChip(s, null))}>×</button
            ></span
          >
        {:else if stash.repo !== null}
          <button
            class="f-add"
            type="button"
            title={t('stash.filter.add_title')}
            onclick={() => stash.update((s) => setRepoChip(s, stash.repo))}
            >+ <StashIcon name="repo" stroke={1.4} />{stash.repo}</button
          >
        {/if}
        <span class="f-note">{filterNote}</span>
      </div>
      <div class="sorts">
        <span class="lbl">{t('tabs.drawer.sort_label')}</span>
        {#each STASH_SORT_KEYS as sortKey, i (sortKey.sort)}
          {#if i > 0}<span class="dot" aria-hidden="true">·</span>{/if}
          <button
            type="button"
            class="sort-btn"
            class:flash={flashing === sortKey.sort}
            aria-pressed={stash.state.sort === sortKey.sort}
            data-ssort={sortKey.sort}
            title={t(`stash.drawer.sort_${sortKey.sort}_title`)}
            aria-keyshortcuts={acceleratorAriaKeyShortcuts(sortKey.accelerator)}
            onclick={() => sortBy(sortKey.sort)}
          >
            {t(`stash.drawer.sort_${sortKey.sort}`)}
            <kbd>{acceleratorLabel(sortKey.accelerator)}</kbd>
          </button>
        {/each}
      </div>
    </div>

    <div class="search" class:on={!!stash.state.query} aria-live="polite">
      <span class="s-ico" aria-hidden="true">{@render magnifier()}</span>
      <span class="s-q">{stash.state.query}</span><span class="caret" aria-hidden="true"></span>
      <span class="s-n">{searchNote}</span>
    </div>

    <div
      class="tab-list"
      role="listbox"
      aria-label={t('stash.drawer.title')}
      aria-activedescendant={kbId === null ? undefined : `stash-card-${kbId}`}
      tabindex="-1"
      bind:this={listEl}
      onpointerdown={onListPointerDown}
      oncontextmenu={(e) => e.preventDefault()}
    >
      {#if listOn}
        {#each rows as row (row.entry.id)}
          <div class="card-slot" animate:flip={{ duration: motion(300), easing: cubicOut }} in:arriveR out:collapseR>
            <StashCard
              entry={row.entry}
              title={entryTitle(row.entry, untitled)}
              match={row.match}
              query={view.text}
              hit={row.hit}
              {terms}
              holder={stash.holders.get(row.entry.path) ?? null}
              kb={row.entry.id === kbId}
              expanded={row.entry.id === expandedId}
              dragging={row.entry.id === draggingId}
              {compact}
              pulse={stash.pulse.has(row.entry.id)}
              pulseKey={stash.pulseKey(row.entry.id)}
              newTags={stash.newTags.get(row.entry.id) ?? []}
              {now}
              onremove={() => onremove(row.entry)}
              onfilter={filterByTag}
              onsettag={(change) => setTag(row.entry, change)}
              ondone={focusList}
              onhoverstart={() => cardEnter(row.entry.id)}
              onhoverend={() => cardLeave(row.entry.id)}
            />
          </div>
        {/each}
        {#if more > 0}<div class="more">{t('stash.drawer.more', { n: more })}</div>{/if}
        {#if emptyText}<div class="empty">{emptyText}</div>{/if}
      {/if}
    </div>

    <div class="st-foot">
      <span
        ><b>{t('stash.foot.drag')}</b> {t('stash.foot.drag_tail')} ·
        <span class="f-tag"><b>{t('stash.foot.tag')}</b> {t('stash.foot.tag_tail')} ·</span>
        <b>{t('stash.foot.keys')}</b>
        {t('stash.foot.keys_tail')}</span
      >
    </div>

    <div class="drop-veil" aria-hidden="true">
      <span><StashIcon name="tray" />{t('stash.bar.drop')}</span>
    </div>
  </aside>
</div>

<style>
  /* Values from the mockup (`.stash-wrap`, `.drawer.stash-drawer`, and the tabs
     drawer's shared chrome). Scoped styles cannot be shared with TabDrawer.svelte,
     so the chrome is repeated here — keep the two in step. */
  .stash-wrap {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 910;
    pointer-events: auto;
    font-family: var(--tabs-ui);
    color: var(--text-primary);
    transform: translateX(calc(100% + 8px));
    transition:
      transform 0.34s var(--tabs-ease),
      width 0.34s var(--tabs-ease);
  }

  .stash-wrap.open {
    transform: translateX(0);
  }

  .drawer {
    --acc: var(--color-stash);
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    background: var(--stash-tint);
    border: 1px solid var(--stash-line);
    border-right: none;
    border-radius: 14px 0 0 14px;
    box-shadow: none;
    transition: box-shadow 0.34s ease;
  }

  .open .drawer {
    box-shadow:
      -14px 0 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.4)),
      -2px 0 8px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
  }

  /* Focus is shown only by this rim, in the drawer's own colour; the other drawer is not dimmed. */
  .drawer::after {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    box-shadow:
      inset 0 0 0 1.5px color-mix(in oklab, var(--acc) 65%, transparent),
      0 0 16px 1px color-mix(in oklab, var(--acc) 30%, transparent);
  }

  .drawer.focused::after {
    opacity: 1;
  }

  .drawer-head {
    padding: 16px 18px 10px 20px;
    flex: 0 0 auto;
  }

  .drawer-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .drawer-title b {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.005em;
    white-space: nowrap;
  }

  .drawer-title .cnt {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 2px;
  }

  .st-g {
    display: inline-block;
    width: 14px;
    height: 14px;
    font-size: 14px;
    vertical-align: -2px;
    margin-right: 6px;
    color: var(--color-stash);
  }

  .drawer-title small {
    display: block;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .type-hint {
    transition: opacity 0.15s;
  }

  .type-hint.off {
    opacity: 0;
  }

  .drawer-title .focus-hint {
    display: none;
  }

  .focus-hint kbd {
    font-size: 11px;
    color: var(--text-subtle);
  }

  /* Without the keys, the header says how to get them back. */
  .open .drawer:not(.focused) .drawer-title .focus-hint {
    display: block;
  }

  .open .drawer:not(.focused) .type-hint {
    display: none;
  }

  .mag {
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    display: block;
  }

  .type-hint .mag {
    display: inline-block;
    vertical-align: middle;
    margin: -0.1em 5px 0 0;
  }

  .st-filter {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -3px 0 9px;
    min-height: 22px;
  }

  .fchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 2px 1px 8px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--color-stash) 16%, var(--bg-base));
    border: 1px solid var(--stash-line);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .fchip :global(svg),
  .f-add :global(svg) {
    width: 11px;
    height: 11px;
    color: var(--color-stash);
  }

  .fchip-x {
    border: 0;
    background: transparent;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font: inherit;
    font-size: 13px;
    line-height: 1;
    color: var(--text-muted);
    cursor: pointer;
  }

  .fchip-x:hover {
    background: var(--highlight);
    color: var(--text-primary);
  }

  .f-add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px dashed var(--stash-line);
    background: transparent;
    border-radius: 999px;
    padding: 2px 9px;
    font: inherit;
    font-size: 11.5px;
    color: var(--text-subtle);
    cursor: pointer;
    white-space: nowrap;
  }

  .f-add:hover {
    border-color: var(--color-stash);
    color: var(--text-primary);
  }

  .f-note {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sorts {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0;
    white-space: nowrap;
  }

  .sorts .lbl {
    font-size: 11px;
    color: var(--text-muted);
    margin-right: 2px;
  }

  .sorts .dot {
    color: var(--text-muted);
    opacity: 0.6;
    font-size: 11px;
    padding: 0 1px;
  }

  .narrow .sorts .lbl,
  .narrow .sorts kbd {
    display: none;
  }

  .sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid transparent;
    background: transparent;
    white-space: nowrap;
    border-radius: 7px;
    padding: 3px 6px;
    font: inherit;
    font-size: 11.5px;
    color: var(--text-subtle);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }

  .sort-btn:hover {
    background: var(--bg-base);
    border-color: var(--border);
    color: var(--text-primary);
  }

  .sort-btn[aria-pressed='true'] {
    background: var(--bg-base);
    border-color: var(--stash-line);
    color: var(--text-primary);
  }

  .sort-btn.flash {
    animation: flash 0.6s ease;
  }

  kbd {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .search {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 14px 0 12px;
    padding: 0 10px;
    height: 0;
    overflow: hidden;
    opacity: 0;
    background: var(--bg-base);
    border: 1px solid transparent;
    border-radius: 9px;
    font-size: 13px;
    transition:
      height 0.2s var(--tabs-ease),
      opacity 0.15s,
      margin 0.2s var(--tabs-ease),
      border-color 0.2s;
  }

  .search.on {
    height: 34px;
    opacity: 1;
    margin-bottom: 8px;
    border-color: var(--border);
  }

  .s-ico {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .s-q {
    white-space: pre;
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .caret {
    width: 1.5px;
    height: 15px;
    margin-left: -6px;
    background: var(--color-cursor, var(--text-primary));
    animation: blink 1.1s steps(1) infinite;
  }

  .s-n {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .tab-list {
    position: relative;
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 12px 14px 14px;
    scrollbar-width: thin;
    scrollbar-color: var(--highlight) transparent;
    outline: none;
  }

  .card-slot {
    padding-bottom: 7px;
  }

  .compact .card-slot {
    padding-bottom: 4px;
  }

  .empty {
    padding: 34px 10px;
    text-align: center;
    font-size: 12.5px;
    color: var(--text-muted);
    animation: arrive 0.3s var(--tabs-ease);
  }

  .more {
    padding: 6px 10px 12px;
    text-align: center;
    font-size: 11.5px;
    color: var(--text-muted);
  }

  .st-foot {
    flex: 0 0 auto;
    height: 38px;
    padding: 0 18px;
    display: flex;
    align-items: center;
    font-size: 11.5px;
    color: var(--text-muted);
    border-top: 1px solid color-mix(in oklab, var(--stash-line) 60%, transparent);
    white-space: nowrap;
    overflow: hidden;
  }

  .st-foot b {
    color: var(--text-subtle);
    font-weight: 600;
  }

  /* Past what fits it trails off rather than cutting a word in half. */
  .st-foot > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Squeezed (320–380 px) the whole hint does not fit — the mockup clips it too.
     «#тег — фильтр» goes: the head's «печатайте · #тег» already says it. */
  .narrow .st-foot .f-tag {
    display: none;
  }

  /* A tab card dragged anywhere: a dashed outline says the drawer takes it; over it, the label. */
  .drop-veil {
    position: absolute;
    inset: 8px;
    border-radius: 12px;
    border: 2px dashed var(--color-stash);
    background: color-mix(in oklab, var(--color-stash) 10%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.15s,
      background-color 0.15s;
    z-index: 8;
  }

  .drop-veil span {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--bg-base);
    border: 1px solid var(--stash-line);
    box-shadow: 0 6px 20px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
    font-size: 13px;
    font-weight: 600;
    transition: opacity 0.15s;
  }

  .drop-veil span :global(svg) {
    width: 16px;
    height: 16px;
    color: var(--color-stash);
  }

  .drop-ready .drop-veil {
    opacity: 1;
    background: transparent;
    border-color: color-mix(in oklab, var(--color-stash) 45%, transparent);
  }

  .drop-ready .drop-veil span {
    opacity: 0;
  }

  .drop-hot .drop-veil {
    opacity: 1;
    background: color-mix(in oklab, var(--color-stash) 10%, transparent);
    border-color: var(--color-stash);
  }

  .drop-hot .drop-veil span {
    opacity: 1;
  }

  /* The mockup flashes both drawers' sort buttons in the tabs' brand colour. */
  @keyframes flash {
    0% {
      background: color-mix(in oklab, var(--tabs-brand-a) 22%, var(--bg-base));
      color: var(--text-primary);
    }
    100% {
      background: transparent;
    }
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateX(18px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .caret,
    .empty {
      animation: none;
    }
    .stash-wrap,
    .drawer::after {
      transition-duration: 0.01s !important;
    }
  }
</style>
