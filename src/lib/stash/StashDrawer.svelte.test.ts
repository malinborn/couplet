// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashDrawer, { type StashDrawerHandle } from './StashDrawer.svelte';
import { RELOAD_COALESCE_MS, createStashStore, type StashStore } from './stash-store.svelte';
import type { StashSearchArgs, StashSearchResult } from './ipc';
import { SEARCH_DEBOUNCE_MS } from './stash-search';
import { focusDrawer, setStashQuery } from './stash-state';
import { STASH_RENDER_CAP } from './stash-view';
import type { StashEntry, StashHit, TabHolder } from './types';

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
  /** `stash_search` (stage 05); absent: the local substring filter only. */
  search?: (args: StashSearchArgs) => Promise<StashSearchResult>;
}

async function setup(opts: SetupOpts = {}): Promise<H> {
  const store = createStashStore({
    list: async () => (opts.list ? opts.list() : ENTRIES),
    counts: async () => ({ total: ENTRIES.length, stashedToday: 0, deleted: 0 }),
    holders: async (paths) => opts.holders ?? paths.map(() => null),
    windowRepo: async () => opts.repo ?? null,
    search: opts.search,
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
    expect(h.root.querySelector('.empty')?.textContent).toBe('Всё из тайника уже открыто вкладками');
    key('z');
    key('z');
    await settle();
    expect(h.root.querySelector('.empty')?.textContent).toBe('Ничего не найдено');
  });

  it('empty under the repo chip speaks of the repo, not of a tag (Task 24)', async () => {
    h = await setup({ repo: 'p1' });
    expect(h.root.querySelector('.empty')?.textContent).toBe('Из репо p1 в тайнике ничего нет');
    h.destroy();
    h = await setup({ repo: 'shelf', openHere: ['/n/a.md', '/n/b.md', '/n/d.md'] });
    expect(h.root.querySelector('.empty')?.textContent).toBe('Всё из репо shelf уже открыто вкладками');
    installCatalog('en');
    h.destroy();
    h = await setup({ repo: 'p1' });
    expect(h.root.querySelector('.empty')?.textContent).toBe('Nothing from p1 in the stash');
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

  describe('search (stage 05)', () => {
    const byId = (id: string) => ENTRIES.find((e) => e.id === id)!;
    const hitOf = (e: StashEntry, snippet = '', ranges: [number, number][] = []): StashHit => ({
      entry: e,
      snippet,
      ranges,
      score: 1,
    });
    /** What the drawer asks for a query's text: a whole page, DB-only entries. */
    const argsFor = (query: string): StashSearchArgs => ({
      query,
      deleted: false,
      limit: STASH_RENDER_CAP,
      enrich: false,
    });
    /** The query's effect run, past the runner's debounce, and the answer rendered. */
    const searched = async () => {
      await settle();
      await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
      await settle();
    };
    const setQuery = async (query: string) => {
      h.store.update((s) => setStashQuery(s, query));
      await settle();
    };

    it('text: the hits in relevance order, the title marked, the snippet in place of the preview', async () => {
      // As Rust cuts it: a note's snippet comes from below its title line, and
      // a title-only hit has none.
      const withBody = { ...byId('c'), preview: 'Title c\na long title here' };
      const list = ENTRIES.map((e) => (e.id === 'c' ? withBody : e));
      const search = vi.fn(async (_args: StashSearchArgs) => ({
        hits: [hitOf(withBody, 'a long title here', [[7, 12]]), hitOf(byId('a'))],
        total: 2,
        nextCursor: null,
      }));
      h = await setup({ list: () => list, search });
      for (const k of ['i', 't', 'l', 'e']) key(k);
      await searched();
      expect(search).toHaveBeenCalledWith(argsFor('itle'));
      expect(ids()).toEqual(['c', 'a']);
      const c = h.root.querySelector<HTMLElement>('[data-stash-id="c"]')!;
      expect(c.querySelector('.card-name mark')?.textContent).toBe('itle');
      expect(c.querySelector('.card-preview .hit')?.textContent).toBe('a long title here');
      expect(c.querySelector('.card-preview .hit mark')?.textContent).toBe('title');
      // No snippet: the card keeps its own preview.
      expect(h.root.querySelector('[data-stash-id="a"] .card-preview .hit')).toBeNull();
    });

    it("a #tag filters the hits by stage 04's prefix rule; a query without text asks nothing", async () => {
      const search = vi.fn(async (_args: StashSearchArgs) => ({
        hits: [hitOf(byId('a')), hitOf(byId('c'))],
        total: 2,
        nextCursor: null,
      }));
      h = await setup({ search });
      await setQuery('#op itle');
      await searched();
      expect(search).toHaveBeenLastCalledWith(argsFor('itle'));
      expect(ids()).toEqual(['c']);
      await setQuery('#op');
      await searched();
      expect(search).toHaveBeenCalledTimes(1);
      expect(h.store.hits).toBeNull();
      expect(ids()).toEqual(['c']);
    });

    it('«ещё N» also counts the matches past the page', async () => {
      const many = Array.from({ length: STASH_RENDER_CAP + 50 }, (_, i) =>
        entry(`m${String(i).padStart(3, '0')}`, { modifiedAt: NOW - i * MIN })
      );
      const search = vi.fn(async () => ({
        hits: many.slice(0, STASH_RENDER_CAP).map((e) => hitOf(e)),
        total: STASH_RENDER_CAP + 30,
        nextCursor: String(STASH_RENDER_CAP),
      }));
      h = await setup({ list: () => many, search });
      key('m');
      await searched();
      expect(ids()).toHaveLength(STASH_RENDER_CAP);
      expect(h.root.querySelector('.more')?.textContent).toBe('ещё 30');
      expect(h.root.querySelector('.s-n')?.textContent).toContain(
        `${STASH_RENDER_CAP + 30} из ${STASH_RENDER_CAP + 50}`
      );
    });

    it('↑/↓ with an active query search nothing again (I3)', async () => {
      const search = vi.fn(async (_args: StashSearchArgs) => ({
        hits: [hitOf(byId('a')), hitOf(byId('c')), hitOf(byId('d'))],
        total: 3,
        nextCursor: null,
      }));
      h = await setup({ search });
      await setQuery('itle');
      await searched();
      expect(search).toHaveBeenCalledTimes(1);
      h.store.update((s) => focusDrawer(s, 'stash'));
      for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
        expect(key(k)).toBe(true);
        await settle();
      }
      await searched();
      expect(search).toHaveBeenCalledTimes(1);
      expect(ids()).toEqual(['a', 'c', 'd']);
    });

    it('the repo chip is one rule with and without a query: the list copy, never the stored repo (M8)', async () => {
      // A file ref whose stored repo (Rust's `entries.repo`, what SQL would
      // filter on) differs from the one the list re-derives on every load.
      const moved = entry('f', { kind: 'file', title: 'f.md', repo: 'shelf', modifiedAt: NOW - 2 * MIN });
      const stored = { ...moved, repo: 'old-name' };
      const list = [...ENTRIES, moved];
      const search = vi.fn(async (_args: StashSearchArgs) => ({
        hits: [hitOf(stored), hitOf(byId('c'))],
        total: 2,
        nextCursor: null,
      }));
      h = await setup({ repo: 'shelf', list: () => list, search });
      expect(h.store.state.repoChip).toBe('shelf');
      expect(ids()).toContain('f');
      await setQuery('f.md');
      await searched();
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][0]).not.toHaveProperty('repo');
      expect(search.mock.calls[0][0].limit).toBe(STASH_RENDER_CAP);
      // Under the chip: the file ref stays, the other repo's note goes.
      expect(ids()).toEqual(['f']);
    });

    it('a removed entry leaves at once, though the hits still name it (M9)', async () => {
      const search = vi.fn(async (_args: StashSearchArgs) => ({
        hits: [hitOf(byId('a')), hitOf(byId('c'))],
        total: 2,
        nextCursor: null,
      }));
      h = await setup({ search });
      await setQuery('itle');
      await searched();
      expect(ids()).toEqual(['a', 'c']);
      h.store.remove('c');
      await settle();
      expect(ids()).toEqual(['a']);
    });

    it('a failed search leaves the local filter working', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      h = await setup({ search: async () => Promise.reject(new Error('no IPC')) });
      key('b');
      await searched();
      expect(ids()).toEqual(['b']);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });

  it('the footer hint: the #tag segment is its own element, so squeezed drawers can drop it (Task 24)', async () => {
    h = await setup();
    const foot = h.root.querySelector<HTMLElement>('.st-foot')!;
    expect(foot.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'тяните во вкладки — открыть · #тег — фильтр · ← → — ящики'
    );
    expect(foot.querySelector('.f-tag')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('#тег — фильтр ·');
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
