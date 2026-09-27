// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import TrashBar from './TrashBar.svelte';
import { STASH_ICONS } from './icons';
import type { StashMode } from './types';

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(mode: StashMode, trashTotal = 3, stashTotal = 14) {
  const props = $state({ mode, trashTotal, stashTotal });
  const ontoggle = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(TrashBar, {
    target,
    props: {
      get mode() {
        return props.mode;
      },
      get trashTotal() {
        return props.trashTotal;
      },
      get stashTotal() {
        return props.stashTotal;
      },
      ontoggle,
    },
  });
  flushSync();
  return { bar: target.querySelector<HTMLElement>('.trash-bar')!, ontoggle, props };
}

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();
const iconPaths = (el: Element) => [...el.querySelectorAll('.stash-btn path')].map((p) => p.getAttribute('d'));

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  installCatalog('en');
});

describe('TrashBar', () => {
  it('in the stash view: the bin, «Удалённые», «· 3 · хранятся 30 дней», not pressed', () => {
    const { bar } = render('stash');
    const btn = bar.querySelector<HTMLButtonElement>('.stash-btn')!;
    expect(text(btn)).toBe('Удалённые');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Удалённые заметки — 30 дней можно вернуть');
    expect(iconPaths(bar)).toEqual([...STASH_ICONS.bin]);
    expect(text(bar.querySelector('.stash-sum'))).toBe('· 3 · хранятся 30 дней');
    expect(bar.querySelector('.stash-sum .num')?.textContent).toBe('3');
  });

  it('in the trash view: the tray, «← в тайник», «· 14 в тайнике», pressed', () => {
    const { bar } = render('trash');
    const btn = bar.querySelector<HTMLButtonElement>('.stash-btn')!;
    expect(text(btn)).toBe('← в тайник');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Назад в тайник (Esc)');
    expect(iconPaths(bar)).toEqual([...STASH_ICONS.tray]);
    expect(text(bar.querySelector('.stash-sum'))).toBe('· 14 в тайнике');
  });

  it('a click toggles once', () => {
    const { bar, ontoggle } = render('stash');
    bar.querySelector<HTMLButtonElement>('.stash-btn')!.click();
    expect(ontoggle).toHaveBeenCalledTimes(1);
  });

  it('the count jumps when a note arrives, not when the view switches', async () => {
    vi.useFakeTimers();
    try {
      const { bar, props } = render('stash');
      props.mode = 'trash';
      flushSync();
      vi.advanceTimersByTime(20);
      flushSync();
      expect(bar.querySelector('.num.bump')).toBeNull();
      props.mode = 'stash';
      flushSync();
      props.trashTotal = 4;
      flushSync();
      vi.advanceTimersByTime(20);
      flushSync();
      expect(bar.querySelector('.num')?.classList.contains('bump')).toBe(true);
      expect(bar.classList.contains('got')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
