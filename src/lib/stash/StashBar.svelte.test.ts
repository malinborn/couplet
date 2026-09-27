// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashBar from './StashBar.svelte';

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: { dropCount?: number | null; open?: boolean; hot?: boolean; got?: boolean } = {}) {
  const onclick = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StashBar, {
    target,
    props: {
      counts: { total: 19, stashedToday: 6, deleted: 3 },
      open: props.open ?? false,
      dropCount: props.dropCount ?? null,
      hot: props.hot ?? false,
      got: props.got ?? false,
      onclick,
    },
  });
  flushSync();
  return { bar: target.querySelector<HTMLElement>('.stash-bar')!, onclick };
}

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  installCatalog('en');
});

describe('StashBar', () => {
  it('idle: the button and «· 19 · отложено сегодня 6»', () => {
    const { bar } = render();
    expect(bar.querySelector('.stash-btn')?.textContent?.trim()).toBe('Тайник');
    expect(bar.querySelector('.stash-btn')?.getAttribute('aria-pressed')).toBe('false');
    expect(bar.querySelector('.stash-btn svg')).not.toBeNull();
    expect(bar.querySelector('.stash-sum')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '· 19 · отложено сегодня 6'
    );
    expect(bar.querySelector('.stash-sum .num')?.textContent).toBe('19');
    expect(bar.classList.contains('dropmode')).toBe(false);
  });

  it('while tabs are dragged: the drop zone, with the count for more than one', () => {
    const one = render({ dropCount: 1 }).bar;
    expect(one.classList.contains('dropmode')).toBe(true);
    expect(one.querySelector('.drop .dn')).toBeNull();
    unmount(component!);
    component = null;
    target.remove();
    const three = render({ dropCount: 3, hot: true }).bar;
    expect(three.querySelector('.drop')?.textContent).toContain('Отложить в тайник');
    expect(three.querySelector('.drop .dn')?.textContent).toBe(' · 3 вкладки');
    expect(three.querySelector('.drop .dk')?.textContent).toBe('⌃T');
    expect(three.classList.contains('hot')).toBe(true);
  });

  it('the button toggles the stash', () => {
    const { bar, onclick } = render({ open: true });
    expect(bar.querySelector('.stash-btn')?.getAttribute('aria-pressed')).toBe('true');
    bar.querySelector<HTMLButtonElement>('.stash-btn')!.click();
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('a landed put-away pulses the bar', () => {
    expect(render({ got: true }).bar.classList.contains('got')).toBe(true);
  });
});
