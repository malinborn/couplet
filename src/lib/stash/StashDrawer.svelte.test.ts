// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashDrawer, { type StashDrawerHandle } from './StashDrawer.svelte';
import { RELOAD_COALESCE_MS, createStashStore, type StashStore } from './stash-store.svelte';
import { STASH_RENDER_CAP } from './stash-view';
import type { StashEntry, TabHolder } from './types';

const NOW = Date.now();
const MIN = 60_000;

function entry(id: string, over: Partial<StashEntry> = {}): StashEntry {
  return {
    id,
    kind: 'note',
    path: `/n/${id}.md`,
    title: `Title ${id}`,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: NOW - 100 * MIN,
    stashedAt: null,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

const ENTRIES = [
  entry('a', { modifiedAt: NOW - 5 * MIN, repo: 'shelf' }),
  entry('b', { modifiedAt: NOW - 50 * MIN, repo: 'shelf', kind: 'file', title: 'b.md', openedAt: NOW - MIN }),
  entry('c', { modifiedAt: NOW - 500 * MIN, repo: 'infra', tags: ['ops'] }),
  entry('d', { modifiedAt: NOW - 1 * MIN, repo: 'shelf' }),
];

interface H {
  store: StashStore;
  root: HTMLElement;
  handle: () => StashDrawerHandle;
  onopen: ReturnType<typeof vi.fn>;
  onpress: ReturnType<typeof vi.fn>;
  onsettag: ReturnType<typeof vi.fn>;
  onfocusrequest: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

let h: H;

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {} as Element['scrollTo'];
  Element.prototype.animate ??= function () {
    return { cancel() {}, finished: Promise.resolve(), onfinish: null } as unknown as Animation;
  };
  Element.prototype.getAnimations ??= () => [];
  // Reduced motion: every transition gets duration 0, which Svelte finishes at
  // once. The `animate` stub above never fires `onfinish`, so without this a
  // filtered-out card would stay in the DOM for good, mid-outro.
  globalThis.matchMedia ??= ((query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof matchMedia;
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (s: string) => s;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

interface SetupOpts {
  repo?: string | null;
  openHere?: string[];
  holders?: (TabHolder | null)[];
  compact?: boolean;
  dropReady?: boolean;
  dropHot?: boolean;
  /** Leave the stash closed. */
  closed?: boolean;
  /** The stash's entries (default `ENTRIES`); read on every load. */
  list?: () => StashEntry[];
}

async function setup(opts: SetupOpts = {}): Promise<H> {
  const store = createStashStore({
    list: async () => (opts.list ? opts.list() : ENTRIES),
    counts: async () => ({ total: ENTRIES.length, stashedToday: 0, deleted: 0 }),
    holders: async (paths) => opts.holders ?? paths.map(() => null),
    windowRepo: async () => opts.repo ?? null,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state<{ handle: StashDrawerHandle | undefined }>({ handle: undefined });
  const onopen = vi.fn();
  const onpress = vi.fn();
  const onsettag = vi.fn();
  const onfocusrequest = vi.fn();
  const component = mount(StashDrawer, {
    target,
    props: {
      stash: store,
      openHere: new Set(opts.openHere ?? []),
      width: 400,
      narrow: false,
      compact: opts.compact ?? false,
      windowNumber: 22,
      dropReady: opts.dropReady ?? false,
      dropHot: opts.dropHot ?? false,
      draggingId: null,
      onpress,
      onopen,
      onremove: vi.fn(),
      onsettag,
      onfocusrequest,
      get handle() {
        return props.handle;
      },
      set handle(v: StashDrawerHandle | undefined) {
        props.handle = v;
      },
    },
  });
  if (!opts.closed) store.open();
  await settle();
  return {
    store,
    root: target,
    handle: () => {
      if (!props.handle) throw new Error('no handle');
      return props.handle;
    },
    onopen,
    onpress,
    onsettag,
    onfocusrequest,
    destroy: () => {
      unmount(component);
      target.remove();
    },
  };
}

const ids = () => [...h.root.querySelectorAll<HTMLElement>('[data-stash-id]')].map((el) => el.dataset.stashId);
const key = (k: string, init: KeyboardEventInit = {}) =>
  h.handle().key(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...init }));

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  h?.destroy();
  installCatalog('en');
});

describe('StashDrawer', () => {
  it('lists the stash minus what is open here, newest change first; the title counts everything', async () => {
    h = await setup({ openHere: ['/n/a.md'] });
    expect(ids()).toEqual(['d', 'b', 'c']);
    expect(h.root.querySelector('.drawer-title .cnt')?.textContent).toContain('4');
    expect(h.root.querySelector('.f-note')?.textContent).toBe('весь тайник · 3 из 4 · 1 во вкладках');
  });

  it('opens filtered by the window repo; × shows everything, + puts it back', async () => {
    h = await setup({ repo: 'shelf' });
    expect(ids()).toEqual(['d', 'a', 'b']);
    expect(h.root.querySelector('.fchip')?.textContent).toContain('shelf');
    h.root.querySelector<HTMLButtonElement>('.fchip-x')!.click();
    await settle();
    expect(ids()).toEqual(['d', 'a', 'b', 'c']);
    h.root.querySelector<HTMLButtonElement>('.f-add')!.click();
    await settle();
    expect(ids()).toEqual(['d', 'a', 'b']);
  });

  it('keys filter it: letters, Backspace, then ⌫ on an empty query drops the chip', async () => {
    h = await setup({ repo: 'shelf' });
    expect(key('b')).toBe(true);
    await settle();
    expect(h.root.querySelector('.s-q')?.textContent).toBe('b');
    expect(ids()).toEqual(['b']);
    key('Backspace');
    key('Backspace');
    await settle();
    expect(h.store.state.repoChip).toBeNull();
  });

  it('Enter opens the top result', async () => {
    h = await setup();
    key('T');
    key('i');
    await settle();
    expect(key('Enter')).toBe(true);
    expect(h.onopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'd' }));
  });

  it('a sort button re-sorts and says which is on', async () => {
    h = await setup();
    const kind = h.root.querySelector<HTMLButtonElement>('[data-ssort="kind"]')!;
    kind.click();
    await settle();
    expect(kind.getAttribute('aria-pressed')).toBe('true');
    expect(ids()).toEqual(['d', 'a', 'c', 'b']);
    // ⌘ and Ctrl together: jsdom's empty `navigator.platform` makes `isMacPlatform()` false.
    expect(key('r', { metaKey: true, ctrlKey: true })).toBe(true);
    await settle();
    expect(ids()[0]).toBe('b');
  });

  it('an entry held by another window says where', async () => {
    h = await setup({ holders: [null, null, { label: 'editor-19', number: 19 }, null] });
    expect(h.root.querySelector('[data-stash-id="c"] .open-mark')?.textContent).toBe('открыта в #19');
  });

  it('empty: says why', async () => {
    h = await setup({ openHere: ENTRIES.map((e) => e.path) });
    expect(h.root.querySelector('.empty')?.textContent).toBe('Всё с этим тегом уже открыто вкладками');
    key('z');
    key('z');
    await settle();
    expect(h.root.querySelector('.empty')?.textContent).toBe('Ничего не найдено');
  });

  it('a tag added on a card pops at once and goes up as a change', async () => {
    h = await setup();
    const card = h.root.querySelector<HTMLElement>('[data-stash-id="c"]')!;
    card.querySelector<HTMLButtonElement>('.tag-add')!.click();
    await settle();
    const input = card.querySelector<HTMLInputElement>('.tag-edit')!;
    input.value = 'Idea';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await settle();
    expect(h.onsettag).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), { add: ['idea'] });
    expect(h.store.newTags.get('c')).toEqual(['idea']);
  });

  it('a press on a card body goes to the tabs drawer; on its buttons it does not', async () => {
    h = await setup();
    const card = h.root.querySelector<HTMLElement>('[data-stash-id="c"]')!;
    const press = (el: Element) =>
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    press(card.querySelector('.tag-add')!);
    press(card.querySelector('.tag')!);
    expect(h.onpress).not.toHaveBeenCalled();
    expect(h.onfocusrequest).toHaveBeenCalledTimes(2);
    press(card.querySelector('.card-name')!);
    expect(h.onpress).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), card, expect.any(PointerEvent));
  });

  it('the rim follows the keys; compact and drop states reach the drawer', async () => {
    h = await setup({ compact: true, dropReady: true });
    const drawer = h.root.querySelector<HTMLElement>('.stash-drawer')!;
    expect(drawer.classList.contains('focused')).toBe(true);
    expect(drawer.classList.contains('drop-ready')).toBe(true);
    expect(h.root.querySelector('.stash-wrap')?.classList.contains('compact')).toBe(true);
    expect(h.root.querySelector('[data-stash-id="a"]')?.classList.contains('compact')).toBe(true);
    h.store.update((s) => ({ ...s, focus: 'tabs' }));
    await settle();
    expect(drawer.classList.contains('focused')).toBe(false);
  });

  describe('the DOM holds only what can be seen (I2)', () => {
    /** Past the slide-out: reduced motion in these tests makes it a zero-delay timer. */
    const afterSlide = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('closed, no cards are rendered at all; opened, they are', async () => {
      h = await setup({ closed: true });
      expect(ids()).toEqual([]);
      h.store.open();
      await settle();
      expect(ids()).toEqual(['d', 'a', 'b', 'c']);
      h.store.close();
      await settle();
      await afterSlide();
      await settle();
      expect(ids()).toEqual([]);
      expect(h.root.querySelector('.stash-drawer'), 'the shell stays for the slide').not.toBeNull();
    });

    it(`renders the first ${STASH_RENDER_CAP} rows and says how many more there are`, async () => {
      const many = Array.from({ length: STASH_RENDER_CAP + 50 }, (_, i) =>
        entry(`m${String(i).padStart(3, '0')}`, { modifiedAt: NOW - i * MIN })
      );
      h = await setup({ list: () => many });
      expect(ids()).toHaveLength(STASH_RENDER_CAP);
      expect(h.root.querySelector('.more')?.textContent).toBe('ещё 50');
      expect(h.root.querySelector('.f-note')?.textContent, 'the counts still cover everything').toBe(
        `весь тайник · ${STASH_RENDER_CAP + 50} из ${STASH_RENDER_CAP + 50}`
      );
      // A query narrows below the cap: no «more» row.
      key('m');
      key('0');
      key('0');
      await settle();
      expect(h.root.querySelector('.more')).toBeNull();
    });

    it('after a reopen a card on screen still pulses when it is put away again', async () => {
      let stashed = 10;
      h = await setup({ list: () => ENTRIES.map((e) => ({ ...e, stashedAt: e.id === 'c' ? stashed : null })) });
      h.store.close();
      await settle();
      await afterSlide();
      h.store.open();
      await settle();
      stashed = 20;
      h.store.changed('put-away', ['c']);
      await new Promise((resolve) => setTimeout(resolve, RELOAD_COALESCE_MS + 20));
      await settle();
      expect(h.root.querySelector('[data-stash-id="c"]')?.classList.contains('pulse')).toBe(true);
    });
  });

  it('closed: off screen, inert, and no drop target', async () => {
    h = await setup({ closed: true, dropHot: true });
    const drawer = h.root.querySelector<HTMLElement>('.stash-drawer')!;
    expect(h.root.querySelector('.stash-wrap')?.classList.contains('open')).toBe(false);
    // The property, not the attribute: jsdom does not reflect `inert`.
    expect(drawer.inert).toBe(true);
    expect(drawer.classList.contains('drop-hot')).toBe(false);
    expect(h.handle().contains(0, 0)).toBe(false);
    expect(h.handle().left()).toBeNull();
  });
});
