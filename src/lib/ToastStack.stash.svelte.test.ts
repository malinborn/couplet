// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ToastStack from './ToastStack.svelte';
import { createToastStore } from './toasts.svelte';
import { installCatalog } from './i18n';

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  installCatalog('en');
});

function render(right?: number) {
  const store = createToastStore();
  const onRevealWindow = vi.fn();
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ToastStack, { target, props: { store, onRevealWindow, right } });
  return { store, onRevealWindow };
}

describe('ToastStack — stash notices', () => {
  it('renders a stash note as text and dim text', () => {
    const { store } = render();
    store.push({ kind: 'stash', note: { what: 'removed', title: 'a.md' } });
    flushSync();
    expect(target.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md убран из тайника');
    expect(target.querySelector('.md-toast-dim')?.textContent?.trim()).toBe('· файл остался на месте');
  });

  it('a pull that failed offers «Перейти» to the holder', () => {
    const { store, onRevealWindow } = render();
    store.push({ kind: 'stash', note: { what: 'pull-failed', number: 19, label: 'editor-19' } });
    flushSync();
    const go = target.querySelector<HTMLButtonElement>('.md-toast-action')!;
    expect(go.textContent?.trim()).toBe('Перейти');
    go.click();
    flushSync();
    expect(onRevealWindow).toHaveBeenCalledWith('editor-19');
    expect(target.querySelector('.md-toast')).toBeNull();
  });

  it('a notice with no dim part draws no empty dim line', () => {
    const { store } = render();
    store.push({ kind: 'stash', note: { what: 'pull-failed', number: 19, label: 'editor-19' } });
    flushSync();
    expect(target.querySelector('.md-toast-dim')).toBeNull();
  });

  it('a newer stash notice replaces the last', () => {
    const { store } = render();
    store.push({ kind: 'stash', note: { what: 'widened' } });
    store.push({ kind: 'stash', note: { what: 'removed', title: 'b.md' } });
    flushSync();
    expect(target.querySelectorAll('.md-toast')).toHaveLength(1);
  });

  it('a stash notice leaves a standing stash-error in place (separate kinds)', () => {
    const { store } = render();
    store.push({ kind: 'stash-error', message: 'locked' });
    store.push({ kind: 'stash', note: { what: 'widened' } });
    flushSync();
    expect(target.querySelectorAll('.md-toast')).toHaveLength(2);
  });

  it('moves left of the open stash drawer', () => {
    const { store } = render(416);
    store.push({ kind: 'stash', note: { what: 'widened' } });
    flushSync();
    expect(target.querySelector<HTMLElement>('.md-toast-stack')?.style.right).toBe('416px');
  });

  it('keeps the stylesheet position while the stash is closed', () => {
    const { store } = render();
    store.push({ kind: 'stash', note: { what: 'widened' } });
    flushSync();
    expect(target.querySelector<HTMLElement>('.md-toast-stack')?.style.right).toBe('');
  });
});
