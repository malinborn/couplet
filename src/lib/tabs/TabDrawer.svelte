<script lang="ts">
  /**
   * The tab drawer and its notch (spec §6; visual reference
   * docs/investigations/2026-09-24-tabs-mockup/drawer.html). Thin on purpose:
   * filter ranking, sorting, selection, keyboard routing and drop positions are
   * pure functions in this folder with their own tests; this component holds
   * the DOM, the timers and the pointer gestures.
   *
   * Keys: while open, a capture-phase `keydown` on `window` routes every key
   * through `drawerKeyAction` and takes it only if `actionAllowed` says so, so
   * CodeMirror never sees one the drawer used. Sort keys work in any open
   * drawer; typing only once the drawer has the keyboard (`typing`, Q5). The
   * moment it does, focus moves into the drawer and is kept there: keys the
   * drawer does not use (Backspace on an empty query, Space, Tab) then land on
   * the drawer, not on the document hidden behind it. ⌘J and ⌘1…⌘9 are native
   * menu items; App.svelte forwards them through `handle`.
   */
  import { tick, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import type { TransitionConfig } from 'svelte/transition';
  import TabCard from './TabCard.svelte';
  import TabNotch from './TabNotch.svelte';
  import { plural, t } from '../i18n';
  import { acceleratorAriaKeyShortcuts, acceleratorLabel, isMacPlatform } from '../editor/hotkey-label';
  import { nativeAccelerator } from '../editor/native-menu-accelerators';
  import type { TabListState, TabMeta } from './tab-model';
  import {
    CLOSED,
    DWELL_ARM_PX,
    DWELL_CAPTURE_MS,
    EXPAND_MS,
    HOVER_CLOSE_MS,
    HOVER_OPEN_MS,
    actionAllowed,
    captureTyping,
    clearSelection,
    close as closeState,
    drawerKeyAction,
    enterTarget,
    escape as escapeState,
    hintVisible,
    kbTarget,
    keysCaptured,
    moveKb,
    neighbourAfterRemoval,
    open as openState,
    pin,
    setKb,
    setQuery as setQueryState,
    setShift,
    toggleMany,
    type DrawerMode,
    type DrawerState,
  } from './drawer-state';
  import { filterEntries, type Match } from './drawer-filter';
  import { sortedOrder, type SortKind } from './drawer-sort';
  import { DRAWER_SORT_KEYS } from './drawer-keys';
  import { createDrawerData, type DrawerDataDeps, type GitInfo, type TabText } from './drawer-data';
  import { dropBefore, moveIds, pastThreshold, sweptIds, type Box } from './drawer-geometry';
  import { tabName } from './tab-name';

  export interface TabDrawerHandle {
    /** ⌘J. */
    toggle(): void;
    close(): void;
    /**
     * ⌘1…⌘9 while the drawer is open: the n-th visible card — the one whose
     * hint reads ⌘n (`null`: there is none). `undefined` while it is closed:
     * the key keeps its plain meaning.
     */
    shortcutTarget(n: number): string | null | undefined;
  }

  let {
    list,
    windowNumber,
    compact,
    source,
    onactivate,
    onclose,
    onreorder,
    onnewwindows,
    onrestorefocus,
    handle = $bindable(),
  }: {
    list: TabListState;
    windowNumber: number | null;
    compact: boolean;
    source: DrawerDataDeps;
    onactivate: (tabId: string) => void;
    onclose: (tabIds: string[]) => void;
    onreorder: (order: string[]) => void;
    onnewwindows: (tabIds: string[]) => void;
    /**
     * Closing with focus nowhere useful and nothing remembered to give it back
     * to (it was on <body> at open, or that element is gone): the app puts it
     * in the editor.
     */
    onrestorefocus?: () => void;
    handle?: TabDrawerHandle;
  } = $props();

  interface DragState {
    ids: string[];
    lead: TabMeta;
    x: number;
    y: number;
    /** Where on the card it was grabbed. */
    ox: number;
    oy: number;
    width: number;
    before: string | null;
    inList: boolean;
  }

  const mac = isMacPlatform();
  const drawerKey = acceleratorLabel(nativeAccelerator('toggle_drawer') ?? 'CmdOrCtrl+J');
  const shortcutLabels = Array.from({ length: 9 }, (_, i) => {
    const accelerator = nativeAccelerator(`select_tab_${i + 1}`);
    return accelerator ? acceleratorLabel(accelerator) : null;
  });

  let ds = $state<DrawerState>(CLOSED);
  let dataVersion = $state(0);
  let expandedId = $state<string | null>(null);
  let flashing = $state<SortKind | null>(null);
  let bump = $state(0);
  let drag = $state<DragState | null>(null);
  let selHintFits = $state(true);
  let rootEl: HTMLDivElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();
  let asideEl: HTMLElement | undefined = $state();
  let selHintEl: HTMLElement | undefined = $state();

  // Bookkeeping nothing renders from.
  let restoreFocus: HTMLElement | null = null;
  let gesture: 'press' | 'drag' | 'sweep' | null = null;
  let endGesture: (() => void) | null = null;
  let inWrap = false;
  let lastUnviewed = 0;
  /** The last input (key or press) went into an editable field outside the drawer (Q5). */
  let lastInputInEditable = false;
  /** The list as it was last rendered — to find the neighbour of a focused card that went away. */
  let lastVisible: readonly string[] = [];
  let hoverOpenTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let expandTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  /** The pointer's last known position over the notch or the drawer. */
  let lastPointer: { x: number; y: number } | null = null;
  /** Where the pointer was when this opening began; the dwell arms DWELL_ARM_PX away from it. */
  let dwellOrigin: { x: number; y: number } | null = null;
  let dwellArmed = false;
  /** Focus landed inside the drawer during this opening — only then is it ours to give back. */
  let tookFocus = false;

  const data = createDrawerData(
    {
      held: (id) => source.held(id),
      read: (path) => source.read(path),
      gitInfo: (paths) => source.gitInfo(paths),
    },
    () => {
      dataVersion++;
    }
  );

  const isOpen = $derived(ds.open);
  const captured = $derived(keysCaptured(ds));
  const byId = $derived(new Map(list.tabs.map((tab) => [tab.id, tab])));
  const texts = $derived.by(() => {
    void dataVersion;
    return new Map<string, TabText | null>(list.tabs.map((tab) => [tab.id, data.text(tab.id)]));
  });
  const gitOf = $derived.by(() => {
    void dataVersion;
    return new Map<string, GitInfo | null | undefined>(
      list.tabs.flatMap((tab) => (tab.path === null ? [] : [[tab.path, data.git(tab.path)] as const]))
    );
  });
  const filtered = $derived(
    ds.query
      ? filterEntries(
          list.tabs.map((tab) => ({
            id: tab.id,
            name: tabName(tab.path),
            index: texts.get(tab.id)?.index ?? null,
          })),
          ds.query
        )
      : null
  );
  const visible = $derived(filtered ? filtered.map((f) => f.id) : list.tabs.map((tab) => tab.id));
  const visibleTabs = $derived(
    visible.flatMap((id) => {
      const tab = byId.get(id);
      return tab ? [tab] : [];
    })
  );
  const matches = $derived(new Map<string, Match>((filtered ?? []).map((f) => [f.id, f.match])));
  // A tab closed while selected leaves the selection.
  const selected = $derived(new Set([...ds.selected].filter((id) => byId.has(id))));
  const kbId = $derived(ds.open ? kbTarget(ds, visible) : null);
  const unviewedCount = $derived(list.tabs.filter((tab) => tab.unviewed).length);
  const listLabel = $derived(t('tabs.notch.aria', { n: windowNumber ?? '' }));
  const searchNote = $derived(
    ds.query
      ? [
          visible.length > 0 ? t('tabs.drawer.search_count', { shown: visible.length, total: list.tabs.length }) : '',
          t('tabs.drawer.search_reset'),
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  );
  const dropTop = $derived.by(() => {
    const d = drag;
    if (!d?.inList || !listEl) return null;
    const slotOf = (id: string) => cardEl(id)?.closest<HTMLElement>('.card-slot') ?? null;
    if (d.before !== null) {
      const slot = slotOf(d.before);
      return slot ? slot.offsetTop - 5 : null;
    }
    const rest = visible.filter((id) => !d.ids.includes(id));
    const last = rest.length > 0 ? slotOf(rest[rest.length - 1]) : null;
    return last ? last.offsetTop + last.offsetHeight - 6 : null;
  });

  $effect(() => {
    handle = {
      // ⌘J on a hover-opened drawer takes it (tabs-questions Q5) rather than
      // closing it — the same as a click on the notch.
      toggle: () => {
        if (!ds.open) openDrawer('pinned');
        else if (ds.mode === 'hover') pinNow();
        else closeDrawer();
      },
      close: () => closeDrawer(),
      shortcutTarget: (n) => (ds.open ? (visible[n - 1] ?? null) : undefined),
    };
  });

  // Where the last input went (tabs-questions Q5): a hover-open right after
  // typing in — or clicking into — the editor leaves the keyboard there. Input
  // into the drawer itself (its search, a press on the notch) is input
  // somewhere else; so is typing in the editor behind a drawer that left it
  // the keys.
  $effect(() => {
    const note = (e: Event) => {
      lastInputInEditable = !insideDrawer(e.target) && editable(e.target);
    };
    window.addEventListener('keydown', note, true);
    window.addEventListener('pointerdown', note, true);
    return () => {
      window.removeEventListener('keydown', note, true);
      window.removeEventListener('pointerdown', note, true);
    };
  });

  // The drawer took the keyboard: focus goes with it. Keys it does not use —
  // Backspace on an empty query, Space, Tab — would otherwise still land in
  // the editor behind it and edit a document nobody can see.
  $effect(() => {
    if (captured) focusList();
  });

  // Tabs that arrive while the drawer is open get their text too.
  $effect(() => {
    if (isOpen) data.ensure(list.tabs);
  });

  // The count gives a small jump when an unviewed tab arrives.
  $effect(() => {
    const n = unviewedCount;
    if (n > lastUnviewed) bump = untrack(() => bump) + 1;
    lastUnviewed = n;
  });

  // A focused card that goes away (×, ⌘-click, a group close) would drop the
  // keyboard onto <body> with no focusout the trap could see: hand it to the
  // neighbour card, or to the list.
  $effect(() => {
    const now = visible;
    untrack(() => {
      const before = lastVisible;
      lastVisible = now;
      if (!keysCaptured(ds)) return;
      const kb = ds.kb;
      void tick().then(() => {
        const focused = document.activeElement;
        const focusedId = focused instanceof HTMLElement ? focused.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId : undefined;
        const lost = !focused || focused === document.body || (focusedId !== undefined && !now.includes(focusedId));
        if (!lost || !keysCaptured(ds)) return;
        const gone = focusedId ?? (kb !== null && !now.includes(kb) ? kb : null);
        const next = gone === null ? null : neighbourAfterRemoval(before, now, gone);
        if (next !== null && gone === kb) {
          ds = setKb(ds, next);
          void tick().then(() => cardEl(next)?.focus({ preventScroll: true }));
        } else {
          listEl?.focus({ preventScroll: true });
        }
      });
    });
  });

  // «⇧ — выделить» is the first thing to go when the header row is too narrow.
  $effect(() => {
    const el = selHintEl;
    if (!el) return;
    const measure = () => {
      selHintFits = el.scrollWidth <= el.clientWidth + 0.5;
    };
    measure();
    void document.fonts?.ready.then(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });

  $effect(() => () => {
    removeWindowListeners();
    endGesture?.();
    for (const timer of [hoverOpenTimer, hoverCloseTimer, expandTimer, flashTimer, dwellTimer]) clearTimeout(timer);
  });

  function reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function motion(ms: number): number {
    return reducedMotion() ? 0 : ms;
  }

  function arrive(_node: Element): TransitionConfig {
    return {
      duration: motion(500),
      easing: cubicOut,
      css: (k) => `opacity: ${k}; transform: translateX(${(1 - k) * -18}px);`,
    };
  }

  function collapse(node: Element): TransitionConfig {
    const el = node as HTMLElement;
    const height = el.offsetHeight;
    const padding = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    return {
      duration: motion(230),
      easing: cubicOut,
      css: (k) =>
        `overflow: hidden; opacity: ${k}; height: ${k * height}px; padding-bottom: ${k * padding}px;` +
        ` transform: translateX(${(1 - k) * -30}px) scale(${0.97 + 0.03 * k});`,
    };
  }

  function editable(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
    return target instanceof Element && target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
  }

  function insideDrawer(target: EventTarget | null): boolean {
    return !!rootEl && target instanceof Node && rootEl.contains(target);
  }

  function cardEl(id: string): HTMLElement | null {
    return listEl?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`) ?? null;
  }

  function cardBoxes(): Box[] {
    return visible.flatMap((id) => {
      const el = cardEl(id);
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [{ id, top: r.top, bottom: r.bottom }];
    });
  }

  function metaText(tab: TabMeta): string {
    if (tab.path === null) return t('tabs.card.unsaved');
    const info = gitOf.get(tab.path);
    if (!info) return '';
    return info.branch ? `${info.project} · ⎇ ${info.branch}` : info.project;
  }

  /** ⇧ is read from every event the drawer handles, so a ⇧ released outside the window cannot stick. */
  function trackShift(e: KeyboardEvent | PointerEvent): void {
    ds = setShift(ds, e.shiftKey);
  }

  // --- open / close ---

  function addWindowListeners(): void {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onWindowBlur);
  }

  function removeWindowListeners(): void {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onWindowBlur);
  }

  /** After the render that lifts `inert` — an inert list cannot take focus. */
  function focusList(): void {
    void tick().then(() => {
      if (keysCaptured(ds) && !insideDrawer(document.activeElement)) listEl?.focus({ preventScroll: true });
    });
  }

  function openDrawer(mode: DrawerMode): void {
    clearTimeout(hoverOpenTimer);
    clearTimeout(hoverCloseTimer);
    if (ds.open) {
      ds = openState(ds, mode);
      return;
    }
    const focused = document.activeElement;
    restoreFocus = focused instanceof HTMLElement && focused !== document.body && !insideDrawer(focused) ? focused : null;
    ds = openState(ds, mode, !lastInputInEditable);
    dwellOrigin = lastPointer;
    dwellArmed = false;
    tookFocus = false;
    data.refresh(list.tabs);
    addWindowListeners();
  }

  function closeDrawer(): void {
    if (!ds.open) return;
    endGesture?.();
    clearTimeout(hoverCloseTimer);
    clearTimeout(expandTimer);
    clearTimeout(dwellTimer);
    removeWindowListeners();
    const active = document.activeElement;
    // Focus on <body> after the drawer held it is focus the drawer lost (a
    // removed card, a press that blurred): give it back too. Focus that was on
    // <body> all along (a fresh load blurs the editor on purpose) is not ours.
    const restore = insideDrawer(active) || (tookFocus && (!active || active === document.body));
    ds = closeState(ds);
    expandedId = null;
    const target = restoreFocus;
    restoreFocus = null;
    if (!restore) return;
    if (target?.isConnected) {
      target.focus({ preventScroll: true });
    } else {
      if (active instanceof HTMLElement && insideDrawer(active)) active.blur();
      onrestorefocus?.();
    }
  }

  function activate(id: string): void {
    closeDrawer();
    if (id !== list.activeId) onactivate(id);
  }

  /**
   * Focus leaving a drawer that has the keyboard — Tab past its last button,
   * a click on the AI button, a programmatic `view.focus()` — comes back. A
   * move to nowhere (the window losing focus) is left alone.
   */
  function onFocusIn(): void {
    if (ds.open) tookFocus = true;
  }

  function onFocusOut(e: FocusEvent): void {
    if (!keysCaptured(ds)) return;
    const next = e.relatedTarget;
    if (!(next instanceof Element) || insideDrawer(next)) return;
    // A panel with a keyboard of its own (CodeMirror's search, Recent Files)
    // may take it; the app closes the drawer for those anyway.
    if (next.closest('.cm-panels, [role="dialog"]')) return;
    focusList();
  }

  // --- pointer takes the keyboard (Q5) ---
  //
  // Not on entering: a hover-open slides the drawer under a pointer resting on
  // the notch, so the first twitch is already "inside". A press, a scroll, or
  // a rest of DWELL_CAPTURE_MS is a decision to use the drawer — a true rest:
  // every move starts the wait again, so a slow pass never captures, and only
  // after the pointer has travelled DWELL_ARM_PX from where it was at the
  // hover-open, so a twitch of the hand on the notch does not either.

  function captureNow(): void {
    clearTimeout(dwellTimer);
    ds = captureTyping(ds);
  }

  function restDwell(e: PointerEvent): void {
    clearTimeout(dwellTimer);
    if (!ds.open || ds.typing) return;
    if (!dwellArmed) {
      dwellOrigin ??= { x: e.clientX, y: e.clientY };
      if (Math.hypot(e.clientX - dwellOrigin.x, e.clientY - dwellOrigin.y) < DWELL_ARM_PX) return;
      dwellArmed = true;
    }
    dwellTimer = setTimeout(captureNow, DWELL_CAPTURE_MS);
  }

  function drawerEnter(e: PointerEvent): void {
    trackShift(e);
    restDwell(e);
  }

  function drawerLeave(e: PointerEvent): void {
    trackShift(e);
    clearTimeout(dwellTimer);
  }

  // --- hover ---

  function notchEnter(): void {
    if (!ds.open && !gesture) hoverOpenTimer = setTimeout(() => openDrawer('hover'), HOVER_OPEN_MS);
  }

  function notchLeave(): void {
    clearTimeout(hoverOpenTimer);
  }

  function pinNow(): void {
    ds = pin(ds);
  }

  function notchClick(): void {
    clearTimeout(hoverOpenTimer);
    if (ds.open && ds.mode === 'hover') pinNow();
    else if (ds.open) closeDrawer();
    else openDrawer('pinned');
  }

  function wrapMove(e: PointerEvent): void {
    trackShift(e);
    lastPointer = { x: e.clientX, y: e.clientY };
  }

  function wrapEnter(e: PointerEvent): void {
    wrapMove(e);
    inWrap = true;
    clearTimeout(hoverCloseTimer);
  }

  function wrapLeave(e: PointerEvent): void {
    trackShift(e);
    inWrap = false;
    scheduleHoverClose();
  }

  function scheduleHoverClose(): void {
    clearTimeout(hoverCloseTimer);
    if (!ds.open || ds.mode !== 'hover') return;
    hoverCloseTimer = setTimeout(() => {
      if (!gesture && !inWrap && ds.mode === 'hover') closeDrawer();
    }, HOVER_CLOSE_MS);
  }

  function cardEnter(id: string): void {
    clearTimeout(expandTimer);
    if (gesture) return;
    expandTimer = setTimeout(() => {
      if (!gesture && ds.open) expandedId = id;
    }, EXPAND_MS);
  }

  function cardLeave(id: string): void {
    clearTimeout(expandTimer);
    if (expandedId === id) expandedId = null;
  }

  // --- keys ---

  function onKeyDown(e: KeyboardEvent): void {
    trackShift(e);
    // The IME owns the key: a composed character is not a search letter.
    if (e.isComposing || e.keyCode === 229) return;
    const action = drawerKeyAction(e, ds.query, mac);
    // A hover-open right after typing in the editor: typing stays with the
    // editor until the pointer enters the drawer or it is pinned (Q5); sort
    // keys work regardless.
    if (action.kind === 'none' || !actionAllowed(ds, action)) return;
    // Enter on a focused drawer button presses it; with no card to open it is
    // not the drawer's either.
    // Enter on a button in the panel presses it, and with no card to open it
    // is not the drawer's either. Not the notch: a query's top result wins.
    if (
      action.kind === 'enter' &&
      ((e.target instanceof HTMLButtonElement && !!asideEl?.contains(e.target)) || enterTarget(ds, visible) === null)
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    switch (action.kind) {
      case 'escape': {
        const next = escapeState(ds);
        if (next.open) ds = next;
        else closeDrawer();
        break;
      }
      case 'sort':
        sortBy(action.sort);
        break;
      case 'type':
        setQuery(ds.query + action.char);
        break;
      case 'backspace':
        setQuery(ds.query.slice(0, -1));
        break;
      case 'move': {
        ds = moveKb(ds, action.delta, visible, list.activeId);
        const id = kbTarget(ds, visible);
        void tick().then(() => {
          const el = id ? cardEl(id) : null;
          el?.focus({ preventScroll: true });
          el?.scrollIntoView({ block: 'nearest' });
        });
        break;
      }
      case 'enter': {
        const id = enterTarget(ds, visible);
        if (id) activate(id);
        break;
      }
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    trackShift(e);
  }

  function onWindowBlur(): void {
    // A pointerup outside the window may never arrive: cancel, not finish.
    endGesture?.();
    ds = setShift(ds, false);
  }

  function setQuery(query: string): void {
    ds = setQueryState(ds, query);
    if (listEl) listEl.scrollTop = 0;
  }

  function sortBy(kind: SortKind): void {
    onreorder(sortedOrder(list.tabs, kind, list.activeId));
    flashing = null;
    clearTimeout(flashTimer);
    requestAnimationFrame(() => {
      flashing = kind;
      flashTimer = setTimeout(() => {
        flashing = null;
      }, 600);
    });
    listEl?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // --- selection actions ---

  function selectedIds(): string[] {
    return list.tabs.filter((tab) => selected.has(tab.id)).map((tab) => tab.id);
  }

  function closeSelected(): void {
    const ids = selectedIds();
    ds = clearSelection(ds);
    onclose(ids);
  }

  function moveSelected(): void {
    const ids = selectedIds();
    closeDrawer();
    onnewwindows(ids);
  }

  // --- pointer gestures ---

  function commandKey(e: PointerEvent): boolean {
    return mac ? e.metaKey : e.ctrlKey;
  }

  function track(move: (ev: PointerEvent) => void, finish: (ev: PointerEvent | null) => void): void {
    const onMove = (ev: PointerEvent) => {
      trackShift(ev);
      // The button is up but the pointerup was lost (released outside the window).
      if (ev.buttons === 0) {
        cancel();
        return;
      }
      move(ev);
    };
    const up = (ev: PointerEvent) => {
      trackShift(ev);
      stop();
      finish(ev);
    };
    const cancel = () => {
      stop();
      finish(null);
    };
    function stop(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      endGesture = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    endGesture = cancel;
  }

  function onListPointerDown(e: PointerEvent): void {
    trackShift(e);
    // A gesture still running here lost its pointerup: drop it.
    endGesture?.();
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest('.card-close')) return;
    const card = e.target.closest<HTMLElement>('[data-tab-id]');
    const id = card?.dataset.tabId;
    if (!card || !id || !visible.includes(id)) return;
    e.preventDefault();
    if (commandKey(e)) {
      onclose([id]);
      return;
    }
    capturePointer(e);
    if (e.shiftKey) {
      startSweep(id, e);
      return;
    }
    startPress(id, card, e);
  }

  /** Moves and the release keep coming to the list even past the window's edge. */
  function capturePointer(e: PointerEvent): void {
    try {
      listEl?.setPointerCapture?.(e.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): the window listeners still track it.
    }
  }

  function startSweep(id: string, e: PointerEvent): void {
    gesture = 'sweep';
    clearTimeout(expandTimer);
    expandedId = null;
    const swept = new Set([id]);
    ds = toggleMany(ds, [id]);
    let prevY = e.clientY;
    track(
      (ev) => {
        const fresh = sweptIds(cardBoxes(), prevY, ev.clientY).filter((x) => !swept.has(x));
        for (const x of fresh) swept.add(x);
        if (fresh.length > 0) ds = toggleMany(ds, fresh);
        prevY = ev.clientY;
        autoScroll(ev.clientY);
      },
      () => {
        gesture = null;
      }
    );
  }

  function startPress(id: string, card: HTMLElement, e: PointerEvent): void {
    gesture = 'press';
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    track(
      (ev) => {
        if (!dragging && pastThreshold(ev.clientX - sx, ev.clientY - sy)) {
          dragging = beginDrag(id, card, sx, sy);
        }
        if (dragging) dragMove(ev);
      },
      (ev) => {
        gesture = null;
        if (dragging) finishDrag(ev !== null);
        else if (ev) activate(id);
      }
    );
  }

  function beginDrag(id: string, card: HTMLElement, sx: number, sy: number): boolean {
    const lead = byId.get(id);
    if (!lead) return false;
    gesture = 'drag';
    clearTimeout(expandTimer);
    expandedId = null;
    const ids = selected.has(id) ? selectedIds() : [id];
    const r = card.getBoundingClientRect();
    drag = { ids, lead, x: sx, y: sy, ox: sx - r.left, oy: sy - r.top, width: r.width, before: null, inList: false };
    return true;
  }

  function overList(x: number, y: number): boolean {
    const r = listEl?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function dragMove(ev: PointerEvent): void {
    const d = drag;
    if (!d) return;
    // A filtered view has no manual order to drop into (mockup).
    const inList = !ds.query && overList(ev.clientX, ev.clientY);
    drag = {
      ...d,
      x: ev.clientX,
      y: ev.clientY,
      inList,
      before: inList ? dropBefore(cardBoxes(), ev.clientY, new Set(d.ids)) : null,
    };
    if (inList) autoScroll(ev.clientY);
  }

  function finishDrag(dropped: boolean): void {
    const d = drag;
    drag = null;
    if (dropped && d?.inList) {
      onreorder(moveIds(list.tabs.map((tab) => tab.id), d.ids, d.before));
    }
    if (ds.mode === 'hover' && !inWrap) scheduleHoverClose();
  }

  function autoScroll(y: number): void {
    if (!listEl) return;
    const r = listEl.getBoundingClientRect();
    if (y < r.top + 36) listEl.scrollTop -= 10;
    else if (y > r.bottom - 36) listEl.scrollTop += 10;
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
  class="tab-drawer"
  class:open={ds.open}
  class:compact
  class:shift={ds.open && ds.shiftHeld}
  bind:this={rootEl}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
>
  <!-- mousedown's default would blur the editor closeDrawer just refocused. -->
  <div
    class="scrim"
    aria-hidden="true"
    onpointerdown={() => closeDrawer()}
    onmousedown={(e) => e.preventDefault()}
  ></div>
  <div
    class="drawer-wrap"
    role="presentation"
    onpointerenter={wrapEnter}
    onpointerleave={wrapLeave}
    onpointermove={wrapMove}
    onpointerdown={trackShift}
  >
    <aside
      class="drawer"
      id="tab-drawer"
      aria-label={listLabel}
      inert={!ds.open}
      bind:this={asideEl}
      onpointerenter={drawerEnter}
      onpointermove={restDwell}
      onpointerleave={drawerLeave}
      onpointerdown={captureNow}
      onwheel={captureNow}
    >
      <div class="drawer-head">
        <!-- One text baseline for all three items: plain blocks aligned by the
             row's `baseline` (see the mockup's note on why no inline-flex and
             no overflow:hidden here). -->
        <div class="drawer-title">
          <b
            >{t('tabs.drawer.window')}<span class="wno">#{windowNumber ?? ''}</span>
            <span class="cnt">· {plural(list.tabs.length, 'tabs.drawer.count')}</span></b
          >
          <small
            class="sel-hint"
            class:off={!!ds.query}
            class:nofit={!selHintFits}
            bind:this={selHintEl}
            aria-hidden="true">{t('tabs.drawer.select_hint')}</small
          >
          <small class="type-hint" class:off={!!ds.query}>{@render magnifier()}{t('tabs.drawer.type_hint')}</small>
        </div>
        <div class="sorts">
          <span class="lbl">{t('tabs.drawer.sort_label')}</span>
          {#each DRAWER_SORT_KEYS as key, i (key.sort)}
            {#if i > 0}<span class="dot" aria-hidden="true">·</span>{/if}
            <button
              type="button"
              class="sort-btn"
              class:flash={flashing === key.sort}
              data-sort={key.sort}
              title={t(`tabs.drawer.sort_${key.sort}_title`)}
              aria-keyshortcuts={acceleratorAriaKeyShortcuts(key.accelerator)}
              onclick={() => sortBy(key.sort)}
            >
              {#if key.sort === 'ai'}<span class="ai-g" aria-hidden="true">✦</span>{/if}
              {t(`tabs.drawer.sort_${key.sort}`)}
              <kbd>{acceleratorLabel(key.accelerator)}</kbd>
            </button>
          {/each}
        </div>
      </div>

      <div class="search" class:on={!!ds.query} aria-live="polite">
        <span class="s-ico" aria-hidden="true">{@render magnifier()}</span>
        <span class="s-q">{ds.query}</span><span class="caret" aria-hidden="true"></span>
        <span class="s-n">{searchNote}</span>
      </div>

      <div
        class="tab-list"
        role="tablist"
        aria-orientation="vertical"
        aria-label={listLabel}
        tabindex="-1"
        bind:this={listEl}
        onpointerdown={onListPointerDown}
        oncontextmenu={(e) => e.preventDefault()}
      >
        {#each visibleTabs as tab, i (tab.id)}
          <div class="card-slot" animate:flip={{ duration: motion(300), easing: cubicOut }} in:arrive out:collapse>
            <TabCard
              {tab}
              name={tabName(tab.path)}
              active={tab.id === list.activeId}
              selected={selected.has(tab.id)}
              kb={tab.id === kbId}
              expanded={tab.id === expandedId}
              dragging={drag?.ids.includes(tab.id) ?? false}
              {compact}
              query={ds.query}
              match={matches.get(tab.id)}
              text={texts.get(tab.id) ?? null}
              git={tab.path === null ? null : gitOf.get(tab.path)}
              shortcut={i < 9 ? shortcutLabels[i] : null}
              onclose={() => onclose([tab.id])}
              onhoverstart={() => cardEnter(tab.id)}
              onhoverend={() => cardLeave(tab.id)}
            />
          </div>
        {/each}
        {#if ds.query && visible.length === 0}<div class="empty">{t('tabs.drawer.empty')}</div>{/if}
        <div class="drop-ind" class:on={dropTop !== null} style:top={dropTop === null ? null : `${dropTop}px`}></div>
      </div>

      <div class="sel-bar" class:on={ds.open && selected.size > 0}>
        <span class="n">{plural(selected.size, 'tabs.selection.count')}<small>{t('tabs.selection.drag_hint')}</small></span>
        <button type="button" onclick={moveSelected}
          >{t(selected.size === 1 ? 'tabs.selection.new_window' : 'tabs.selection.new_windows')}</button
        >
        <button type="button" onclick={closeSelected}>{t('tabs.selection.close')}</button>
        <button
          type="button"
          class="x"
          title={t('tabs.selection.clear')}
          aria-label={t('tabs.selection.clear')}
          onclick={() => {
            ds = clearSelection(ds);
          }}>×</button
        >
      </div>

      <div class="hint" class:on={hintVisible(ds)}>
        <span
          ><b>{t('tabs.hint.select')}</b> {t('tabs.hint.select_tail')} · <b>{t('tabs.hint.close')}</b>
          {t('tabs.hint.close_tail')}</span
        >
      </div>
    </aside>
    <TabNotch
      number={windowNumber}
      count={list.tabs.length}
      unviewed={unviewedCount}
      {bump}
      open={ds.open}
      keyLabel={drawerKey}
      onenter={notchEnter}
      onleave={notchLeave}
      onclick={notchClick}
    />
  </div>

  {#if drag}
    <div
      class="ghost"
      class:multi={drag.ids.length > 1}
      class:cancel={!drag.inList}
      aria-hidden="true"
      style:width="{drag.width}px"
      style:transform="translate({drag.x - drag.ox}px, {drag.y - drag.oy}px) rotate(-1.2deg)"
    >
      <div class="ghost-body">
        <div class="ghost-name">{tabName(drag.lead.path)}</div>
        <div class="ghost-meta">{metaText(drag.lead)}</div>
      </div>
      {#if drag.ids.length > 1}<div class="ghost-count">{drag.ids.length}</div>{/if}
    </div>
  {/if}
</div>

<style>
  /* No box of its own: a positioned root — even `position: fixed` without a
     z-index — would be a stacking context, and the AI button (fixed, 880)
     would paint over the whole open drawer. The scrim (850) and the drawer
     (900) must stack with it in the page's context, as in the mockup. */
  .tab-drawer {
    display: contents;
    font-family: var(--tabs-ui);
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;
  }

  .tab-drawer :global(*) {
    box-sizing: border-box;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 850;
    background: var(--bg-overlay);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.28s ease;
    -webkit-backdrop-filter: blur(1.5px);
    backdrop-filter: blur(1.5px);
  }

  .open .scrim {
    opacity: 0.7;
    pointer-events: auto;
  }

  .drawer-wrap {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(420px, 52vw);
    z-index: 900;
    pointer-events: auto;
    transform: translateX(-100%);
    transition: transform 0.34s var(--tabs-ease);
  }

  .open .drawer-wrap {
    transform: translateX(0);
  }

  .drawer {
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-left: none;
    border-radius: 0 14px 14px 0;
    box-shadow:
      10px 0 40px rgba(var(--tabs-shadow-rgb), 0),
      0 0 0 rgba(0, 0, 0, 0);
    transition: box-shadow 0.34s ease;
  }

  .open .drawer {
    box-shadow:
      14px 0 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 1.4)),
      2px 0 8px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
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

  .wno {
    font-family: var(--font-code);
    font-weight: 400;
    color: var(--text-subtle);
    margin-left: 3px;
  }

  .drawer-title .cnt {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 2px;
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

  .sel-hint {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0 10px;
    text-align: center;
    transition: opacity 0.15s;
  }

  .sel-hint.off {
    opacity: 0;
  }

  .sel-hint.nofit {
    opacity: 0;
    visibility: hidden;
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

  .sort-btn.flash {
    animation: flash 0.6s ease;
  }

  .ai-g {
    background: linear-gradient(100deg, var(--tabs-ai-a), var(--tabs-ai-b));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  kbd {
    font-family: var(--tabs-ui);
    font-size: 10.5px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .tab-list {
    position: relative;
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 14px 14px 12px;
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

  .drop-ind {
    position: absolute;
    left: 14px;
    right: 14px;
    height: 2px;
    border-radius: 2px;
    background: var(--tabs-brand-a);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--tabs-brand-a) 18%, transparent);
    opacity: 0;
    pointer-events: none;
    transition:
      top 0.12s var(--tabs-ease),
      opacity 0.12s;
  }

  .drop-ind::before {
    content: '';
    position: absolute;
    left: -4px;
    top: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tabs-brand-a);
  }

  .drop-ind.on {
    opacity: 1;
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

  .empty {
    padding: 34px 10px;
    text-align: center;
    font-size: 12.5px;
    color: var(--text-muted);
    animation: arrive 0.3s var(--tabs-ease);
  }

  .sel-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 12px;
    padding: 0 8px 0 12px;
    height: 0;
    overflow: hidden;
    background: var(--bg-base);
    border: 1px solid transparent;
    border-radius: 10px;
    font-size: 12px;
    color: var(--text-subtle);
    opacity: 0;
    transition:
      height 0.22s var(--tabs-ease),
      opacity 0.18s,
      margin 0.22s var(--tabs-ease),
      border-color 0.2s;
  }

  .sel-bar.on {
    height: 40px;
    opacity: 1;
    margin-bottom: 8px;
    border-color: color-mix(in oklab, var(--tabs-brand-a) 45%, transparent);
  }

  .sel-bar .n {
    flex: 1;
    color: var(--text-primary);
    font-weight: 600;
    white-space: nowrap;
  }

  .sel-bar .n small {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 6px;
  }

  .sel-bar button {
    border: 1px solid var(--border);
    background: var(--bg-surface);
    border-radius: 7px;
    padding: 4px 8px;
    font: inherit;
    font-size: 11.5px;
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .sel-bar button:hover {
    border-color: var(--text-muted);
  }

  .sel-bar button.x {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    padding: 2px 5px;
  }

  /* Quick: it tracks the Shift key. */
  .hint {
    flex: 0 0 auto;
    padding: 0 18px;
    height: 0;
    overflow: hidden;
    opacity: 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    border-top: 1px solid transparent;
    transition:
      height 0.14s var(--tabs-ease),
      opacity 0.12s,
      border-color 0.12s;
  }

  .hint.on {
    height: 36px;
    opacity: 1;
    border-top-color: color-mix(in oklab, var(--border) 70%, transparent);
  }

  .hint b {
    white-space: nowrap;
    color: var(--text-subtle);
    font-weight: 600;
  }

  .ghost {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 9000;
    pointer-events: none;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 11px;
    overflow: hidden;
    box-shadow:
      0 18px 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 2)),
      0 2px 6px rgba(var(--tabs-shadow-rgb), var(--tabs-shadow-a));
    transition: opacity 0.18s;
  }

  .ghost.multi {
    box-shadow:
      5px 5px 0 -1px var(--bg-base),
      5px 5px 0 0 var(--border),
      10px 10px 0 -2px var(--bg-base),
      10px 10px 0 -1px var(--border),
      0 18px 44px rgba(var(--tabs-shadow-rgb), calc(var(--tabs-shadow-a) * 2));
  }

  .ghost.cancel {
    opacity: 0.6;
  }

  .ghost-body {
    padding: 10px 12px 11px 14px;
  }

  .ghost-name {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ghost-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .ghost-count {
    position: absolute;
    right: 8px;
    bottom: 8px;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--tabs-brand-a);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }

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
      transform: translateX(-18px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .caret,
    .empty {
      animation: none;
    }
    .drawer-wrap,
    .scrim {
      transition-duration: 0.01s !important;
    }
  }
</style>
