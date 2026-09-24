// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import WindowCarousel, { type CarouselHandle } from './WindowCarousel.svelte';
import { carouselItems, type CarouselItem, type CarouselWindow } from './carousel';

const win = (label: string, number: number, head = '# Title\nline'): CarouselWindow => ({
  label,
  number,
  project: 'infra',
  branch: 'main',
  tabCount: 2,
  activePath: `/infra/${label}.md`,
  head,
});

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;
let handle: CarouselHandle | undefined;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

function show(
  items: CarouselItem[] | null,
  extra: Partial<{ mode: 'drag' | 'keys'; kb: number; count: number }> = {}
) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const onpick = vi.fn();
  component = mount(WindowCarousel, {
    target,
    props: {
      items,
      mode: extra.mode ?? 'drag',
      kb: extra.kb ?? 0,
      hot: null,
      got: null,
      left: 420,
      count: extra.count ?? 1,
      lead: 'plan.md',
      pointer: null,
      onpick,
      get handle() {
        return handle;
      },
      set handle(v: CarouselHandle | undefined) {
        handle = v;
      },
    },
  });
  flushSync();
  return { onpick };
}

const options = () => [...target.querySelectorAll<HTMLElement>('[role="option"]')];

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe('WindowCarousel', () => {
  it('ShowsNewWindowFirst_ThenTheWindowsInTheirOrder', () => {
    show(carouselItems([win('editor-3', 12), win('editor-2', 7)]));
    const opts = options();
    expect(opts.map((o) => o.textContent?.includes('#12') ?? false)).toEqual([false, true, false]);
    expect(opts[0].classList.contains('newwin')).toBe(true);
    expect(opts[2].querySelector('.wt-meta')?.textContent).toContain('#7');
    expect(target.querySelector('.car-head')?.textContent).toContain('plan.md');
  });

  it('WithASingleWindowOffersOnlyANewOne', () => {
    show(carouselItems([]));
    expect(options()).toHaveLength(1);
    expect(options()[0].classList.contains('newwin')).toBe(true);
  });

  it('IsAListboxWhoseActiveDescendantIsTheKeyboardsOption', () => {
    show(carouselItems([win('editor-3', 12), win('editor-2', 7)]), { mode: 'keys', kb: 2 });
    const box = target.querySelector<HTMLElement>('[role="listbox"]')!;
    const chosen = options()[2];
    expect(box.getAttribute('aria-activedescendant')).toBe(chosen.id);
    expect(chosen.getAttribute('aria-selected')).toBe('true');
    expect(options()[1].getAttribute('aria-selected')).toBe('false');
    handle!.focus();
    expect(document.activeElement).toBe(box);
  });

  it('AClickOnAThumbnailPicksIt_AndItemAtFindsTheOneUnderAPoint', () => {
    const { onpick } = show(carouselItems([win('editor-3', 12)]));
    options()[1].querySelector<HTMLElement>('.wt-page')!.click();
    expect(onpick).toHaveBeenCalledWith(1);
    const hit = options()[1].querySelector('.wt-meta')!;
    document.elementFromPoint = vi.fn(() => hit);
    expect(handle!.itemAt(10, 10)).toBe(1);
    document.elementFromPoint = vi.fn(() => document.body);
    expect(handle!.itemAt(10, 10)).toBeNull();
  });

  it('AThumbnailShowsItsTextAsText_NeverAsHtml', () => {
    show(carouselItems([win('editor-3', 12, '<img src=x onerror="alert(1)"> **bold**')]));
    expect(target.querySelector('img')).toBeNull();
    expect(options()[1].querySelector('.doc')?.textContent).toContain('<img');
  });
});
